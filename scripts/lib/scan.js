'use strict';
const fs = require('fs');
const path = require('path');

// Extensions treated as "a track"
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.wma', '.aac']);

// OS junk files - always ignored, never reported
const IGNORED_ENTRY_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

// Companion files that commonly sit next to tracks and are NOT flagged as "unexpected"
const COMPANION_FILE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.nfo', '.m3u', '.m3u8',
  '.cue', '.sfv', '.log', '.txt', '.pdf',
]);

// Folder names that are expected to contain non-audio content and are never flagged,
// even though they aren't "CDn" folders and aren't album folders either.
// Edit this list to fit your own collection's conventions.
const NON_AUDIO_FOLDER_WHITELIST = new Set([
  'covers', 'cover', 'scans', 'scan', 'artwork', 'art', 'booklet', 'booklets',
  'images', 'img', 'bonus video', 'video', 'videos', 'extras', 'extra',
  'logs', 'log', 'notes', 'lyrics', 'front', 'back', 'inlay', 'digibooklet',
  '.cue', 'cue',
]);

// Matches "CD1", "CD 1", "CD01", "CD-1", "Disc 2", "Disk_3" etc.
// Deliberately does NOT match "CD1 - Bonus" or "Disk 2 - Bonus" - those are
// ambiguous/nonstandard and get flagged for a human to look at instead of guessed at.
const CD_REGEX = /^(cd|disc|disk)\s*[-_. ]?\s*0*(\d+)\s*/i;

function isAudioFile(name) {
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function isCompanionFile(name) {
  return COMPANION_FILE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function shouldIgnoreEntry(name) {
  return IGNORED_ENTRY_NAMES.has(name.toLowerCase());
}

function parseCdNumber(name) {
  const m = CD_REGEX.exec(name.trim());
  if (!m) return null;
  return parseInt(m[2], 10);
}

function cdPrefixWord(name) {
  const m = /^(cd|disc|disk)/i.exec(name.trim());
  return m ? m[1].toLowerCase() : null;
}

function isWhitelistedNonAudioFolder(name) {
  return NON_AUDIO_FOLDER_WHITELIST.has(name.trim().toLowerCase());
}

function readEntries(dirPath) {
  const dirents = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  const dirs = [];
  for (const d of dirents) {
    if (shouldIgnoreEntry(d.name)) continue;
    if (d.isDirectory()) dirs.push(d.name);
    else if (d.isFile()) files.push(d.name);
  }
  files.sort();
  dirs.sort();
  return { files, dirs };
}

function containsAudioDirectly(dirPath) {
  const { files } = readEntries(dirPath);
  return files.some(isAudioFile);
}

module.exports = {
  AUDIO_EXTENSIONS,
  isAudioFile,
  isCompanionFile,
  shouldIgnoreEntry,
  CD_REGEX,
  parseCdNumber,
  cdPrefixWord,
  isWhitelistedNonAudioFolder,
  readEntries,
  containsAudioDirectly,
};
