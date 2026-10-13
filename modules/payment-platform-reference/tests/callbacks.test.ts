/**
 * Provider callbacks: duplicates, conflicts, order, and the join.
 *
 * Required test: duplicate and conflicting webhook.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeClock } from '../src/clock.ts';
import { PaymentPlatform } from '../src/platform.ts';
import { ProviderSimulator } from '../src/provider.ts';

function unresolvedAuthorisation(mutations = {}) {
  const clock = makeClock();
  const provider = new ProviderSimulator();
  const platform = new PaymentPlatform({ clock, provider, mutations });
  platform.createIntent({
    intentId: 'int_1', tenantId: 'tnt_alpha', channel: 'WEB_CHECKOUT', currency: 'EUR',
    allocations: [{ allocationId: 'a1', purpose: 'goods', amountMinor: 4599 }],
    tokenRef: 'tok_synthetic_7f21',
  });
  platform.authorize({
    operationId: 'op_1', intentId: 'int_1', tenantId: 'tnt_alpha',
    amountMinor: 4599, scripted: 'TIMEOUT_AFTER_SEND',
  });
  const rec = provider.allApproved()[0]!;
  return { platform, provider, rec };
}

test('C01 a callback resolves an ambiguous outcome', () => {
  const { platform, rec } = unresolvedAuthorisation();
  const r = platform.handleCallback({
    objectId: rec.objectId, eventType: 'payment.authorized',
    providerRef: rec.providerRef, amountMinor: 4599,
  });
  assert.equal(r.reason, 'APPLIED');
  assert.equal(r.operationId, 'op_1');
  assert.equal(platform.operations.get('op_1')!.state, 'SUCCEEDED');
});

test('C02 a duplicate callback changes nothing', () => {
  const { platform, rec } = unresolvedAuthorisation();
  const cb = {
    objectId: rec.objectId, eventType: 'payment.authorized',
    providerRef: rec.providerRef, amountMinor: 4599,
  };
  platform.handleCallback(cb);
  const postings = platform.ledger.all().length;
  const second = platform.handleCallback(cb);
  assert.equal(second.reason, 'DUPLICATE');
  assert.equal(platform.ledger.all().length, postings);
});

test('C03 a conflicting callback is refused and recorded as an exception', () => {
  const { platform, rec } = unresolvedAuthorisation();
  platform.handleCallback({
    objectId: rec.objectId, eventType: 'payment.authorized',
    providerRef: rec.providerRef, amountMinor: 4599,
  });
  const conflicting = platform.handleCallback({
    objectId: rec.objectId, eventType: 'payment.authorized',
    providerRef: rec.providerRef, amountMinor: 1,
  });
  assert.equal(conflicting.reason, 'CONFLICT');
  assert.equal(platform.exceptions.length, 1);
  assert.equal(platform.exceptions[0]!.code, 'CALLBACK_CONFLICT');
});

test('C04 a callback for an object the platform cannot join is not applied', () => {
  const { platform } = unresolvedAuthorisation();
  const r = platform.handleCallback({
    objectId: 'obj_from_nowhere', eventType: 'payment.authorized',
    providerRef: 'prov_from_nowhere', amountMinor: 4599,
  });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'UNRESOLVED');
});

test('C05 callbacks arriving out of order converge on the same state', () => {
  // Stripe states that event delivery order is not guaranteed. The platform
  // keys on the object and the event type, so order is not load-bearing.
  const a = unresolvedAuthorisation();
  const b = unresolvedAuthorisation();
  const mk = (rec: { objectId: string; providerRef: string }, type: string) => ({
    objectId: rec.objectId, eventType: type, providerRef: rec.providerRef, amountMinor: 4599,
  });
  a.platform.handleCallback(mk(a.rec, 'payment.authorized'));
  a.platform.handleCallback(mk(a.rec, 'payment.updated'));
  b.platform.handleCallback(mk(b.rec, 'payment.updated'));
  b.platform.handleCallback(mk(b.rec, 'payment.authorized'));
  assert.equal(
    a.platform.operations.get('op_1')!.state,
    b.platform.operations.get('op_1')!.state,
  );
  assert.equal(b.platform.operations.get('op_1')!.state, 'SUCCEEDED');
});

test('C06 removing the join is what makes an effect unattributable', () => {
  const { platform, rec } = unresolvedAuthorisation({ skipCallbackResolution: true });
  const r = platform.handleCallback({
    objectId: rec.objectId, eventType: 'payment.authorized',
    providerRef: rec.providerRef, amountMinor: 4599,
  });
  assert.equal(r.applied, true);
  assert.equal(r.operationId, null, 'applied with nothing to attribute it to');
});
