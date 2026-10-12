#!/usr/bin/env node
'use strict';
const path = require('path');
const { readEntries } = require('./lib/scan');
const { analyzeFolder, planFolder, applyPlan } = require('./lib/disc-combine-lib');

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');

if (!root) {
  console.error('Usage: node fix-disc-numbering.js <path-to-folder-or-library-root> [--apply]');
  console.error('Without --apply this runs as a DRY RUN and makes no changes.');
  console.error('');
  console.error('For any folder whose mp3s directly inside carry more than one distinct');
  console.error('disc-number (TPOS) tag value, renumbers the track-number (TRCK) tag so it');
  console.error('keeps counting up across discs instead of resetting to 1 for each one.');
  console.error('Disc tags are left alone. Filenames are never changed.');
  process.exit(1);
}

console.log(apply
  ? '*** APPLY MODE - ID3 track-number tags will be rewritten ***\n'
  : '*** DRY RUN - no changes will be made. Re-run with --apply to execute. ***\n');

let foldersFixed = 0;
let foldersSkipped = 0;
let tracksTotal = 0;

function walk(dirPath) {
  const entries = analyzeFolder(dirPath);
  if (entries) {
    const { plan, warnings, skipped } = planFolder(entries);
    console.log(`\n${dirPath}`);
    for (const w of warnings) console.log(`  ! WARNING: ${w}`);
    if (skipped) {
      foldersSkipped += 1;
    } else {
      applyPlan(plan, apply, (line) => console.log(line));
      foldersFixed += 1;
      tracksTotal += plan.length;
    }
  }
  const { dirs } = readEntries(dirPath);
  for (const d of dirs) walk(path.join(dirPath, d));
}

walk(path.resolve(root));

console.log('\n=== SUMMARY ===');
console.log(`Folders ${apply ? 'fixed' : 'that would be fixed'}: ${foldersFixed}`);
console.log(`Tracks ${apply ? 'renumbered' : 'planned'}: ${tracksTotal}`);
console.log(`Folders skipped (looked already combined): ${foldersSkipped}`);
if (!apply) console.log('\nNothing was changed. Re-run with --apply once this looks right.');
