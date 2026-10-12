#!/usr/bin/env node
'use strict';

/*
 * add-gapless.js
 *
 * Writes exact gapless information (encoder delay + end padding) into MP3 files
 * by reading the true length from the matching lossless FLAC files.
 *
 * The audio frames are NOT re-encoded or modified. The ID3 tags, the audio
 * frames and anything after them (ID3v1 etc.) stay byte-for-byte identical.
 * The only change is one small Xing/Info + LAME header frame placed in front of
 * the first audio frame (an existing Xing/Info header frame is replaced).
 *
 * How the numbers are derived:
 *   true length N   = total samples from the FLAC STREAMINFO block
 *   decoded length  = audioFrames * samplesPerFrame
 *   delay           = 576 (standard LAME encoder delay; kept from an existing
 *                     header if that already holds a non-zero value)
 *   padding         = audioFrames * samplesPerFrame - delay - N
 *
 * Folder layouts (the script works out which one you gave it):
 *
 *   A) A working folder of albums - each album has an "mp3" and a "flac" folder:
 *
 *        working/
 *          Album One/  mp3/  flac/
 *          Album Two/  mp3/  flac/
 *
 *        node add-gapless.js working
 *
 *      (Album folders can also be nested, e.g. working/Artist/Album/{mp3,flac}.
 *       Folder names "mp3"/"flac" are matched case-insensitively. Disc
 *       subfolders inside mp3/flac, e.g. mp3/CD1, are fine.)
 *
 *   B) A single album folder that directly contains "mp3" and "flac":
 *
 *        node add-gapless.js "Album One"
 *
 *   C) Two explicit folders:
 *
 *        node add-gapless.js path/to/mp3 path/to/flac
 *
 *   With no folder argument it uses the current directory (layout A or B).
 *
 * Options:
 *   --dry-run, -n   show what would change, write nothing
 *   --backup        keep a .bak copy of every MP3 it modifies
 *   --delay N       encoder delay to assume when a file has none (default 576)
 *
 * Within an album, each MP3 is paired with the FLAC that has the same relative
 * path and name (ignoring case/punctuation), or failing that a unique FLAC with
 * the same file name. Pairs that don't fit (different length, sample rate, no
 * match) are reported and left untouched.
 *
 * No npm packages required.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

// CRC-16 (poly 0x8005 reflected, init 0) as used by LAME for its tag CRCs.
const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0xA001 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc16(buf, start, end) {
  let crc = 0;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return crc & 0xFFFF;
}

function syncsafe(buf, pos) {
  return (buf[pos] << 21) | (buf[pos + 1] << 14) | (buf[pos + 2] << 7) | buf[pos + 3];
}

// Offset of the first byte after any leading ID3v2 tag(s).
function id3v2End(buf) {
  let pos = 0;
  while (pos + 10 <= buf.length && buf.toString('latin1', pos, pos + 3) === 'ID3') {
    const flags = buf[pos + 5];
    pos += 10 + syncsafe(buf, pos + 6) + ((flags & 0x10) ? 10 : 0);
  }
  return pos;
}

// ---------------------------------------------------------------------------
// FLAC: read STREAMINFO
// ---------------------------------------------------------------------------

function readFlacStreamInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    let offset = 0;
    const probe = Buffer.alloc(10);
    fs.readSync(fd, probe, 0, 10, 0);
    if (probe.toString('latin1', 0, 3) === 'ID3') {
      offset = 10 + syncsafe(probe, 6) + ((probe[5] & 0x10) ? 10 : 0);
    }
    const b = Buffer.alloc(4 + 4 + 34);
    const n = fs.readSync(fd, b, 0, b.length, offset);
    if (n < b.length || b.toString('latin1', 0, 4) !== 'fLaC') throw new Error('not a FLAC file');
    if ((b[4] & 0x7F) !== 0) throw new Error('first FLAC metadata block is not STREAMINFO');
    const s = b.subarray(8);
    const sampleRate = (s[10] << 12) | (s[11] << 4) | (s[12] >> 4);
    const channels = ((s[12] >> 1) & 7) + 1;
    const bitsPerSample = (((s[12] & 1) << 4) | (s[13] >> 4)) + 1;
    const totalSamples = (s[13] & 0x0F) * 4294967296 + s.readUInt32BE(14);
    if (!totalSamples) throw new Error('FLAC does not record its total sample count');
    return { sampleRate, channels, bitsPerSample, totalSamples };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// MP3: frame parsing
// ---------------------------------------------------------------------------

const BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],  // MPEG-1 L3
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],      // MPEG-2/2.5 L3
};
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function parseHeader(buf, pos) {
  if (pos + 4 > buf.length) return null;
  if (buf[pos] !== 0xFF || (buf[pos + 1] & 0xE0) !== 0xE0) return null;
  const verBits = (buf[pos + 1] >> 3) & 3;
  const layerBits = (buf[pos + 1] >> 1) & 3;
  if (verBits === 1 || layerBits !== 1) return null;               // reserved version / not Layer III
  const bitrateIdx = buf[pos + 2] >> 4;
  const srIdx = (buf[pos + 2] >> 2) & 3;
  const padding = (buf[pos + 2] >> 1) & 1;
  if (bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return null;
  const mpeg1 = verBits === 3;
  const bitrate = BITRATES[mpeg1 ? 1 : 2][bitrateIdx];
  const sampleRate = SAMPLE_RATES[verBits][srIdx];
  const channelMode = buf[pos + 3] >> 6;
  const mono = channelMode === 3;
  return {
    offset: pos,
    mpeg1,
    bitrate,
    bitrateIdx,
    sampleRate,
    channelMode,
    mono,
    samplesPerFrame: mpeg1 ? 1152 : 576,
    sideInfo: mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17),
    crcProtected: (buf[pos + 1] & 1) === 0,
    size: Math.floor((mpeg1 ? 144000 : 72000) * bitrate / sampleRate) + padding,
  };
}

function findFirstFrame(buf, from) {
  const limit = Math.min(buf.length - 4, from + 65536);
  for (let p = from; p <= limit; p++) {
    const h = parseHeader(buf, p);
    if (!h) continue;
    const next = p + h.size;
    if (next === buf.length) return p;
    const h2 = parseHeader(buf, next);
    if (h2 && h2.sampleRate === h.sampleRate && h2.mpeg1 === h.mpeg1) return p;
  }
  return -1;
}

// Existing Xing/Info (or VBRI) header inside the first frame, if any.
function parseInfoFrame(buf, f) {
  const x = f.offset + 4 + (f.crcProtected ? 2 : 0) + f.sideInfo;
  const end = f.offset + f.size;
  if (x + 8 > end) return null;
  const id = buf.toString('latin1', x, x + 4);
  if (id !== 'Xing' && id !== 'Info') {
    if (f.offset + 40 <= end && buf.toString('latin1', f.offset + 36, f.offset + 40) === 'VBRI') return { kind: 'VBRI' };
    return null;
  }
  const flags = buf.readUInt32BE(x + 4);
  const info = { kind: id, flags, lame: null };
  let p = x + 8;
  if (flags & 1) { info.frames = buf.readUInt32BE(p); p += 4; }
  if (flags & 2) { info.bytes = buf.readUInt32BE(p); p += 4; }
  if (flags & 4) p += 100;
  if (flags & 8) p += 4;
  if (p + 36 <= end) {
    const enc = buf.toString('latin1', p, p + 9);
    if (/^(LAME|Lavf|Lavc)/.test(enc)) {
      const lame = Buffer.from(buf.subarray(p, p + 36));
      info.lame = lame;
      info.delay = (lame[21] << 4) | (lame[22] >> 4);
      info.padding = ((lame[22] & 0x0F) << 8) | lame[23];
    }
  }
  return info;
}

function analyzeMp3(buf) {
  const start = findFirstFrame(buf, id3v2End(buf));
  if (start < 0) throw new Error('no MPEG audio frames found (is this a Layer III MP3?)');

  const frames = [];
  let pos = start;
  while (pos < buf.length) {
    const h = parseHeader(buf, pos);
    if (!h || pos + h.size > buf.length) break;
    frames.push(h);
    pos += h.size;
  }
  const audioEnd = pos;

  const first = frames[0];
  for (const f of frames) {
    if (f.sampleRate !== first.sampleRate || f.mpeg1 !== first.mpeg1 || f.mono !== first.mono) {
      throw new Error('stream changes sample rate / MPEG version / mono-stereo part-way through');
    }
  }

  const info = parseInfoFrame(buf, first);
  const audio = info ? frames.slice(1) : frames;
  if (!audio.length) throw new Error('file contains no audio frames after the header');

  return { frames, audio, info, headerFrame: info ? first : null, audioEnd, start };
}

// ---------------------------------------------------------------------------
// Build the Xing/Info + LAME header frame
// ---------------------------------------------------------------------------

function buildHeaderFrame(buf, an, totalSamples, defaultDelay) {
  const a0 = an.audio[0];
  const F = an.audio.length;
  const spf = a0.samplesPerFrame;
  const old = an.info && an.info.lame;

  let delay = defaultDelay;
  if (old && an.info.delay > 0) delay = an.info.delay;
  const padding = F * spf - delay - totalSamples;
  if (padding < 0) {
    throw new Error(`MP3 is shorter than the FLAC (${F * spf - delay} decodable samples vs ${totalSamples}); wrong match?`);
  }
  if (padding > 4095) {
    throw new Error(`MP3 is ${padding} samples longer than the FLAC (max storable padding is 4095); wrong match?`);
  }

  // Frame size / bitrate for the header frame
  const tableIdx = a0.mpeg1 ? 1 : 2;
  const sizeFor = (idx) => Math.floor((a0.mpeg1 ? 144000 : 72000) * BITRATES[tableIdx][idx] / a0.sampleRate);
  const needed = 4 + a0.sideInfo + 120 + 36;
  const cbr = an.audio.every((f) => f.bitrateIdx === a0.bitrateIdx);
  let idx = cbr ? a0.bitrateIdx : 1;
  while (sizeFor(idx) < needed) idx++;
  const infoSize = sizeFor(idx);

  const audioBytes = an.audioEnd - a0.offset;
  const totalBytes = infoSize + audioBytes; // Xing "bytes" field includes the header frame

  const frame = Buffer.alloc(infoSize);
  frame[0] = buf[a0.offset];
  frame[1] = buf[a0.offset + 1] | 1;                           // no CRC
  frame[2] = (idx << 4) | (buf[a0.offset + 2] & 0x0D);          // bitrate, keep sample rate + private bit, padding 0
  frame[3] = buf[a0.offset + 3];

  const x = 4 + a0.sideInfo;
  const kind = an.info && (an.info.kind === 'Xing' || an.info.kind === 'Info') ? an.info.kind : (cbr ? 'Info' : 'Xing');
  frame.write(kind, x, 'latin1');
  frame.writeUInt32BE(0x0F, x + 4);                             // frames + bytes + TOC + quality
  frame.writeUInt32BE(F, x + 8);
  frame.writeUInt32BE(totalBytes, x + 12);

  const tocStart = x + 16;
  for (let i = 1; i < 100; i++) {
    const k = Math.min(F - 1, Math.floor((i / 100) * F));
    const pos = infoSize + (an.audio[k].offset - a0.offset);
    frame[tocStart + i] = Math.min(255, Math.floor((256 * pos) / totalBytes));
  }
  // quality field (x + 116) left as 0

  // LAME tag (36 bytes)
  const lameOff = x + 120;
  let lame;
  if (old) {
    lame = Buffer.from(old);
  } else {
    lame = Buffer.alloc(36);
    const firstFrameBytes = buf.toString('latin1', a0.offset, Math.min(a0.offset + a0.size, buf.length));
    const m = firstFrameBytes.match(/LAME\d+\.\d+/);
    // Players only honour delay/padding when this string starts with "LAME"
    lame.write(m ? m[0] : 'LAME3.100', 0, 9, 'latin1');
    lame[9] = cbr ? 1 : 4;                                      // revision 0, method: 1 = CBR, 4 = VBR
    lame[20] = Math.min(255, cbr ? a0.bitrate : Math.min(...an.audio.map((f) => f.bitrate)));
  }
  lame[21] = delay >> 4;
  lame[22] = ((delay & 0x0F) << 4) | (padding >> 8);
  lame[23] = padding & 0xFF;
  lame.writeUInt32BE(totalBytes, 28);                           // music length
  lame.writeUInt16BE(crc16(buf, a0.offset, an.audioEnd), 32);   // music CRC (audio frames only)
  lame.copy(frame, lameOff);
  frame.writeUInt16BE(crc16(frame, 0, lameOff + 34), lameOff + 34); // tag CRC

  return { frame, delay, padding, kind, cbr };
}

function insertHeader(buf, an, frame) {
  const cutStart = an.headerFrame ? an.headerFrame.offset : an.audio[0].offset;
  const cutEnd = an.audio[0].offset;
  return Buffer.concat([buf.subarray(0, cutStart), frame, buf.subarray(cutEnd)]);
}

// Re-read the finished file and check it against the FLAC.
function verify(newBuf, totalSamples) {
  const an = analyzeMp3(newBuf);
  const info = an.info;
  if (!info || !info.lame) return 'header not readable after writing';
  const spf = an.audio[0].samplesPerFrame;
  if (info.frames !== an.audio.length) return 'frame count field mismatch';
  const decoded = an.audio.length * spf - info.delay - info.padding;
  if (decoded !== totalSamples) return `gapless length ${decoded} != FLAC ${totalSamples}`;
  if (info.bytes !== an.audioEnd - an.headerFrame.offset) return 'byte count field mismatch';
  return null;
}

// ---------------------------------------------------------------------------
// File discovery + matching
// ---------------------------------------------------------------------------

function walk(dir, ext) {
  const out = [];
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;                       // hidden files, macOS ._ files
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith(ext)) out.push(p);
    }
  })(dir);
  return out.sort();
}

const norm = (s) => s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
const relStem = (root, file) => path.relative(root, file).replace(/\.[^.]+$/, '');

function buildFlacIndex(flacDir) {
  const byRel = new Map();
  const byBase = new Map();
  for (const f of walk(flacDir, '.flac')) {
    const rel = relStem(flacDir, f);
    byRel.set(rel.split(path.sep).map(norm).join('/'), f);
    const b = norm(path.basename(rel));
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(f);
  }
  return { byRel, byBase };
}

function matchFlac(index, mp3Dir, mp3File) {
  const rel = relStem(mp3Dir, mp3File);
  const exact = index.byRel.get(rel.split(path.sep).map(norm).join('/'));
  if (exact) return { file: exact };
  const cands = index.byBase.get(norm(path.basename(rel))) || [];
  if (cands.length === 1) return { file: cands[0] };
  if (cands.length > 1) return { error: `ambiguous: ${cands.length} FLACs share this name` };
  return { error: 'no matching FLAC found' };
}

// ---------------------------------------------------------------------------
// Processing one mp3 / flac folder pair
// ---------------------------------------------------------------------------

function processPair(mp3Dir, flacDir, opts) {
  const index = buildFlacIndex(flacDir);
  const mp3s = walk(mp3Dir, '.mp3');
  const stats = { files: mp3s.length, updated: 0, unchanged: 0, skipped: 0, failed: 0 };

  for (const mp3 of mp3s) {
    const label = path.relative(mp3Dir, mp3);
    try {
      const m = matchFlac(index, mp3Dir, mp3);
      if (m.error) { console.log(`  SKIP    ${label}: ${m.error}`); stats.skipped++; continue; }

      const flac = readFlacStreamInfo(m.file);
      const buf = fs.readFileSync(mp3);
      const an = analyzeMp3(buf);
      const a0 = an.audio[0];

      if (flac.sampleRate !== a0.sampleRate) {
        console.log(`  SKIP    ${label}: sample rate differs (FLAC ${flac.sampleRate} Hz, MP3 ${a0.sampleRate} Hz)`);
        stats.skipped++; continue;
      }
      if (flac.channels !== (a0.mono ? 1 : 2)) {
        console.log(`  SKIP    ${label}: channel count differs (FLAC ${flac.channels}, MP3 ${a0.mono ? 1 : 2})`);
        stats.skipped++; continue;
      }

      const built = buildHeaderFrame(buf, an, flac.totalSamples, opts.delay);
      const newBuf = insertHeader(buf, an, built.frame);
      const problem = verify(newBuf, flac.totalSamples);
      if (problem) throw new Error(`self-check failed: ${problem}`);

      const detail = `delay ${built.delay}, padding ${built.padding}  (${an.audio.length} frames, ${flac.totalSamples} samples, ${built.cbr ? 'CBR' : 'VBR'})`;
      if (newBuf.equals(buf)) { console.log(`  OK      ${label}: already correct - ${detail}`); stats.unchanged++; continue; }

      if (!opts.dryRun) {
        const st = fs.statSync(mp3);
        if (opts.backup) fs.copyFileSync(mp3, mp3 + '.bak');
        const tmp = mp3 + '.gapless-tmp';
        fs.writeFileSync(tmp, newBuf);
        fs.renameSync(tmp, mp3);
        fs.utimesSync(mp3, st.atime, st.mtime);
      }
      const was = an.info
        ? (an.info.lame ? `replaced header (was delay ${an.info.delay}, padding ${an.info.padding})` : 'replaced header without gapless data')
        : 'added header';
      console.log(`  ${opts.dryRun ? 'WOULD  ' : 'UPDATED'} ${label}: ${was} -> ${detail}`);
      stats.updated++;
    } catch (err) {
      console.log(`  FAIL    ${label}: ${err.message}`);
      stats.failed++;
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Finding albums
// ---------------------------------------------------------------------------

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };

function subdirNamed(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.toLowerCase() === name) return path.join(dir, e.name);
  }
  return null;
}

// An "album" is any folder that has both an mp3 and a flac subfolder.
function findAlbums(root) {
  const albums = [];
  const incomplete = [];
  (function rec(d) {
    const mp3 = subdirNamed(d, 'mp3');
    const flac = subdirNamed(d, 'flac');
    if (mp3 && flac) { albums.push({ dir: d, mp3, flac }); return; }
    if (mp3 || flac) incomplete.push({ dir: d, missing: mp3 ? 'flac' : 'mp3' });
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const n = e.name.toLowerCase();
      if (n === 'mp3' || n === 'flac') continue;
      rec(path.join(d, e.name));
    }
  })(root);
  albums.sort((a, b) => a.dir.localeCompare(b.dir));
  return { albums, incomplete };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, backup: false, delay: 576 };
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a === '--backup') opts.backup = true;
    else if (a === '--delay') opts.delay = parseInt(args[++i], 10);
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, '')); return 0; }
    else if (a.startsWith('-')) { console.error(`Unknown option ${a}`); return 2; }
    else pos.push(a);
  }
  if (pos.length > 2) { console.error('Too many folders given. Use --help for the supported layouts.'); return 2; }
  if (!Number.isInteger(opts.delay) || opts.delay < 0 || opts.delay > 4095) { console.error('--delay must be 0-4095'); return 2; }

  let albums;
  let incomplete = [];
  let root = null;

  if (pos.length === 2) {
    // Layout C: explicit mp3 folder + flac folder
    for (const d of pos) if (!isDir(d)) { console.error(`Not a directory: ${d}`); return 2; }
    albums = [{ dir: null, mp3: pos[0], flac: pos[1], name: pos[0] }];
  } else {
    // Layouts A / B: a working folder of albums, or one album folder
    root = pos[0] || '.';
    if (!isDir(root)) { console.error(`Not a directory: ${root}`); return 2; }
    ({ albums, incomplete } = findAlbums(root));
    for (const a of albums) a.name = path.relative(root, a.dir) || path.basename(path.resolve(a.dir));
    if (!albums.length) {
      console.error(`No album folders found under "${root}".`);
      console.error('Each album folder needs BOTH an "mp3" folder and a "flac" folder inside it.');
      for (const inc of incomplete) console.error(`  ${inc.dir} has no "${inc.missing}" folder`);
      return 2;
    }
  }

  console.log(`${albums.length} album(s) found${root ? ` under ${root}` : ''}${opts.dryRun ? '   [DRY RUN - nothing will be written]' : ''}`);

  const total = { files: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  const attention = [];
  for (const album of albums) {
    console.log(`\n== ${album.name}`);
    let s;
    try {
      s = processPair(album.mp3, album.flac, opts);
    } catch (err) {
      console.log(`  FAIL    ${err.message}`);
      s = { files: 0, updated: 0, unchanged: 0, skipped: 0, failed: 1 };
    }
    if (!s.files && !s.failed) console.log('  (no .mp3 files in the mp3 folder)');
    else console.log(`  -> ${s.updated} ${opts.dryRun ? 'to update' : 'updated'}, ${s.unchanged} already correct, ${s.skipped} skipped, ${s.failed} failed`);
    for (const k of Object.keys(total)) total[k] += s[k];
    if (s.skipped || s.failed) attention.push(`${album.name} (${s.skipped} skipped, ${s.failed} failed)`);
  }

  console.log(`\nDone: ${albums.length} album(s), ${total.files} MP3 file(s): ${total.updated} ${opts.dryRun ? 'would be updated' : 'updated'}, ${total.unchanged} already correct, ${total.skipped} skipped, ${total.failed} failed.`);
  if (incomplete.length) {
    console.log('\nFolders ignored (they need both an "mp3" and a "flac" folder):');
    for (const inc of incomplete) console.log(`  ${inc.dir}  - missing "${inc.missing}"`);
  }
  if (attention.length) {
    console.log('\nAlbums needing attention:');
    for (const a of attention) console.log(`  ${a}`);
  }
  return total.failed ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { analyzeMp3, buildHeaderFrame, insertHeader, readFlacStreamInfo, crc16, parseHeader, findAlbums };
