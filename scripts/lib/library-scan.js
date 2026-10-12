'use strict';
const path = require('path');
const {
  isAudioFile, readEntries, parseCdNumber, cdPrefixWord,
  isWhitelistedNonAudioFolder, containsAudioDirectly,
} = require('./scan');

const ERROR = 'error';
const WARNING = 'warning';
const INFO = 'info';

function issue(severity, scope, dirPath, message) {
  return { severity, scope, path: dirPath, message };
}

// Classify a single ALBUM folder: is it flat tracks, a valid multi-CD folder,
// or something that needs a human to look at it?
function classifyAlbum(albumPath) {
  const { files, dirs } = readEntries(albumPath);
  const audioFilesDirect = files.filter(isAudioFile);
  const cdDirNames = dirs.filter((d) => parseCdNumber(d) !== null);
  const otherDirNames = dirs.filter((d) => parseCdNumber(d) === null);

  const issues = [];
  let type = 'unknown';
  let cdFolders = [];

  if (cdDirNames.length > 0) {
    type = 'multi-cd';
    cdFolders = cdDirNames
      .map((name) => ({ name, number: parseCdNumber(name), path: path.join(albumPath, name) }))
      .sort((a, b) => a.number - b.number);

    // duplicate CD numbers (e.g. "CD2" and "Disc 02")
    const seenAt = new Map();
    for (const cd of cdFolders) {
      if (seenAt.has(cd.number)) {
        issues.push(issue(ERROR, 'album', albumPath,
          `Duplicate CD number ${cd.number}: "${seenAt.get(cd.number)}" and "${cd.name}"`));
      } else {
        seenAt.set(cd.number, cd.name);
      }
    }

    // gaps in 1..max sequence
    const numbers = [...new Set(cdFolders.map((c) => c.number))].sort((a, b) => a - b);
    const max = numbers[numbers.length - 1];
    for (let n = 1; n <= max; n++) {
      if (!numbers.includes(n)) {
        issues.push(issue(ERROR, 'album', albumPath, `Missing CD ${n} (folders go up to CD${max})`));
      }
    }
    if (numbers[0] !== 1) {
      issues.push(issue(WARNING, 'album', albumPath, `CD numbering does not start at 1 (starts at ${numbers[0]})`));
    }

    // mixed naming style, e.g. "CD 1" alongside "Disc 2"
    const prefixes = new Set(cdDirNames.map(cdPrefixWord));
    if (prefixes.size > 1) {
      issues.push(issue(WARNING, 'album', albumPath,
        `Inconsistent CD-folder naming style within this album: ${[...prefixes].join(', ')}`));
    }

    // each CD folder should actually contain audio
    for (const cd of cdFolders) {
      if (!containsAudioDirectly(cd.path)) {
        issues.push(issue(WARNING, 'album', albumPath, `CD folder "${cd.name}" contains no audio files directly`));
      }
    }

    if (audioFilesDirect.length > 0) {
      issues.push(issue(WARNING, 'album', albumPath,
        `Album has ${audioFilesDirect.length} track(s) directly in the album folder AND CD subfolders (mixed structure)`));
    }
  } else if (audioFilesDirect.length > 0) {
    type = 'flat';
  } else {
    type = 'empty-or-unknown';
  }

  // Non-CD subfolders: whitelisted (covers/art/etc.) are fine and silent.
  // Anything else containing audio is very likely a misnamed CD folder.
  // Anything else with no audio is just noted as unrecognized (informational).
  for (const name of otherDirNames) {
    const subPath = path.join(albumPath, name);
    if (containsAudioDirectly(subPath)) {
      issues.push(issue(ERROR, 'album', albumPath,
        `Unrecognized subfolder "${name}" contains audio files - possibly a misnamed/nonstandard CD folder`));
    } else if (!isWhitelistedNonAudioFolder(name)) {
      issues.push(issue(INFO, 'album', albumPath, `Unrecognized non-audio subfolder "${name}"`));
    }
  }

  if (type === 'empty-or-unknown') {
    issues.push(issue(WARNING, 'album', albumPath, 'No audio tracks found anywhere in this album folder'));
  }

  return { type, cdFolders, issues, audioFilesDirect };
}

