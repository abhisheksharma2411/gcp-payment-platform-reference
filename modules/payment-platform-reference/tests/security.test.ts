/**
 * Tenancy and cardholder-data scope.
 *
 * Required tests: unauthorized cross-tenant or cross-account access; logs
 * contain no synthetic full account number or secret.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoOf } from '../src/clock.ts';
import { crossTenantDenied, SCENARIOS } from '../src/scenarios.ts';
import { controlCardholderDataLeak } from '../src/controls.ts';
import { renderTrace } from '../src/trace.ts';
import { timelineFor } from '../src/timeline.ts';

const here = dirname(fileURLToPath(import.meta.url));

function luhnOk(digits: string): boolean {
  let total = 0;
  const parity = digits.length % 2;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[i]);
    if (i % 2 === parity) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return total % 10 === 0;
}

test('S01 a command for another tenant is refused', () => {
  const s = crossTenantDenied();
  assert.ok(s.notes.includes('capture as tnt_beta: cross_tenant_denied'));
});

test('S02 a read for another tenant returns nothing', () => {
  const s = crossTenantDenied();
  assert.ok(s.notes.includes('read as tnt_beta: denied'));
  assert.deepEqual(s.codes, []);
});

test('S03 no rendered trace contains a card-shaped number', () => {
  for (const fn of SCENARIOS) {
    const s = fn();
    const text = renderTrace(s.platform.trace, isoOf);
    const runs = text.match(/(?<![0-9])[0-9]{13,19}(?![0-9])/g) ?? [];
    assert.deepEqual(runs, [], `${s.name} rendered a card-length digit run`);
  }
});

test('S04 the audit timeline carries references and never a token value', () => {
  const s = SCENARIOS[0]!();
  const rows = timelineFor(s.platform.trace, 'op_cap_1');
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(!row.summary.includes('tok_'), 'a timeline row resolved a token reference');
  }
});

test('S05 the leak control is the only thing that produces a card-shaped value', () => {
  const c = controlCardholderDataLeak();
  assert.deepEqual(c.actual, ['S09_CARDHOLDER_DATA_OUTSIDE_VAULT']);
});

test('S06 the synthetic account number in the leak control is not Luhn-valid', () => {
  // A deliberately invalid check digit keeps the repository safety scan honest:
  // anything Luhn-valid in this tree would be a finding, and should be.
  const source = readFileSync(join(here, '..', 'src', 'platform.ts'), 'utf8');
  const match = source.match(/PAN_SHAPED = '([0-9]+)'/);
  assert.ok(match, 'the synthetic value moved');
  assert.equal(luhnOk(match![1]!), false);
});

test('S07 no secret-shaped literal appears in any scenario trace', () => {
  for (const fn of SCENARIOS) {
    const s = fn();
    const text = renderTrace(s.platform.trace, isoOf).toLowerCase();
    for (const needle of ['bearer ', 'sk_live', 'private key', 'password=']) {
      assert.ok(!text.includes(needle), `${s.name} trace contains ${needle}`);
    }
  }
});
