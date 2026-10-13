/**
 * The seam auditor, and the tests that guard the auditor itself.
 *
 * A suite that stays green when the thing it tests is removed measures
 * nothing, so every code has a control, every control must produce its code
 * and no others, and the last three tests here check the harness rather than
 * the platform.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTHORITY_MAP } from '../src/authority.ts';
import { CONTROLS, controlEverythingBroken } from '../src/controls.ts';
import { SCENARIOS, webCheckoutHappy } from '../src/scenarios.ts';
import { auditSeams, codesOf, SEAM_CODES } from '../src/seams.ts';
import { newTrace } from '../src/trace.ts';

test('A01 every scenario is clean', () => {
  for (const fn of SCENARIOS) {
    const s = fn();
    assert.deepEqual(s.codes, [], `${s.name} reported ${s.codes.join(',')}`);
  }
});

test('A02 every control produces its code and no others', () => {
  for (const fn of CONTROLS) {
    const c = fn();
    assert.deepEqual(c.actual, c.expected, `${c.name} did not discriminate`);
  }
});

test('A03 there is one control per code and one code per control', () => {
  const codes = Object.keys(SEAM_CODES).sort();
  const covered = CONTROLS.flatMap((fn) => fn().expected).sort();
  assert.deepEqual(covered, codes);
});

test('A04 the blunt control is rejected rather than counted', () => {
  const blunt = controlEverythingBroken();
  assert.equal(blunt.rejected, true);
  assert.ok(
    blunt.actual.length >= 4,
    'a control meant to be too blunt that produces few codes is not blunt',
  );
  assert.deepEqual(blunt.expected, [], 'a rejected control declares nothing');
});

test('A05 the auditor reports nothing on an empty trace, and that is not a pass', () => {
  // The trivial way to make an auditor green is to hand it nothing. This test
  // exists so that a later refactor which quietly stops populating the trace
  // fails here rather than passing everywhere.
  assert.deepEqual(codesOf(auditSeams(newTrace())), []);
  const s = webCheckoutHappy();
  assert.ok(s.platform.trace.entries.length > 20, 'the reference run records very little');
});

test('A06 the auditor reads the trace and the declarations only', () => {
  // Handing it a structurally equal copy of the trace -- with no platform,
  // no ledger, no provider behind it -- must produce identical findings.
  const s = webCheckoutHappy();
  const copy = JSON.parse(JSON.stringify(s.platform.trace));
  assert.deepEqual(codesOf(auditSeams(copy)), codesOf(auditSeams(s.platform.trace)));
});

test('A07 the authority map has no field without a declared window', () => {
  for (const rule of AUTHORITY_MAP) {
    assert.ok(Number.isInteger(rule.divergenceWindowMs) && rule.divergenceWindowMs >= 0);
    assert.ok(rule.field.includes('.'), 'a field name must say which store it is in');
  }
});

test('A08 an unknown posting direction is refused rather than assumed', () => {
  const trace = newTrace();
  trace.entries.push({
    at: 1, kind: 'posting', postingId: 'p1', operationId: 'op_1', tenantId: 't',
    account: 'a', direction: 'SIDEWAYS' as unknown as 'DEBIT', amountMinor: 1,
    currency: 'EUR', writer: 'ledger', field: 'ledger.posting',
  });
  assert.throws(() => auditSeams(trace), /unknown posting direction/);
});
