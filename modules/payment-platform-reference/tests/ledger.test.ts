/**
 * The ledger, and the thing the ledger cannot check about itself.
 *
 * Required test: ledger remains balanced under success, refund and reversal.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger, LEGS } from '../src/ledger.ts';
import {
  fullReversal, partialCaptureAndRefund, webCheckoutHappy,
} from '../src/scenarios.ts';
import { controlPostedAmountMismatch } from '../src/controls.ts';
import { auditSeams, codesOf } from '../src/seams.ts';

test('D01 every leg set balances by construction', () => {
  const sets = [LEGS.capture(4599), LEGS.refund(1000), LEGS.reversal(4599), LEGS.settlement(4599, 114)];
  for (const legs of sets) {
    const sum = legs.reduce((a, l) => a + (l.direction === 'DEBIT' ? l.amountMinor : -l.amountMinor), 0);
    assert.equal(sum, 0);
  }
});

test('D02 success, refund and reversal all leave a balanced journal', () => {
  for (const scenario of [webCheckoutHappy, partialCaptureAndRefund, fullReversal]) {
    const s = scenario();
    const operations = [...new Set(s.platform.ledger.all().map((p) => p.operationId))];
    for (const op of operations) {
      assert.ok(s.platform.ledger.isBalanced(op), `${s.name}: ${op} does not balance`);
    }
    assert.ok(!s.codes.includes('S06_UNBALANCED_JOURNAL'), `${s.name} reported S06`);
  }
});

test('D03 an authorisation posts nothing', () => {
  const s = webCheckoutHappy();
  const authPostings = s.platform.ledger.all().filter((p) => p.operationId === 'op_auth_1');
  assert.equal(authPostings.length, 0, 'an authorisation is not a movement of money');
});

test('D04 settlement clears the receivable it created', () => {
  const s = webCheckoutHappy();
  assert.equal(s.platform.ledger.balance('provider_receivable'), 0);
  assert.equal(s.platform.ledger.balance('provider_fees'), 114);
});

test('D05 the balance invariant cannot see a symmetric arithmetic error', () => {
  // This is the defect class this programme keeps finding: a checker that
  // shares arithmetic with the thing it checks. Here it is demonstrated
  // rather than asserted.
  const broken = new Ledger({ normaliseMinor: (n) => Math.trunc(n / 100) * 100 });
  broken.post('op_1', 'EUR', LEGS.capture(4599));
  assert.equal(broken.isBalanced('op_1'), true, 'the ledger reports no problem');
  assert.equal(broken.all()[0]!.amountMinor, 4500, 'and every stored amount is wrong');
});

test('D06 an independent check against the command does see it', () => {
  const c = controlPostedAmountMismatch();
  assert.equal(c.ledgerSaysBalanced, true);
  assert.deepEqual(c.actual, ['S11_POSTED_AMOUNT_MISMATCH']);
});

test('D07 the auditor does not call the ledger', () => {
  // The auditor takes a trace and nothing else. Handing it a trace from a
  // platform whose ledger object has been discarded must still work.
  const s = webCheckoutHappy();
  const trace = { entries: [...s.platform.trace.entries] };
  assert.deepEqual(codesOf(auditSeams(trace)), []);
});
