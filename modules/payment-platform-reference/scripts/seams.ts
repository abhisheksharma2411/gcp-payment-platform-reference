/**
 * The seam gate. Runs every control and fails the build unless each one
 * produces exactly its declared code, and unless the blunt control still
 * produces more than one code (which is why it is rejected).
 *
 *   node scripts/seams.ts --controls
 */
import { CONTROLS, controlEverythingBroken } from '../src/controls.ts';
import { SCENARIOS } from '../src/scenarios.ts';

const wantControls = process.argv.includes('--controls');

let failed = 0;

console.log('scenarios:');
for (const fn of SCENARIOS) {
  const s = fn();
  const codes = s.codes.length === 0 ? 'clean' : s.codes.join(', ');
  console.log(`  ${s.name.padEnd(30)} ${codes}`);
}

if (wantControls) {
  console.log('controls:');
  for (const fn of CONTROLS) {
    const c = fn();
    const mark = c.exact ? 'ok  ' : 'FAIL';
    console.log(`  ${mark} ${c.name.padEnd(30)} expected ${c.expected.join(',')} got ${c.actual.join(',') || 'none'}`);
    if (!c.exact) failed += 1;
  }
  const blunt = controlEverythingBroken();
  if (blunt.actual.length < 4) {
    console.log(`  FAIL ${blunt.name} produced ${blunt.actual.length} codes; it is supposed to be too blunt`);
    failed += 1;
  } else {
    console.log(`  ok   ${blunt.name.padEnd(30)} rejected: ${blunt.actual.length} codes, attributable to nothing`);
  }
}

if (failed > 0) {
  console.error(`seam gate: ${failed} control(s) did not discriminate`);
  process.exit(1);
}
console.log('seam gate: PASS');
