/**
 * Named scenarios. Each one runs a complete payment through the integrated
 * platform and ends with a seam audit, so that every claim in the article is
 * the output of something that ran.
 *
 * Three channels are represented -- web checkout, point of sale and
 * agent-assisted -- and none of them touches a card number. The token
 * reference is a synthetic string; see docs/MODEL.md.
 */
import { makeClock, type Clock } from './clock.ts';
import { PaymentPlatform, type Mutations } from './platform.ts';
import { ProviderSimulator } from './provider.ts';
import { auditSeams, codesOf, type Finding } from './seams.ts';
import { buildSettlementFile, ingestSettlement } from './settlement.ts';
import type { Allocation } from './types.ts';

export interface ScenarioResult {
  name: string;
  description: string;
  platform: PaymentPlatform;
  clock: Clock;
  findings: Finding[];
  codes: string[];
  notes: string[];
  settlement: { matched: number; exceptions: number; lines: number } | null;
}

const ALLOCATIONS: Allocation[] = [
  { allocationId: 'alloc_goods', purpose: 'goods', amountMinor: 3000 },
  { allocationId: 'alloc_shipping', purpose: 'shipping', amountMinor: 1599 },
];

const TOTAL = ALLOCATIONS.reduce((a, x) => a + x.amountMinor, 0); // 4599

interface Rig {
  clock: Clock;
  provider: ProviderSimulator;
  platform: PaymentPlatform;
}

function rig(mutations: Mutations = {}, providerOpts = {}): Rig {
  const clock = makeClock();
  const provider = new ProviderSimulator(providerOpts);
  const platform = new PaymentPlatform({ clock, provider, mutations });
  return { clock, provider, platform };
}

function intent(platform: PaymentPlatform, channel: 'WEB_CHECKOUT' | 'POINT_OF_SALE' | 'AGENT_ASSISTED') {
  return platform.createIntent({
    intentId: 'int_0001',
    tenantId: 'tnt_alpha',
    channel,
    currency: 'EUR',
    allocations: ALLOCATIONS,
    tokenRef: 'tok_synthetic_7f21',
  });
}

function finish(
  name: string,
  description: string,
  r: Rig,
  notes: string[],
  settle: boolean,
  corrupt: Record<string, number> = {},
): ScenarioResult {
  let settlement = null;
  if (settle) {
    const file = buildSettlementFile(r.provider, { corrupt });
    settlement = ingestSettlement(r.platform, r.clock, file);
  }
  const findings = auditSeams(r.platform.trace);
  return {
    name,
    description,
    platform: r.platform,
    clock: r.clock,
    findings,
    codes: codesOf(findings),
    notes,
    settlement,
  };
}

export function webCheckoutHappy(): ScenarioResult {
  const r = rig();
  intent(r.platform, 'WEB_CHECKOUT');
  const auth = r.platform.authorize({
    operationId: 'op_auth_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: TOTAL,
  });
  const cap = r.platform.capture({
    operationId: 'op_cap_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: TOTAL,
  });
  const replay = r.platform.capture({
    operationId: 'op_cap_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: TOTAL,
  });
  r.platform.readOperational('int_0001', 'tnt_alpha');
  r.platform.readReporting('int_0001', 'tnt_alpha');
  return finish(
    'web-checkout-happy',
    'Two allocations, authorise, capture, settle. The reference run.',
    r,
    [
      `authorise: ${auth.customerAnswer}`,
      `capture: ${cap.customerAnswer}`,
      `duplicate capture: ${replay.decision}`,
    ],
    true,
  );
}

export function posDecline(): ScenarioResult {
  const r = rig();
  intent(r.platform, 'POINT_OF_SALE');
  const auth = r.platform.authorize({
    operationId: 'op_auth_1', intentId: 'int_0001', tenantId: 'tnt_alpha',
    amountMinor: TOTAL, scripted: 'DECLINED',
  });
  return finish(
    'pos-decline',
    'A declined authorisation. Definitive, and no accounting consequence.',
    r,
    [`authorise: ${auth.customerAnswer}`, `reason: ${auth.reason ?? 'none'}`],
    true,
  );
}

