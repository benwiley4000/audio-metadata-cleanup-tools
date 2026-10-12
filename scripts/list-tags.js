#!/usr/bin/env node
'use strict';
const path = require('path');
const NodeID3 = require('node-id3');
const { isAudioFile, readEntries } = require('./lib/scan');

const root = process.argv[2];
const outFile = process.argv[3];

if (!root) {
  console.error('Usage: node list-tags.js <path-to-music-library-root> [output-file.txt]');
  console.error('If output-file.txt is given, the tree is written there as well as printed.');
  process.exit(1);
}

function readTag(filePath, fileName) {
  if (path.extname(fileName).toLowerCase() !== '.mp3') {
    return { nonMp3: true };
  }
  try {
    const tags = NodeID3.read(filePath) || {};
    return { trackNumber: tags.trackNumber || null, title: tags.title || null };
  } catch (e) {
    return { error: e.message };
  }
}

function formatTrackLine(indent, fileName, filePath) {
  const tag = readTag(filePath, fileName);
  let line = `${indent}${fileName}`;
  if (tag.nonMp3) {
    line += '  [non-mp3: tag not read]';
  } else if (tag.error) {
    line += `  [tag read error: ${tag.error}]`;
  } else {
    line += `  [track tag: ${tag.trackNumber || '(none)'}]`;
    if (tag.title && tag.title.trim()) {
      line += `  [title tag: "${tag.title.trim()}"]`;
    }
  }
  return line;
}

function walk(dirPath, depth, lines, isRoot) {
  if (isRoot) {
    lines.push(`${path.basename(dirPath)}/`);
  }
  const { files, dirs } = readEntries(dirPath);
  const audioFiles = files.filter(isAudioFile);
  const indent = '  '.repeat(depth + 1);

  if (audioFiles.length > 0) {
    lines[lines.length - 1] += `  (${audioFiles.length} track${audioFiles.length === 1 ? '' : 's'})`;
  }

  for (const f of audioFiles) {
    lines.push(formatTrackLine(indent, f, path.join(dirPath, f)));
  }

  for (const d of dirs) {
    lines.push(`${indent}${d}/`);
    walk(path.join(dirPath, d), depth + 1, lines, false);
  }
}

const lines = [];
walk(path.resolve(root), 0, lines, true);
const output = lines.join('\n');

console.log(output);

if (outFile) {
  require('fs').writeFileSync(outFile, output + '\n');
  console.error(`\n(also written to ${outFile})`);
}
