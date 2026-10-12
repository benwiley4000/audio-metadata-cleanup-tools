#!/usr/bin/env node
'use strict';
const path = require('path');
const { findM4aFolders, analyzeFolder, planFolder, applyPlan } = require('./lib/m4a-disc-combine-lib');

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');

if (!root) {
  console.error('Usage: node renumber-m4a.js <path-to-music-library-root> [--apply]');
  console.error('Without --apply this runs as a DRY RUN and makes no changes.');
  process.exit(1);
}

console.log(apply
  ? '*** APPLY MODE - m4a track-number tags will be rewritten ***\n'
  : '*** DRY RUN - no changes will be made. Re-run with --apply to execute. ***\n');

(async () => {
  const folders = findM4aFolders(path.resolve(root));
  let fixed = 0;
  let skipped = 0;
  let tracks = 0;

  for (const folder of folders) {
    const entries = await analyzeFolder(folder);
    if (!entries) continue; // single disc - nothing to do

    console.log(`\n${folder}`);
    const { plan, warnings, skipped: wasSkipped } = planFolder(entries);
    for (const w of warnings) console.log(`  ! ${w}`);
    if (wasSkipped) { skipped += 1; continue; }

    await applyPlan(plan, apply, (line) => console.log(line));
    fixed += 1;
    tracks += plan.length;
  }

  console.log('\n=== SUMMARY ===');
  console.log(`m4a folders examined: ${folders.length}`);
  console.log(`Folders ${apply ? 'renumbered' : 'that would be renumbered'}: ${fixed}`);
  console.log(`Tracks ${apply ? 'retagged' : 'planned'}: ${tracks}`);
  console.log(`Folders skipped (look already offset): ${skipped}`);
  if (!apply) console.log('\nNothing was changed. Re-run with --apply once this plan looks right.');
})();
