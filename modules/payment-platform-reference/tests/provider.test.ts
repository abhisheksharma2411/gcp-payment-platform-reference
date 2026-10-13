/**
 * The provider boundary, including the regional key store.
 *
 * Required test: provider timeout before send versus after possible
 * acceptance.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeClock } from '../src/clock.ts';
import { PaymentPlatform } from '../src/platform.ts';
import { ProviderSimulator } from '../src/provider.ts';

function rig(mutations = {}) {
  const clock = makeClock();
  const provider = new ProviderSimulator();
  const platform = new PaymentPlatform({ clock, provider, mutations });
  platform.createIntent({
    intentId: 'int_1', tenantId: 'tnt_alpha', channel: 'WEB_CHECKOUT', currency: 'EUR',
    allocations: [{ allocationId: 'a1', purpose: 'goods', amountMinor: 4599 }],
    tokenRef: 'tok_synthetic_7f21',
  });
  return { clock, provider, platform };
}

test('P01 a timeout before send leaves no effect anywhere', () => {
  const { platform, provider } = rig();
  const r = platform.authorize({
    operationId: 'op_1', intentId: 'int_1', tenantId: 'tnt_alpha',
    amountMinor: 4599, scripted: 'TIMEOUT_BEFORE_SEND',
  });
  assert.equal(r.customerAnswer, 'UNKNOWN');
  assert.equal(provider.allApproved().length, 0);
  const resolved = platform.reconcileUnknown('op_1');
  assert.equal(resolved.customerAnswer, 'DEFINITIVE_FAILURE');
  assert.equal(resolved.reason, 'no_provider_effect_found');
});

test('P02 a timeout after send leaves an effect the caller never heard about', () => {
  const { platform, provider } = rig();
  const r = platform.authorize({
    operationId: 'op_1', intentId: 'int_1', tenantId: 'tnt_alpha',
    amountMinor: 4599, scripted: 'TIMEOUT_AFTER_SEND',
  });
  assert.equal(r.customerAnswer, 'UNKNOWN');
  assert.equal(r.providerRef, null, 'the platform learned nothing');
  assert.equal(provider.allApproved().length, 1, 'the provider knows');
  const resolved = platform.reconcileUnknown('op_1');
  assert.equal(resolved.customerAnswer, 'DEFINITIVE_SUCCESS');
  assert.equal(resolved.reason, 'resolved_by_lookup');
});

test('P03 the two timeouts are indistinguishable at the moment they happen', () => {
  const before = rig();
  const after = rig();
  const a = before.platform.authorize({
    operationId: 'op_1', intentId: 'int_1', tenantId: 'tnt_alpha',
    amountMinor: 4599, scripted: 'TIMEOUT_BEFORE_SEND',
  });
  const b = after.platform.authorize({
    operationId: 'op_1', intentId: 'int_1', tenantId: 'tnt_alpha',
    amountMinor: 4599, scripted: 'TIMEOUT_AFTER_SEND',
  });
  assert.deepEqual(
    { answer: a.customerAnswer, state: a.state, ref: a.providerRef, reason: a.reason },
    { answer: b.customerAnswer, state: b.state, ref: b.providerRef, reason: b.reason },
  );
});

test('P04 one idempotency key is honoured within a region', () => {
  const provider = new ProviderSimulator();
  const req = {
    endpointRegion: 'europe-west1', idempotencyKey: 'op_1', intentRef: 'int_1',
    operationKind: 'AUTHORIZE' as const, amountMinor: 4599, currency: 'EUR',
    scripted: 'APPROVED' as const,
  };
  const first = provider.charge(req);
  const second = provider.charge(req);
  assert.equal(first.providerRef, second.providerRef);
  assert.equal(provider.allApproved().length, 1);
});

test('P05 the same key sent to a second region charges twice', () => {
  // Adyen states the limit: idempotency keys are not checked for duplication
  // across regional endpoints. The platform failover is correct and the key
  // is correct, and together they produce two charges.
  const provider = new ProviderSimulator();
  const base = {
    idempotencyKey: 'op_1', intentRef: 'int_1', operationKind: 'AUTHORIZE' as const,
    amountMinor: 4599, currency: 'EUR', scripted: 'APPROVED' as const,
  };
  provider.charge({ ...base, endpointRegion: 'europe-west1' });
  provider.charge({ ...base, endpointRegion: 'europe-west4' });
  assert.equal(provider.allApproved().length, 2);
});

test('P06 a single-region key store would have caught it, and no provider offers one', () => {
  // The same run with the documented behaviour removed, to show that the
  // second charge is caused by the regional split and nothing else.
  const provider = new ProviderSimulator({ perRegionKeys: false });
  const base = {
    idempotencyKey: 'op_1', intentRef: 'int_1', operationKind: 'AUTHORIZE' as const,
    amountMinor: 4599, currency: 'EUR', scripted: 'APPROVED' as const,
  };
  provider.charge({ ...base, endpointRegion: 'europe-west1' });
  provider.charge({ ...base, endpointRegion: 'europe-west4' });
  assert.equal(provider.allApproved().length, 1);
});

test('P07 a capture above the authorised amount is refused by the provider too', () => {
  const provider = new ProviderSimulator();
  provider.charge({
    endpointRegion: 'europe-west1', idempotencyKey: 'op_a', intentRef: 'int_1',
    operationKind: 'AUTHORIZE', amountMinor: 4599, currency: 'EUR', scripted: 'APPROVED',
  });
  const over = provider.charge({
    endpointRegion: 'europe-west1', idempotencyKey: 'op_c', intentRef: 'int_1',
    operationKind: 'CAPTURE', amountMinor: 5000, currency: 'EUR', scripted: 'APPROVED',
  });
  assert.equal(over.declineReason, 'capture_exceeds_authorised');
});
