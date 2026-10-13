/**
 * Identity at the two inbound boundaries, and the join between them.
 *
 * Required test: duplicate create and execute requests.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeClock } from '../src/clock.ts';
import { callbackEffectId, commandEffectId, requestHash, resolveOperationId } from '../src/ids.ts';
import { PaymentPlatform } from '../src/platform.ts';
import { ProviderSimulator } from '../src/provider.ts';

function rig() {
  const clock = makeClock();
  const provider = new ProviderSimulator();
  const platform = new PaymentPlatform({ clock, provider });
  platform.createIntent({
    intentId: 'int_1', tenantId: 'tnt_alpha', channel: 'WEB_CHECKOUT', currency: 'EUR',
    allocations: [{ allocationId: 'a1', purpose: 'goods', amountMinor: 4599 }],
    tokenRef: 'tok_synthetic_7f21',
  });
  return { clock, provider, platform };
}

test('I01 creating the same intent twice yields one intent', () => {
  const { platform } = rig();
  const again = platform.createIntent({
    intentId: 'int_1', tenantId: 'tnt_alpha', channel: 'WEB_CHECKOUT', currency: 'EUR',
    allocations: [{ allocationId: 'a1', purpose: 'goods', amountMinor: 9999 }],
    tokenRef: 'tok_other',
  });
  assert.equal(platform.intents.size, 1);
  assert.equal(again.amountMinor, 4599, 'the second create must not change the first');
});

test('I02 one hundred retries of one operation produce one provider effect', () => {
  const { platform, provider } = rig();
  const results = [];
  for (let i = 0; i < 100; i += 1) {
    results.push(platform.authorize({
      operationId: 'op_1', intentId: 'int_1', tenantId: 'tnt_alpha', amountMinor: 4599,
    }));
  }
  assert.equal(results[0]!.decision, 'FIRST');
  assert.ok(results.slice(1).every((r) => r.decision === 'REPLAY'));
  assert.equal(provider.allApproved().length, 1);
});

test('I03 the same operation id with different parameters is a conflict', () => {
  const { platform } = rig();
  platform.authorize({ operationId: 'op_1', intentId: 'int_1', tenantId: 'tnt_alpha', amountMinor: 4599 });
  const second = platform.authorize({
    operationId: 'op_1', intentId: 'int_1', tenantId: 'tnt_alpha', amountMinor: 1,
  });
  assert.equal(second.decision, 'CONFLICT');
  assert.equal(second.reason, 'request_hash_mismatch');
});

test('I04 the request hash is order-independent and value-sensitive', () => {
  assert.equal(requestHash({ a: 1, b: 'x' }), requestHash({ b: 'x', a: 1 }));
  assert.notEqual(requestHash({ a: 1 }), requestHash({ a: 2 }));
});

test('I05 the two effect identities are derived from different things', () => {
  // Article 12 keys on the identity the caller chose. Article 17 keys on a
  // position the publisher cannot regenerate. At a provider boundary the
  // callback path has neither, so it keys on the provider object.
  const fromCommand = commandEffectId('op_1', 'CAPTURE');
  const fromCallback = callbackEffectId('obj_1', 'payment.captured');
  assert.notEqual(fromCommand, fromCallback);
  assert.equal(commandEffectId('op_1', 'CAPTURE'), fromCommand, 'stable across calls');
  assert.equal(
    callbackEffectId('obj_1', 'payment.captured'),
    fromCallback,
    'a resent callback with a new event id yields the same effect identity',
  );
  assert.notEqual(
    callbackEffectId('obj_1', 'payment.refunded'),
    fromCallback,
    'the event type is part of the identity',
  );
});

test('I06 resolution returns null rather than guessing', () => {
  const index = new Map([['obj_1', 'op_1']]);
  assert.equal(resolveOperationId(index, 'obj_1'), 'op_1');
  assert.equal(resolveOperationId(index, 'obj_missing'), null);
});
