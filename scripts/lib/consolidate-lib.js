'use strict';
const fs = require('fs');
const path = require('path');
const NodeID3 = require('node-id3');
const { isAudioFile, readEntries } = require('./scan');

// Try to determine a track's ORIGINAL position within its own disc:
// 1) a leading number in the filename ("03. Song.mp3" -> 3)
// 2) the mp3's existing ID3 track-number tag, if present and parseable
// 3) null (caller falls back to sorted position within the folder)
//
// Filename is checked FIRST and preferred: ripping software numbers files
// relative to their own physical disc almost universally, so it reliably
// reflects "position on this CD". An existing ID3 tag can't be trusted for
// that - some well-tagged rips already carry a *global* track number across
// the whole multi-disc release (e.g. disc 2 track 1 tagged "14/26"), and
// treating that as a per-disc number would double-count the disc offset.
function getOriginalTrackNumber(filePath, fileName) {
  const m = /^\s*0*(\d+)/.exec(fileName);
  if (m) return parseInt(m[1], 10);

  if (path.extname(fileName).toLowerCase() === '.mp3') {
    try {
      const tags = NodeID3.read(filePath);
      if (tags && tags.trackNumber) {
        const tm = /^\s*0*(\d+)/.exec(String(tags.trackNumber));
        if (tm) return parseInt(tm[1], 10);
      }
    } catch (e) {
      // unreadable tag - fall through
    }
  }
  return null;
}

// Get this CD folder's audio files, in best-guess original playback order.
function getCdTrackFiles(cdPath) {
  const { files } = readEntries(cdPath);
  const audioFiles = files.filter(isAudioFile);
  const withNumbers = audioFiles.map((f) => {
    const filePath = path.join(cdPath, f);
    return { fileName: f, filePath, originalNumber: getOriginalTrackNumber(filePath, f) };
  });
  withNumbers.sort((a, b) => {
    if (a.originalNumber != null && b.originalNumber != null) return a.originalNumber - b.originalNumber;
    if (a.originalNumber != null) return -1;
    if (b.originalNumber != null) return 1;
    return a.fileName.localeCompare(b.fileName);
  });
  withNumbers.forEach((item, idx) => {
    if (item.originalNumber == null) item.originalNumber = idx + 1;
  });
  return withNumbers;
}

// Build the full move+tag plan for one multi-CD album.
// Filenames are NEVER changed. CD1 keeps its original tag numbers (offset 0);
// CD2..CDn get the running total of all prior discs' track counts added to
// their own original number, written into the ID3 tag only.
function planAlbum(album) {
  const perCd = album.cdFolders.map((cd) => ({ cd, tracks: getCdTrackFiles(cd.path) }));
  const total = perCd.reduce((sum, c) => sum + c.tracks.length, 0);

  const warnings = [];
  for (const { cd, tracks } of perCd) {
    const maxOriginal = tracks.reduce((m, t) => Math.max(m, t.originalNumber), 0);
    if (maxOriginal > tracks.length) {
      warnings.push(`CD${cd.number} has ${tracks.length} track(s) but a derived original track number as `
        + `high as ${maxOriginal} - this usually means neither the filename nor the existing tag reliably `
        + `reflects this track's position on its own disc. Double-check this disc's results against a `
        + 'published tracklist before trusting the new numbers.');
    }
  }

  const plan = [];
  let cumulative = 0;
  for (const { cd, tracks } of perCd) {
    for (const t of tracks) {
      const newNumber = cumulative + t.originalNumber;
      plan.push({
        src: t.filePath,
        dest: path.join(album.path, t.fileName), // same filename, just moved up
        fileName: t.fileName,
        cdNumber: cd.number,
        cdPath: cd.path,
        newNumber,
        total,
      });
    }
    cumulative += tracks.length;
  }
  return { plan, total, warnings };
}

function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw e;
    }
  }
}

// Execute (or dry-run) the plan for one album. Returns { ok, moved }.
// Since filenames are never changed, two tracks (from different discs, or a
// stray flat track already sitting in the album folder) can end up wanting
// the same destination path - that's treated as a collision and the whole
// album is aborted untouched rather than risking an overwrite.
function executeAlbum(album, plan, apply, log) {
  const destSeen = new Map();
  let collision = false;

  for (const item of plan) {
    if (destSeen.has(item.dest)) {
      log(`  ! ABORTED - filename collision, would overwrite: "${item.fileName}" exists in both `
        + `CD${destSeen.get(item.dest)} and CD${item.cdNumber}. Rename one of them manually and re-run.`);
      collision = true;
    } else {
      destSeen.set(item.dest, item.cdNumber);
    }
  }

  // Also guard against clobbering a file that's already sitting directly in
  // the album folder (e.g. a stray flat track alongside the CD subfolders).
  const { files: existingAlbumFiles } = readEntries(album.path);
  for (const name of existingAlbumFiles) {
    const existingPath = path.join(album.path, name);
    if (destSeen.has(existingPath)) {
      log(`  ! ABORTED - "${name}" already exists directly in the album folder and would be `
        + 'overwritten by a same-named track from a CD subfolder. Rename or move it manually and re-run.');
      collision = true;
    }
  }

  if (collision) return { ok: false, moved: 0 };

  if (!apply) {
    for (const item of plan) {
      log(`  [DRY RUN] CD${item.cdNumber}/${item.fileName}  ->  album folder   `
        + `(tag: track ${item.newNumber}/${item.total})`);
    }
    return { ok: true, moved: plan.length };
  }

  for (const item of plan) {
    if (path.extname(item.fileName).toLowerCase() === '.mp3') {
      try {
        // Zero-pad the numerator so naive string-sorting players (some Android
        // music apps sort the raw tag text, not its numeric value - "10" would
        // otherwise sort before "2") display tracks in the right order too.
        const width = Math.max(2, String(item.total).length);
        const padded = String(item.newNumber).padStart(width, '0');
        NodeID3.update({ trackNumber: `${padded}/${item.total}` }, item.src);
      } catch (e) {
        log(`    ! failed to update ID3 tag for ${item.src}: ${e.message}`);
      }
    } else {
      log(`    ! ${item.fileName} is not an mp3 - moved as-is, but no tag was written`);
    }
    moveFile(item.src, item.dest);
    log(`  moved CD${item.cdNumber}/${item.fileName}  ->  album folder  (tag: track ${item.newNumber}/${item.total})`);
  }

  // Clean up now-empty CD folders.
  const cdPaths = [...new Set(plan.map((p) => p.cdPath))];
  for (const cdPath of cdPaths) {
    const remaining = fs.readdirSync(cdPath);
    if (remaining.length === 0) {
      fs.rmdirSync(cdPath);
    } else {
      log(`  ! left "${cdPath}" in place - it still contains non-track file(s): ${remaining.join(', ')}`);
    }
  }

  return { ok: true, moved: plan.length };
}

module.exports = { planAlbum, executeAlbum, getOriginalTrackNumber };
