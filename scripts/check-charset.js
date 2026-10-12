#!/usr/bin/env node
'use strict';
const path = require('path');
const NodeID3 = require('node-id3');
const { readEntries } = require('./lib/scan');

const root = process.argv[2];
if (!root) {
  console.error('Usage: node check-charset.js <path-to-music-library-root>');
  console.error('');
  console.error('Read-only - makes no changes. Reports every mp3 whose title, album,');
  console.error('artist, or album artist tag contains a character that does not fit in');
  console.error('the ISO-8859-1 (Latin-1) character set (i.e. any character above U+00FF -');
  console.error('curly quotes, em/en dashes, non-Latin scripts, Central/Eastern European');
  console.error('letters like ł or ő, emoji, etc). Plain accented Latin letters like é, ñ,');
  console.error('ü, ç are all within Latin-1 and will NOT be flagged.');
  process.exit(1);
}

// node-id3 field name -> human label, for the four fields we care about
const FIELDS = [
  ['title', 'title'],
  ['album', 'album'],
  ['artist', 'artist'],
  ['performerInfo', 'album artist'],
];

function findNonLatin1Chars(str) {
  const found = [];
  const seen = new Set();
  for (const ch of str) { // iterates by Unicode code point, not UTF-16 code unit
    const cp = ch.codePointAt(0);
    if (cp > 0xff && !seen.has(ch)) {
      seen.add(ch);
      found.push({ char: ch, codePoint: cp });
    }
  }
  return found;
}

function formatChar(c) {
  const hex = c.codePoint.toString(16).toUpperCase().padStart(4, '0');
  // control/invisible characters won't print usefully - show the code point only
  const printable = c.codePoint >= 0x20 ? c.char : '(non-printable)';
  return `'${printable}' (U+${hex})`;
}

let scanned = 0;
let nonMp3 = 0;
let flaggedFiles = 0;
let readErrors = 0;

function walk(dirPath) {
  const { files, dirs } = readEntries(dirPath);
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.wma', '.aac'].includes(ext)) continue;
    if (ext !== '.mp3') {
      nonMp3 += 1;
      continue;
    }
    scanned += 1;
    const filePath = path.join(dirPath, f);
    let tags;
    try {
      tags = NodeID3.read(filePath) || {};
    } catch (e) {
      readErrors += 1;
      console.log(`! could not read tags: ${filePath}: ${e.message}`);
      continue;
    }

    const problems = [];
    for (const [tagField, label] of FIELDS) {
      const value = tags[tagField];
      if (!value) continue;
      const bad = findNonLatin1Chars(String(value));
      if (bad.length > 0) {
        problems.push({ label, value, bad });
      }
    }

    if (problems.length > 0) {
      flaggedFiles += 1;
      console.log(`\n${filePath}`);
      for (const p of problems) {
        console.log(`  ${p.label}: "${p.value}"`);
        console.log(`    non-Latin-1 character(s): ${p.bad.map(formatChar).join(', ')}`);
      }
    }
  }
  for (const d of dirs) walk(path.join(dirPath, d));
}

walk(path.resolve(root));

console.log('\n=== SUMMARY ===');
console.log(`mp3 files scanned:                 ${scanned}`);
console.log(`files flagged:                     ${flaggedFiles}`);
console.log(`non-mp3 audio (tags not checked):  ${nonMp3}`);
if (readErrors) console.log(`tag read errors:                   ${readErrors}`);
console.log('\nNo changes were made - this script is read-only.');
