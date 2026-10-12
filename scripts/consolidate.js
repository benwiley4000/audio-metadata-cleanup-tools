#!/usr/bin/env node
'use strict';
const path = require('path');
const { scanLibrary, ERROR } = require('./lib/library-scan');
const { planAlbum, executeAlbum } = require('./lib/consolidate-lib');

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');

if (!root) {
  console.error('Usage: node consolidate.js <path-to-music-library-root> [--apply]');
  console.error('Without --apply this runs as a DRY RUN and makes no changes.');
  process.exit(1);
}

console.log(apply
  ? '*** APPLY MODE - files will be renamed, tags rewritten, and moved ***\n'
  : '*** DRY RUN - no changes will be made. Re-run with --apply to execute. ***\n');

const report = scanLibrary(path.resolve(root));

const blockingErrors = report.issues.filter((i) => i.severity === ERROR);
if (blockingErrors.length > 0) {
  console.log(`${blockingErrors.length} structural error(s) found - these are blocking consolidation `
    + 'and need to be fixed by hand first (run validate.js for the full report, including warnings):\n');
  for (const it of blockingErrors) {
    console.log(`[ERROR] ${it.path}`);
    console.log(`        ${it.message}`);
  }
  console.log('');
}

let albumsDone = 0;
let albumsSkipped = 0;
let albumsNotMultiCd = 0;
let tracksTotal = 0;

for (const artist of report.artists) {
  if (artist.misplacedAlbum) {
    albumsSkipped += 1;
    continue;
  }

  for (const album of artist.albums) {
    if (album.type !== 'multi-cd') {
      albumsNotMultiCd += 1;
      continue; // nothing to consolidate for flat albums
    }

    const hasErrors = album.issues.some((i) => i.severity === ERROR);
    if (hasErrors) {
      console.log(`SKIP  ${artist.name} / ${album.name}`);
      console.log('      has structural error(s) - run validate.js and fix the folder structure first');
      albumsSkipped += 1;
      continue;
    }

    console.log(`\n${artist.name} / ${album.name}  (${album.cdFolders.length} CDs)`);
    const { plan } = planAlbum(album);
    const result = executeAlbum(album, plan, apply, (line) => console.log(line));
    if (result.ok) {
      albumsDone += 1;
      tracksTotal += result.moved;
    } else {
      albumsSkipped += 1;
    }
  }
}

console.log('\n=== SUMMARY ===');
console.log(`Albums ${apply ? 'consolidated' : 'that would be consolidated'}: ${albumsDone}`);
console.log(`Tracks ${apply ? 'moved' : 'planned'}: ${tracksTotal}`);
console.log(`Albums skipped (structural errors): ${albumsSkipped}`);
console.log(`Albums with nothing to do (already flat / not multi-CD): ${albumsNotMultiCd}`);
if (albumsDone === 0 && blockingErrors.length > 0) {
  console.log('\nNothing was eligible - fix the structural error(s) listed above, then re-run.');
} else if (!apply) {
  console.log('\nNothing was changed. Re-run with --apply once this plan looks right.');
}
