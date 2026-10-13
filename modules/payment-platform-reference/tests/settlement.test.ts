/**
 * Settlement evidence: matches, mismatches, and the charge that only
 * settlement can see.
 *
 * Required test: settlement evidence matches and mismatches.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeClock } from '../src/clock.ts';
import { PaymentPlatform } from '../src/platform.ts';
import { ProviderSimulator } from '../src/provider.ts';
import { buildSettlementFile, ingestSettlement } from '../src/settlement.ts';
import { auditSeams, codesOf } from '../src/seams.ts';
import { settlementMismatch, webCheckoutHappy } from '../src/scenarios.ts';

test('T01 a matching file produces matches and no exceptions', () => {
  const s = webCheckoutHappy();
  assert.equal(s.settlement!.matched, 1);
  assert.equal(s.settlement!.exceptions, 0);
  assert.deepEqual(s.codes, []);
});

test('T02 a one-unit disagreement produces an exception, not a posting', () => {
  const s = settlementMismatch();
  assert.equal(s.settlement!.matched, 0);
  assert.equal(s.settlement!.exceptions, 1);
  assert.equal(s.platform.exceptions[0]!.code, 'AMOUNT_MISMATCH');
  const settlePostings = s.platform.ledger.all().filter((p) => p.operationId.startsWith('settle_'));
  assert.equal(settlePostings.length, 0, 'an unexplained line must not reach the books');
});

test('T03 an exception is a handled disagreement, so the auditor stays quiet', () => {
  const s = settlementMismatch();
  assert.deepEqual(s.codes, [], 'the platform noticed; there is no seam defect to report');
});

test('T04 settlement is the only place a second charge becomes visible', () => {
  const clock = makeClock();
  const provider = new ProviderSimulator();
  const platform = new PaymentPlatform({
    clock, provider, mutations: { failoverRegionOnRetry: true },
  });
  platform.createIntent({
    intentId: 'int_1', tenantId: 'tnt_alpha', channel: 'WEB_CHECKOUT', currency: 'EUR',
    allocations: [{ allocationId: 'a1', purpose: 'goods', amountMinor: 4599 }],
    tokenRef: 'tok_synthetic_7f21',
  });
  platform.authorize({ operationId: 'op_a', intentId: 'int_1', tenantId: 'tnt_alpha', amountMinor: 4599 });
  platform.capture({
    operationId: 'op_c', intentId: 'int_1', tenantId: 'tnt_alpha',
    amountMinor: 2000, scripted: 'TIMEOUT_AFTER_SEND',
  });
  platform.reconcileUnknown('op_c');

  // Before the file arrives, the platform's own records look complete.
  assert.deepEqual(codesOf(auditSeams(platform.trace)), []);
  assert.equal(provider.allApproved().filter((r) => r.operationKind === 'CAPTURE').length, 2);

  const summary = ingestSettlement(platform, clock, buildSettlementFile(provider));
  assert.equal(summary.exceptions, 1);
  assert.deepEqual(codesOf(auditSeams(platform.trace)), ['S12_UNRECORDED_PROVIDER_EFFECT']);
});

test('T05 the settlement file is built from the provider, not from the platform', () => {
  const provider = new ProviderSimulator();
  provider.charge({
    endpointRegion: 'europe-west1', idempotencyKey: 'k0', intentRef: 'int_1',
    operationKind: 'AUTHORIZE', amountMinor: 4599, currency: 'EUR', scripted: 'APPROVED',
  });
  provider.charge({
    endpointRegion: 'europe-west1', idempotencyKey: 'k1', intentRef: 'int_1',
    operationKind: 'CAPTURE', amountMinor: 4599, currency: 'EUR', scripted: 'APPROVED',
  });
  const file = buildSettlementFile(provider);
  assert.equal(file.length, 1);
  assert.equal(file[0]!.grossMinor, 4599);
  assert.equal(file[0]!.feeMinor, 114);
  assert.equal(file[0]!.netMinor, 4485);
});

test('T06 authorisations do not appear in a settlement file', () => {
  const provider = new ProviderSimulator();
  provider.charge({
    endpointRegion: 'europe-west1', idempotencyKey: 'k1', intentRef: 'int_1',
    operationKind: 'AUTHORIZE', amountMinor: 4599, currency: 'EUR', scripted: 'APPROVED',
  });
  assert.equal(buildSettlementFile(provider).length, 0);
});

test('T07 a full capture would have been saved by a rule the platform does not own', () => {
  // The same failover, with the whole authorised amount. The provider refuses
  // the second charge under its own capture-cannot-exceed-authorised rule.
  // The platform behaved identically; only the provider's accounting rule
  // differed, and a platform that relies on it has outsourced its invariant.
  const clock = makeClock();
  const provider = new ProviderSimulator();
  const platform = new PaymentPlatform({
    clock, provider, mutations: { failoverRegionOnRetry: true },
  });
  platform.createIntent({
    intentId: 'int_1', tenantId: 'tnt_alpha', channel: 'WEB_CHECKOUT', currency: 'EUR',
    allocations: [{ allocationId: 'a1', purpose: 'goods', amountMinor: 4599 }],
    tokenRef: 'tok_synthetic_7f21',
  });
  platform.authorize({ operationId: 'op_a', intentId: 'int_1', tenantId: 'tnt_alpha', amountMinor: 4599 });
  platform.capture({
    operationId: 'op_c', intentId: 'int_1', tenantId: 'tnt_alpha',
    amountMinor: 4599, scripted: 'TIMEOUT_AFTER_SEND',
  });
  platform.reconcileUnknown('op_c');
  const captures = provider.allApproved().filter((r) => r.operationKind === 'CAPTURE');
  assert.equal(captures.length, 1, 'the provider refused the second charge');
  assert.equal(platform.operations.get('op_c')!.state, 'OUTCOME_UNKNOWN');
});
