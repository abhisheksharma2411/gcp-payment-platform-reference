/** One command that runs the complete happy path end to end. */
import { isoOf } from '../src/clock.ts';
import { webCheckoutHappy } from '../src/scenarios.ts';
import { timelineFor } from '../src/timeline.ts';

const s = webCheckoutHappy();
console.log(`scenario: ${s.name}`);
for (const n of s.notes) console.log(`  ${n}`);
console.log('');
console.log('audit timeline for op_cap_1:');
for (const row of timelineFor(s.platform.trace, 'op_cap_1')) {
  console.log(`  ${isoOf(row.at)}  ${row.kind.padEnd(18)} ${row.summary}`);
}
console.log('');
console.log(`settlement: ${s.settlement?.matched} matched, ${s.settlement?.exceptions} exceptions`);
console.log(`seam findings: ${s.codes.length === 0 ? 'none' : s.codes.join(', ')}`);
