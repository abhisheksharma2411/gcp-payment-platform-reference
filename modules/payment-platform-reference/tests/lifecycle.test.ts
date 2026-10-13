/**
 * Lifecycle, capture rules and restart.
 *
 * Required tests: concurrent payment attempts against one intent; partial and
 * full capture rules; refund amount exceeds captured amount; service restart
 * during an in-progress operation.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLegalTransition, OPERATION_TRANSITIONS, TERMINAL_STATES } from '../src/authority.ts';
import { makeClock } from '../src/clock.ts';
import { PaymentPlatform } from '../src/platform.ts';
import { ProviderSimulator } from '../src/provider.ts';
import { partialCaptureAndRefund, restartMidOperation } from '../src/scenarios.ts';

function rig(amountMinor = 4599) {
  const clock = makeClock();
  const provider = new ProviderSimulator();
  const platform = new PaymentPlatform({ clock, provider });
  platform.createIntent({
    intentId: 'int_1', tenantId: 'tnt_alpha', channel: 'POINT_OF_SALE', currency: 'EUR',
    allocations: [{ allocationId: 'a1', purpose: 'goods', amountMinor }],
    tokenRef: 'tok_synthetic_7f21',
  });
  return { clock, provider, platform };
}

test('L01 no transition leaves a terminal state', () => {
  for (const t of OPERATION_TRANSITIONS) {
    assert.ok(!TERMINAL_STATES.includes(t.from), `${t.from} -> ${t.to} leaves a terminal state`);
  }
});

test('L02 an undeclared edge is refused by the platform, not merely unused', () => {
  assert.equal(isLegalTransition('SUCCEEDED', 'IN_FLIGHT'), false);
  const { platform } = rig();
  platform.authorize({ operationId: 'op_1', intentId: 'int_1', tenantId: 'tnt_alpha', amountMinor: 4599 });
  assert.throws(
    () => platform.forceOperationState('op_1', 'IN_FLIGHT'),
    /requires the allowIllegalTransition control/,
  );
});

test('L03 two attempts against one intent cannot both take the full amount', () => {
  const { platform } = rig();
  platform.authorize({ operationId: 'op_a', intentId: 'int_1', tenantId: 'tnt_alpha', amountMinor: 4599 });
  const first = platform.capture({
    operationId: 'op_c1', intentId: 'int_1', tenantId: 'tnt_alpha', amountMinor: 4599,
  });
  const second = platform.capture({
    operationId: 'op_c2', intentId: 'int_1', tenantId: 'tnt_alpha', amountMinor: 4599,
  });
  assert.equal(first.customerAnswer, 'DEFINITIVE_SUCCESS');
  assert.equal(second.decision, 'REJECTED');
  assert.equal(second.reason, 'capture_exceeds_authorised');
});

test('L04 partial captures sum to the authorised amount and no further', () => {
  const s = partialCaptureAndRefund();
  const intent = s.platform.intents.get('int_0001')!;
  assert.equal(intent.capturedMinor, 4599);
  assert.equal(intent.status, 'PARTIALLY_REFUNDED');
  assert.ok(s.notes.includes('capture 100 over authorised: capture_exceeds_authorised'));
});

test('L05 a refund above the captured amount is refused by both sides', () => {
  const { platform, provider } = rig();
  platform.authorize({ operationId: 'op_a', intentId: 'int_1', tenantId: 'tnt_alpha', amountMinor: 4599 });
  platform.capture({ operationId: 'op_c', intentId: 'int_1', tenantId: 'tnt_alpha', amountMinor: 2000 });
  const over = platform.refund({
    operationId: 'op_r', intentId: 'int_1', tenantId: 'tnt_alpha', amountMinor: 3000,
  });
  assert.equal(over.reason, 'refund_exceeds_captured');
  // And the provider refuses the same thing independently, which is the point
  // of modelling both: the platform rule is not the only thing standing there.
  const direct = provider.charge({
    endpointRegion: 'europe-west1', idempotencyKey: 'op_r_direct', intentRef: 'int_1',
    operationKind: 'REFUND', amountMinor: 3000, currency: 'EUR', scripted: 'APPROVED',
  });
  assert.equal(direct.declineReason, 'refund_exceeds_captured');
});

test('L06 a restart mid-operation converges on one effect', () => {
  const s = restartMidOperation();
  assert.ok(s.notes.includes('before restart: UNKNOWN'));
  assert.ok(s.notes.includes('after restart: DEFINITIVE_SUCCESS'));
  const effects = s.platform.trace.entries.filter((e) => e.kind === 'provider_effect');
  const authorise = effects.filter((e) => e.kind === 'provider_effect' && e.operationKind === 'AUTHORIZE');
  assert.equal(authorise.length, 1, 'the restart must not produce a second authorisation');
});

test('L07 the customer answer distinguishes unknown from failure', () => {
  const { platform } = rig();
  const unknown = platform.authorize({
    operationId: 'op_u', intentId: 'int_1', tenantId: 'tnt_alpha',
    amountMinor: 4599, scripted: 'TIMEOUT_AFTER_SEND',
  });
  assert.equal(unknown.customerAnswer, 'UNKNOWN');
  assert.equal(platform.operations.get('op_u')!.state, 'OUTCOME_UNKNOWN');
});
