'use strict';
const path = require('path');
const NodeID3 = require('node-id3');
const { isAudioFile, readEntries } = require('./scan');

// Parse a leading "N" or "N/M" style tag value -> {num, denom|null}, or null.
function parseLeading(tagStr) {
  if (tagStr === undefined || tagStr === null || tagStr === '') return null;
  const m = /^\s*0*(\d+)\s*(?:\/\s*0*(\d+))?/.exec(String(tagStr));
  if (!m) return null;
  return { num: parseInt(m[1], 10), denom: m[2] ? parseInt(m[2], 10) : null };
}

// Read this mp3's disc number (TPOS) and track number (TRCK). Falls back to a
// leading number in the filename for the track if the tag is missing/unreadable.
function readDiscAndTrack(filePath, fileName) {
  let discNum = null;
  let trackNum = null;
  try {
    const tags = NodeID3.read(filePath) || {};
    const disc = parseLeading(tags.partOfSet);
    if (disc) discNum = disc.num;
    const track = parseLeading(tags.trackNumber);
    if (track) trackNum = track.num;
  } catch (e) {
    // unreadable tag - fall through, treated as missing
  }
  if (trackNum == null) {
    const m = /^\s*0*(\d+)/.exec(fileName);
    if (m) trackNum = parseInt(m[1], 10);
  }
  return { discNum, trackNum };
}

// Scan one folder's direct mp3 children and group them by disc number.
// Files with no disc tag at all are assumed to be disc 1.
// Returns null if fewer than 2 distinct disc numbers are present (nothing to do).
function analyzeFolder(dirPath) {
  const { files } = readEntries(dirPath);
  const mp3s = files.filter((f) => path.extname(f).toLowerCase() === '.mp3');
  if (mp3s.length === 0) return null;

  const entries = mp3s.map((f) => {
    const filePath = path.join(dirPath, f);
    const { discNum, trackNum } = readDiscAndTrack(filePath, f);
    return { fileName: f, filePath, discNum: discNum == null ? 1 : discNum, discTagMissing: discNum == null, trackNum };
  });

  const distinctDiscs = new Set(entries.map((e) => e.discNum));
  if (distinctDiscs.size < 2) return null;

  return entries;
}

// Build the retagging plan for one folder's entries. Returns
// { plan, warnings, skippedAlreadyOffset } - plan is empty if skipped.
function planFolder(entries) {
  const warnings = [];
  const byDisc = new Map();
  for (const e of entries) {
    if (!byDisc.has(e.discNum)) byDisc.set(e.discNum, []);
    byDisc.get(e.discNum).push(e);
  }
  const discNumbers = [...byDisc.keys()].sort((a, b) => a - b);

  // Safety check: a disc whose own track numbers already look "global" (an
  // original number higher than that disc's own track count) most likely
  // means this folder has already been fixed - offsetting again would
  // double-count it, exactly like the earlier CD-folder bug. Bail out
  // entirely rather than risk corrupting already-correct numbers.
  for (const discNum of discNumbers) {
    const tracks = byDisc.get(discNum);
    const withNum = tracks.filter((t) => t.trackNum != null);
    const maxNum = withNum.reduce((m, t) => Math.max(m, t.trackNum), 0);
    if (maxNum > tracks.length) {
      return {
        plan: [],
        warnings: [`Disc ${discNum} has ${tracks.length} track(s) but an existing track number as high as `
          + `${maxNum} - this looks like it may already be combined/offset rather than freshly per-disc `
          + 'numbered. Skipping this folder to avoid double-offsetting; check it manually.'],
        skipped: true,
      };
    }
  }

  for (const discNum of discNumbers) {
    const missing = byDisc.get(discNum).filter((e) => e.discTagMissing);
    if (missing.length > 0 && discNumbers.length > 1) {
      warnings.push(`${missing.length} file(s) had no disc-number tag at all and were assumed to be disc 1: `
        + missing.map((m) => m.fileName).join(', '));
    }
  }

  const total = entries.length;
  const width = Math.max(2, String(total).length);
  const plan = [];
  let cumulative = 0;

  for (const discNum of discNumbers) {
    const tracks = byDisc.get(discNum).slice();
    tracks.sort((a, b) => {
      if (a.trackNum != null && b.trackNum != null) return a.trackNum - b.trackNum;
      if (a.trackNum != null) return -1;
      if (b.trackNum != null) return 1;
      return a.fileName.localeCompare(b.fileName);
    });
    tracks.forEach((t, idx) => {
      const original = t.trackNum != null ? t.trackNum : idx + 1;
      const newNumber = cumulative + original;
      const padded = String(newNumber).padStart(width, '0');
      plan.push({
        filePath: t.filePath,
        fileName: t.fileName,
        discNum,
        originalTrackNum: t.trackNum,
        newNumber,
        newTag: `${padded}/${total}`,
      });
    });
    cumulative += tracks.length;
  }

  return { plan, warnings, skipped: false };
}

function applyPlan(plan, apply, log) {
  for (const item of plan) {
    if (!apply) {
      log(`  [DRY RUN] disc ${item.discNum}, ${item.fileName}   track ${item.originalTrackNum ?? '?'} -> `
        + `${item.newTag}`);
      continue;
    }
    try {
      NodeID3.update({ trackNumber: item.newTag }, item.filePath);
      log(`  disc ${item.discNum}, ${item.fileName}   track ${item.originalTrackNum ?? '?'} -> ${item.newTag}`);
    } catch (e) {
      log(`  ! failed to update ${item.filePath}: ${e.message}`);
    }
  }
}

module.exports = { analyzeFolder, planFolder, applyPlan };
