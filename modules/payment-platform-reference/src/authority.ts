/**
 * The authority map, and the operation lifecycle, as data.
 *
 * Both are declarations that the seam auditor reads. Neither is reachable
 * from the code paths they govern, which is deliberate: a rule that the
 * implementation computes for itself is a rule the implementation cannot
 * violate, and therefore a rule nothing is checking.
 *
 * `divergenceWindowMs` is the part that only appears once components are
 * integrated. Four stores hold four answers about one payment and they are
 * all correct; what has to be declared is how long they are allowed to
 * disagree before a reader acting on the stale one is making a mistake.
 *
 * The 15000 for the reporting copy is not an arbitrary number. Spanner's
 * instance-configuration guidance for multi-region reads is to "use
 * staleness of at least 15 seconds", so a reporting read that is fresher
 * than that is not available by construction. The platform does not get to
 * choose a smaller window than the platform underneath it offers.
 */
import type { AuthorityRule, Transition } from './types.ts';

export const AUTHORITY_MAP: readonly AuthorityRule[] = [
  { field: 'intent.status', owner: 'operational', writer: 'payment-api', divergenceWindowMs: 0 },
  { field: 'intent.capturedMinor', owner: 'operational', writer: 'payment-api', divergenceWindowMs: 0 },
  { field: 'intent.refundedMinor', owner: 'operational', writer: 'payment-api', divergenceWindowMs: 0 },
  { field: 'operation.state', owner: 'operational', writer: 'payment-api', divergenceWindowMs: 0 },
  { field: 'operation.providerRef', owner: 'provider-evidence', writer: 'provider-adapter', divergenceWindowMs: 0 },
  { field: 'provider.effect', owner: 'provider-evidence', writer: 'provider-adapter', divergenceWindowMs: 0 },
  { field: 'ledger.posting', owner: 'accounting', writer: 'ledger', divergenceWindowMs: 0 },
  { field: 'settlement.line', owner: 'provider-evidence', writer: 'settlement', divergenceWindowMs: 0 },
  { field: 'reporting.intentStatus', owner: 'reporting', writer: 'reporting', divergenceWindowMs: 15000 },
  { field: 'reporting.balance', owner: 'reporting', writer: 'reporting', divergenceWindowMs: 15000 },
  { field: 'vault.tokenRef', owner: 'operational', writer: 'card-vault', divergenceWindowMs: 0 },
];

export function ruleFor(field: string): AuthorityRule | undefined {
  return AUTHORITY_MAP.find((r) => r.field === field);
}

/**
 * The operation state machine. Article 13 owns durable state machines; this
 * is the smallest one the integration needs, and the only thing novel about
 * it is that OUTCOME_UNKNOWN has two outbound edges, both of which are
 * reached by reconciliation rather than by the caller.
 */
export const OPERATION_TRANSITIONS: readonly Transition[] = [
  { from: 'RECEIVED', to: 'IN_FLIGHT' },
  { from: 'IN_FLIGHT', to: 'SUCCEEDED' },
  { from: 'IN_FLIGHT', to: 'DECLINED_FINAL' },
  { from: 'IN_FLIGHT', to: 'OUTCOME_UNKNOWN' },
  { from: 'RECEIVED', to: 'DECLINED_FINAL' },
  { from: 'OUTCOME_UNKNOWN', to: 'SUCCEEDED' },
  { from: 'OUTCOME_UNKNOWN', to: 'DECLINED_FINAL' },
];

export function isLegalTransition(from: string, to: string): boolean {
  return OPERATION_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/** Terminal states. Nothing leaves them; the auditor enforces that. */
export const TERMINAL_STATES: readonly string[] = ['SUCCEEDED', 'DECLINED_FINAL'];