export function timeoutBeforeSend(): ScenarioResult {
  const r = rig();
  intent(r.platform, 'WEB_CHECKOUT');
  const auth = r.platform.authorize({
    operationId: 'op_auth_1', intentId: 'int_0001', tenantId: 'tnt_alpha',
    amountMinor: TOTAL, scripted: 'TIMEOUT_BEFORE_SEND',
  });
  const resolved = r.platform.reconcileUnknown('op_auth_1');
  return finish(
    'timeout-before-send',
    'The request never reached the provider. Indistinguishable at the caller.',
    r,
    [`authorise: ${auth.customerAnswer}`, `after lookup: ${resolved.customerAnswer}`],
    true,
  );
}

export function ambiguousTimeoutLookup(): ScenarioResult {
  const r = rig();
  intent(r.platform, 'WEB_CHECKOUT');
  const auth = r.platform.authorize({
    operationId: 'op_auth_1', intentId: 'int_0001', tenantId: 'tnt_alpha',
    amountMinor: TOTAL, scripted: 'TIMEOUT_AFTER_SEND',
  });
  const resolved = r.platform.reconcileUnknown('op_auth_1');
  const cap = r.platform.capture({
    operationId: 'op_cap_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: TOTAL,
  });
  return finish(
    'ambiguous-timeout-lookup',
    'The charge happened and the answer was lost. Resolved by provider lookup.',
    r,
    [
      `authorise: ${auth.customerAnswer}`,
      `after lookup: ${resolved.customerAnswer}`,
      `capture: ${cap.customerAnswer}`,
    ],
    true,
  );
}

export function ambiguousTimeoutCallback(): ScenarioResult {
  const r = rig();
  intent(r.platform, 'AGENT_ASSISTED');
  r.platform.authorize({
    operationId: 'op_auth_1', intentId: 'int_0001', tenantId: 'tnt_alpha',
    amountMinor: TOTAL, scripted: 'TIMEOUT_AFTER_SEND',
  });
  // The provider's record exists; the platform has no reference for it, so
  // the callback has to be joined before anything may be applied.
  const rec = r.provider.allApproved()[0]!;
  const first = r.platform.handleCallback({
    objectId: rec.objectId, eventType: 'payment.authorized',
    providerRef: rec.providerRef, amountMinor: TOTAL,
  });
  const duplicate = r.platform.handleCallback({
    objectId: rec.objectId, eventType: 'payment.authorized',
    providerRef: rec.providerRef, amountMinor: TOTAL,
  });
  const conflicting = r.platform.handleCallback({
    objectId: rec.objectId, eventType: 'payment.authorized',
    providerRef: rec.providerRef, amountMinor: TOTAL - 1,
  });
  const cap = r.platform.capture({
    operationId: 'op_cap_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: TOTAL,
  });
  return finish(
    'ambiguous-timeout-callback',
    'The same ambiguity resolved by a callback, with a duplicate and a conflict behind it.',
    r,
    [
      `first callback: ${first.reason}`,
      `duplicate callback: ${duplicate.reason}`,
      `conflicting callback: ${conflicting.reason}`,
      `exceptions raised: ${r.platform.exceptions.length}`,
      `capture: ${cap.customerAnswer}`,
    ],
    true,
  );
}

export function partialCaptureAndRefund(): ScenarioResult {
  const r = rig();
  intent(r.platform, 'AGENT_ASSISTED');
  r.platform.authorize({
    operationId: 'op_auth_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: TOTAL,
  });
  const first = r.platform.capture({
    operationId: 'op_cap_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: 3000,
  });
  const second = r.platform.capture({
    operationId: 'op_cap_2', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: 1599,
  });
  const over = r.platform.capture({
    operationId: 'op_cap_3', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: 100,
  });
  const refund = r.platform.refund({
    operationId: 'op_ref_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: 1000,
  });
  const overRefund = r.platform.refund({
    operationId: 'op_ref_2', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: 9999,
  });
  return finish(
    'partial-capture-and-refund',
    'Two partial captures, a third refused, a partial refund, an over-refund refused.',
    r,
    [
      `capture 3000: ${first.customerAnswer}`,
      `capture 1599: ${second.customerAnswer}`,
      `capture 100 over authorised: ${over.reason}`,
      `refund 1000: ${refund.customerAnswer}`,
      `refund 9999 over captured: ${overRefund.reason}`,
    ],
    true,
  );
}

