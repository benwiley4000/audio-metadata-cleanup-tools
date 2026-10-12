'use strict';
const path = require('path');
const { readEntries } = require('./scan');

// node-taglib-sharp may be ESM-only depending on version; dynamic import works either way.
let taglibPromise = null;
function loadTaglib() {
  if (!taglibPromise) taglibPromise = import('node-taglib-sharp');
  return taglibPromise;
}

function isM4a(name) {
  return path.extname(name).toLowerCase() === '.m4a';
}

// Read disc (disk atom) and track (trkn atom) numbers from one m4a.
// Missing/0 disc => null (treated as disc 1 later). Falls back to a leading
// number in the filename for the track if the tag is empty.
async function readDiscAndTrack(filePath, fileName) {
  const { File } = await loadTaglib();
  let discNum = null;
  let trackNum = null;
  let file;
  try {
    file = File.createFromPath(filePath);
    if (file.tag.disc > 0) discNum = file.tag.disc;
    if (file.tag.track > 0) trackNum = file.tag.track;
  } catch (e) {
    // unreadable tag - treated as missing
  } finally {
    if (file) file.dispose();
  }
  if (trackNum == null) {
    const m = /^\s*0*(\d+)/.exec(fileName);
    if (m) trackNum = parseInt(m[1], 10);
  }
  return { discNum, trackNum };
}

// Recursively find every folder that directly contains at least one .m4a.
// This is the cheap pre-filter: folders without m4a files are never opened for tags.
function findM4aFolders(rootPath) {
  const found = [];
  (function walk(dir) {
    const { files, dirs } = readEntries(dir);
    if (files.some(isM4a)) found.push(dir);
    for (const d of dirs) walk(path.join(dir, d));
  })(rootPath);
  return found;
}

// Returns entries if the folder has 2+ distinct disc numbers, otherwise null.
async function analyzeFolder(dirPath) {
  const { files } = readEntries(dirPath);
  const m4as = files.filter(isM4a);
  if (m4as.length === 0) return null;

  const entries = [];
  for (const f of m4as) {
    const filePath = path.join(dirPath, f);
    const { discNum, trackNum } = await readDiscAndTrack(filePath, f);
    entries.push({
      fileName: f, filePath, trackNum,
      discNum: discNum == null ? 1 : discNum,
      discTagMissing: discNum == null,
    });
  }

  const distinct = new Set(entries.map((e) => e.discNum));
  return distinct.size < 2 ? null : entries;
}

function planFolder(entries) {
  const warnings = [];
  const byDisc = new Map();
  for (const e of entries) {
    if (!byDisc.has(e.discNum)) byDisc.set(e.discNum, []);
    byDisc.get(e.discNum).push(e);
  }
  const discNumbers = [...byDisc.keys()].sort((a, b) => a - b);

  // Safety: if a disc's highest track number exceeds its own track count, the
  // folder was probably already offset. Skip entirely to avoid double-counting.
  for (const discNum of discNumbers) {
    const tracks = byDisc.get(discNum);
    const maxNum = tracks.reduce((m, t) => Math.max(m, t.trackNum || 0), 0);
    if (maxNum > tracks.length) {
      return {
        plan: [], skipped: true,
        warnings: [`Disc ${discNum} has ${tracks.length} track(s) but a track number as high as ${maxNum} - `
          + 'looks already combined/offset (or tracks are missing). Skipped; check manually.'],
      };
    }
  }

  // Duplicate track numbers within one disc would still end up duplicated after offsetting.
  for (const discNum of discNumbers) {
    const nums = byDisc.get(discNum).map((t) => t.trackNum).filter((n) => n != null);
    if (new Set(nums).size !== nums.length) {
      warnings.push(`Disc ${discNum} has duplicate track numbers within itself - those duplicates will remain.`);
    }
  }

  const missingDisc = entries.filter((e) => e.discTagMissing);
  if (missingDisc.length > 0) {
    warnings.push(`${missingDisc.length} file(s) had no disc tag and were assumed to be disc 1: `
      + missingDisc.map((m) => m.fileName).join(', '));
  }

  const total = entries.length;
  const plan = [];
  let cumulative = 0;
  for (const discNum of discNumbers) {
    const tracks = byDisc.get(discNum).slice().sort((a, b) => {
      if (a.trackNum != null && b.trackNum != null) return a.trackNum - b.trackNum;
      if (a.trackNum != null) return -1;
      if (b.trackNum != null) return 1;
      return a.fileName.localeCompare(b.fileName);
    });
    tracks.forEach((t, idx) => {
      const original = t.trackNum != null ? t.trackNum : idx + 1;
      plan.push({
        filePath: t.filePath, fileName: t.fileName, discNum,
        originalTrackNum: t.trackNum,
        newNumber: cumulative + original,
        total,
      });
    });
    cumulative += tracks.length;
  }
  return { plan, warnings, skipped: false };
}

async function applyPlan(plan, apply, log) {
  const { File } = await loadTaglib();
  for (const item of plan) {
    const desc = `disc ${item.discNum}, ${item.fileName}   track ${item.originalTrackNum ?? '?'} -> `
      + `${item.newNumber}/${item.total}`;
    if (!apply) {
      log(`  [DRY RUN] ${desc}`);
      continue;
    }
    let file;
    try {
      file = File.createFromPath(item.filePath);
      file.tag.track = item.newNumber;
      file.tag.trackCount = item.total;
      file.save();
      log(`  ${desc}`);
    } catch (e) {
      log(`  ! failed to update ${item.filePath}: ${e.message}`);
    } finally {
      if (file) file.dispose();
    }
  }
}

module.exports = { findM4aFolders, analyzeFolder, planFolder, applyPlan };
