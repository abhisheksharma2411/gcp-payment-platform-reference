/**
 * Negative controls.
 *
 * Twelve deliberate defects, one per seam code. Each control must produce its
 * declared code AND NO OTHERS; a control that reddens half the auditor proves
 * nothing about which check is doing work. That requirement is enforced by
 * `tests/seams.test.ts` and reported by `make seams`.
 *
 * The thirteenth entry is a control that is REQUIRED TO BE REJECTED. It breaks
 * five things at once and is kept here as a worked example of evidence that
 * does not discriminate. The practice of shipping one is taken from the event
 * -lineage verifier in Article 17.
 *
 * Control 11 is different from the rest and is the one worth reading. It does
 * not break a seam; it breaks the LEDGER, in a way the ledger's own balance
 * invariant cannot see, and records that fact alongside the finding.
 */
import { makeClock } from './clock.ts';
import { PaymentPlatform, type Mutations } from './platform.ts';
import { ProviderSimulator } from './provider.ts';
import { auditSeams, codesOf } from './seams.ts';
import { buildSettlementFile, ingestSettlement } from './settlement.ts';
import type { Allocation } from './types.ts';

const ALLOCATIONS: Allocation[] = [
  { allocationId: 'alloc_goods', purpose: 'goods', amountMinor: 3000 },
  { allocationId: 'alloc_shipping', purpose: 'shipping', amountMinor: 1599 },
];
const TOTAL = 4599;

export interface ControlResult {
  name: string;
  expected: string[];
  actual: string[];
  exact: boolean;
  note: string;
  /** Set only by the independence control. */
  ledgerSaysBalanced?: boolean;
  /** True for a control whose evidence must be rejected. */
  rejected?: boolean;
}

interface Built {
  platform: PaymentPlatform;
  provider: ProviderSimulator;
  clock: ReturnType<typeof makeClock>;
}

function build(mutations: Mutations = {}): Built {
  const clock = makeClock();
  const provider = new ProviderSimulator();
  const platform = new PaymentPlatform({ clock, provider, mutations });
  platform.createIntent({
    intentId: 'int_0001',
    tenantId: 'tnt_alpha',
    channel: 'WEB_CHECKOUT',
    currency: 'EUR',
    allocations: ALLOCATIONS,
    tokenRef: 'tok_synthetic_7f21',
  });
  return { platform, provider, clock };
}

function authorise(b: Built): void {
  b.platform.authorize({
    operationId: 'op_auth_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: TOTAL,
  });
}

function captureFull(b: Built): void {
  b.platform.capture({
    operationId: 'op_cap_1', intentId: 'int_0001', tenantId: 'tnt_alpha', amountMinor: TOTAL,
  });
}

function settle(b: Built, skipException = false): void {
  const file = buildSettlementFile(b.provider);
  ingestSettlement(b.platform, b.clock, file, { skipException });
}

function result(name: string, expected: string[], b: Built, note: string): ControlResult {
  const actual = codesOf(auditSeams(b.platform.trace));
  const exact =
    actual.length === expected.length && expected.every((c, i) => actual[i] === c);
  return { name, expected: [...expected].sort(), actual, exact, note };
}

export function controlAuthorityViolation(): ControlResult {
  const b = build({ wrongWriterForPosting: true });
  authorise(b); captureFull(b); settle(b);
  return result('authority-violation', ['S01_AUTHORITY_WRITE_VIOLATION'], b,
    'the reporting component writes a posting the ledger owns');
}

export function controlUnresolvedCallback(): ControlResult {
  const b = build({ skipCallbackResolution: true });
  b.platform.authorize({
    operationId: 'op_auth_1', intentId: 'int_0001', tenantId: 'tnt_alpha',
    amountMinor: TOTAL, scripted: 'TIMEOUT_AFTER_SEND',
  });
  const rec = b.provider.allApproved()[0]!;
  b.platform.handleCallback({
    objectId: rec.objectId, eventType: 'payment.authorized',
    providerRef: rec.providerRef, amountMinor: TOTAL,
  });
  settle(b);
  return result('unresolved-callback', ['S02_UNRESOLVED_PROVIDER_REFERENCE'], b,
    'the callback path applies before it joins');
}

export function controlPostingWithoutEvidence(): ControlResult {
  const b = build();
  authorise(b); captureFull(b);
  b.platform.postWithoutEvidence('op_ghost_1', 'EUR', TOTAL);
  settle(b);
  return result('posting-without-evidence', ['S03_POSTING_WITHOUT_EVIDENCE'], b,
    'money recorded for an operation no provider ever saw');
}

export function controlEvidenceWithoutPosting(): ControlResult {
  const b = build({ skipPostingOnCapture: true });
  authorise(b); captureFull(b); settle(b);
  return result('evidence-without-posting', ['S04_EVIDENCE_WITHOUT_POSTING'], b,
    'an approved capture that never reached the books');
}