// Classify an ARTIST folder: its direct children should all be album folders.
function classifyArtist(artistPath) {
  const { files, dirs } = readEntries(artistPath);
  const audioFilesDirect = files.filter(isAudioFile);
  const cdDirNames = dirs.filter((d) => parseCdNumber(d) !== null);
  const albumDirNames = dirs.filter((d) => parseCdNumber(d) === null);

  const issues = [];
  const albums = [];

  if (audioFilesDirect.length > 0) {
    issues.push(issue(ERROR, 'artist', artistPath,
      `${audioFilesDirect.length} stray audio track(s) found directly under the artist folder, alongside `
      + 'legitimate album folder(s) - move these into an album folder'));
  }
  if (cdDirNames.length > 0) {
    issues.push(issue(ERROR, 'artist', artistPath,
      `Stray CD-style folder(s) found directly under the artist folder, alongside legitimate album folder(s) - `
      + `move these into their own album folder: ${cdDirNames.join(', ')}`));
  }

  // Whitelisted companion folders (Scans, Covers, etc.) sitting directly under
  // an artist aren't albums - skip them silently, same as inside an album.
  for (const albumName of albumDirNames) {
    if (isWhitelistedNonAudioFolder(albumName)) continue;
    const albumPath = path.join(artistPath, albumName);
    const result = classifyAlbum(albumPath);
    albums.push({ name: albumName, path: albumPath, ...result });
    issues.push(...result.issues);
  }

  return { issues, albums };
}

// Scan the whole library root. Top-level entries are expected to be artist folders.
function scanLibrary(rootPath) {
  const { files, dirs } = readEntries(rootPath);
  const issues = [];
  const artists = [];

  if (files.length > 0) {
    issues.push(issue(WARNING, 'root', rootPath,
      `Unexpected file(s) directly in the library root: ${files.join(', ')}`));
  }

  for (const artistName of dirs) {
    const artistPath = path.join(rootPath, artistName);
    const { files: aFiles, dirs: aDirs } = readEntries(artistPath);
    const directAudio = aFiles.filter(isAudioFile);
    const directCd = aDirs.filter((d) => parseCdNumber(d) !== null);
    // A whitelisted companion folder (Scans, Covers, etc.) sitting alongside CD
    // folders doesn't make this a real "artist with albums" - almost every
    // real release has one of these next to its disc folders, so ignore them
    // when deciding whether this is actually a misplaced album.
    const albumCandidates = aDirs.filter((d) => parseCdNumber(d) === null && !isWhitelistedNonAudioFolder(d));

    if (albumCandidates.length === 0 && (directAudio.length > 0 || directCd.length > 0)) {
      // No album-like subfolder at all - this whole folder is functioning as an
      // ALBUM (flat tracks or CD1..CDn) sitting where an artist folder should be.
      // Could be fixed either by wrapping it in a new artist folder above it, or by
      // inserting a new album folder below it - left to a human to decide which.
      issues.push(issue(ERROR, 'root', artistPath,
        'Tracks/CD folders found directly inside this root-level folder, with no album subfolder alongside them. '
        + 'Expected layout is root/Artist/Album/(tracks or CD folders) - either wrap this folder in a new artist '
        + 'folder, or move its contents down into a new album folder inside it.'
        + ` (${directAudio.length} track(s), ${directCd.length} CD-folder(s) found directly inside)`));
      artists.push({ name: artistName, path: artistPath, issues: [], albums: [], misplacedAlbum: true });
      continue;
    }

    const result = classifyArtist(artistPath);
    artists.push({ name: artistName, path: artistPath, ...result });
    issues.push(...result.issues);
  }

  return { rootPath, issues, artists };
}

module.exports = { scanLibrary, classifyArtist, classifyAlbum, ERROR, WARNING, INFO };