export function fullReversal(): ScenarioResult {
  const r = rig();
  intent(r.platform, 'POINT_OF_SALE');
  r.platform.authorize({
    operationId: 'op_auth_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: TOTAL,
  });
  r.platform.capture({
    operationId: 'op_cap_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: TOTAL,
  });
  const rev = r.platform.reverse({
    operationId: 'op_rev_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: TOTAL,
  });
  return finish(
    'full-reversal',
    'A reversal is a new operation with its own identity and its own postings.',
    r,
    [`reversal: ${rev.customerAnswer}`, `balanced: ${r.platform.ledger.isBalanced('op_rev_1')}`],
    true,
  );
}

export function settlementMismatch(): ScenarioResult {
  const r = rig();
  intent(r.platform, 'WEB_CHECKOUT');
  r.platform.authorize({
    operationId: 'op_auth_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: TOTAL,
  });
  r.platform.capture({
    operationId: 'op_cap_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: TOTAL,
  });
  const captureRef = r.provider.allApproved().find((x) => x.operationKind === 'CAPTURE')!.providerRef;
  return finish(
    'settlement-mismatch',
    'The provider file disagrees with the platform by one minor unit.',
    r,
    [`corrupted line: ${captureRef}`],
    true,
    { [captureRef]: TOTAL - 1 },
  );
}

export function restartMidOperation(): ScenarioResult {
  const clock = makeClock();
  const provider = new ProviderSimulator();
  const before = new PaymentPlatform({ clock, provider });
  before.createIntent({
    intentId: 'int_0001', tenantId: 'tnt_alpha', channel: 'WEB_CHECKOUT',
    currency: 'EUR', allocations: ALLOCATIONS, tokenRef: 'tok_synthetic_7f21',
  });
  const auth = before.authorize({
    operationId: 'op_auth_1', intentId: 'int_0001', tenantId: 'tnt_alpha',
    amountMinor: TOTAL, scripted: 'TIMEOUT_AFTER_SEND',
  });
  // The process dies here. The durable stores survive; the memory does not.
  const after = new PaymentPlatform({ clock, resumeFrom: before });
  const resolved = after.reconcileUnknown('op_auth_1');
  const cap = after.capture({
    operationId: 'op_cap_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: TOTAL,
  });
  const r: Rig = { clock, provider, platform: after };
  return finish(
    'restart-mid-operation',
    'The process restarts while an operation is unresolved, and converges.',
    r,
    [
      `before restart: ${auth.customerAnswer}`,
      `after restart: ${resolved.customerAnswer}`,
      `capture: ${cap.customerAnswer}`,
    ],
    true,
  );
}

export function crossTenantDenied(): ScenarioResult {
  const r = rig();
  intent(r.platform, 'WEB_CHECKOUT');
  r.platform.authorize({
    operationId: 'op_auth_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: TOTAL,
  });
  const other = r.platform.capture({
    operationId: 'op_cap_x', intentId: 'int_0001', tenantId: 'tnt_beta', amountMinor: TOTAL,
  });
  const read = r.platform.readOperational('int_0001', 'tnt_beta');
  return finish(
    'cross-tenant-denied',
    'A second tenant asks for the first tenant payment, by command and by read.',
    r,
    [`capture as tnt_beta: ${other.reason}`, `read as tnt_beta: ${read === null ? 'denied' : 'SERVED'}`],
    false,
  );
}

export const SCENARIOS: readonly (() => ScenarioResult)[] = [
  webCheckoutHappy,
  posDecline,
  timeoutBeforeSend,
  ambiguousTimeoutLookup,
  ambiguousTimeoutCallback,
  partialCaptureAndRefund,
  fullReversal,
  settlementMismatch,
  restartMidOperation,
  crossTenantDenied,
];