export function controlStaleRead(): ControlResult {
  const b = build({ staleReportingRead: true });
  authorise(b); captureFull(b);
  b.platform.readReporting('int_0001', 'tnt_alpha');
  settle(b);
  return result('stale-read', ['S05_STALE_READ_BEYOND_WINDOW'], b,
    'the reporting copy read sixty seconds behind a fifteen-second window');
}

export function controlUnbalancedJournal(): ControlResult {
  const b = build({ unbalancedPosting: true });
  authorise(b); captureFull(b); settle(b);
  return result('unbalanced-journal', ['S06_UNBALANCED_JOURNAL'], b,
    'one leg of a posting pair dropped');
}

export function controlIllegalTransition(): ControlResult {
  const b = build({ allowIllegalTransition: true });
  authorise(b);
  b.platform.forceOperationState('op_auth_1', 'IN_FLIGHT');
  settle(b);
  return result('illegal-transition', ['S07_ILLEGAL_LIFECYCLE_TRANSITION'], b,
    'an operation leaves a terminal state');
}

export function controlCrossTenantRead(): ControlResult {
  const b = build({ allowCrossTenant: true });
  authorise(b); captureFull(b);
  b.platform.readOperational('int_0001', 'tnt_beta');
  settle(b);
  return result('cross-tenant-read', ['S08_CROSS_TENANT_ACCESS'], b,
    'one tenant served another tenant record');
}

export function controlCardholderDataLeak(): ControlResult {
  const b = build({ leakCardholderData: true });
  authorise(b); captureFull(b); settle(b);
  return result('cardholder-data-leak', ['S09_CARDHOLDER_DATA_OUTSIDE_VAULT'], b,
    'an account-number-shaped value written outside the vault');
}

export function controlSettlementUnexplained(): ControlResult {
  const b = build();
  authorise(b); captureFull(b); settle(b, true);
  return result('settlement-unexplained', ['S10_SETTLEMENT_UNEXPLAINED'], b,
    'a settlement line nobody decided about');
}

/**
 * The independence control.
 *
 * The ledger truncates every amount to whole currency units. Both legs of
 * every pair move together, so the ledger's own balance invariant -- which
 * shares `signedMinor` with the code that wrote the postings -- stays green.
 * The seam auditor compares the postings with the command that caused them,
 * which the ledger has never seen, and goes red.
 */
export function controlPostedAmountMismatch(): ControlResult {
  const b = build({ truncateLedgerAmounts: true });
  authorise(b); captureFull(b); settle(b);
  const r = result('posted-amount-mismatch', ['S11_POSTED_AMOUNT_MISMATCH'], b,
    'the ledger balance invariant cannot see a symmetric error');
  r.ledgerSaysBalanced = b.platform.ledger.isBalanced('op_cap_1');
  return r;
}

export function controlUnrecordedProviderEffect(): ControlResult {
  const b = build({ failoverRegionOnRetry: true });
  authorise(b);
  // A PARTIAL capture, deliberately. A full one would be refused by the
  // provider's own capture-cannot-exceed-authorised rule, and the platform
  // would be saved by an accounting rule it does not own. See ADR-003.
  b.platform.capture({
    operationId: 'op_cap_1', intentId: 'int_0001', tenantId: 'tnt_alpha',
    amountMinor: 2000, scripted: 'TIMEOUT_AFTER_SEND',
  });
  b.platform.reconcileUnknown('op_cap_1');
  settle(b);
  return result('unrecorded-provider-effect', ['S12_UNRECORDED_PROVIDER_EFFECT'], b,
    'a retry sent to a second provider region charges twice');
}

/**
 * Required to be REJECTED as evidence. Five defects at once; the auditor goes
 * red everywhere and nothing is learned about which check found what.
 */
export function controlEverythingBroken(): ControlResult {
  const b = build({
    wrongWriterForPosting: true,
    unbalancedPosting: true,
    staleReportingRead: true,
    allowCrossTenant: true,
    leakCardholderData: true,
  });
  authorise(b); captureFull(b);
  b.platform.readReporting('int_0001', 'tnt_alpha');
  b.platform.readOperational('int_0001', 'tnt_beta');
  settle(b);
  const actual = codesOf(auditSeams(b.platform.trace));
  return {
    name: 'everything-broken',
    expected: [],
    actual,
    exact: false,
    rejected: true,
    note: 'rejected: too blunt to attribute any finding to any defect',
  };
}

export const CONTROLS: readonly (() => ControlResult)[] = [
  controlAuthorityViolation,
  controlUnresolvedCallback,
  controlPostingWithoutEvidence,
  controlEvidenceWithoutPosting,
  controlStaleRead,
  controlUnbalancedJournal,
  controlIllegalTransition,
  controlCrossTenantRead,
  controlCardholderDataLeak,
  controlSettlementUnexplained,
  controlPostedAmountMismatch,
  controlUnrecordedProviderEffect,
];
