/**
 * Domain types for the integrated payment-platform reference.
 *
 * Deliberately small. Every component this module integrates is specified in
 * depth by another article in the series; what lives here is the part that
 * only exists once they are assembled, which is the seam between them.
 *
 * Node's type stripping does not support parameter properties or enums, so
 * every type below is a plain interface or a string-literal union.
 */

export type Channel = 'WEB_CHECKOUT' | 'POINT_OF_SALE' | 'AGENT_ASSISTED';

/** The four authorities named by the authority map. */
export type Authority =
  | 'operational'
  | 'provider-evidence'
  | 'accounting'
  | 'reporting';

/** Platform components that may write. Used to detect authority violations. */
export type Component =
  | 'payment-api'
  | 'provider-adapter'
  | 'ledger'
  | 'settlement'
  | 'reporting'
  | 'card-vault';

/** Operations are the unit of identity. Each is a separate business operation. */
export type OperationKind =
  | 'AUTHORIZE'
  | 'CAPTURE'
  | 'REFUND'
  | 'REVERSE'
  | 'VOID';

/**
 * Operation lifecycle. Article 13 owns durable state machines; this module
 * carries the smallest machine the integration needs and cites that article
 * for leases, timers and version migration.
 */
export type OperationState =
  | 'RECEIVED'
  | 'IN_FLIGHT'
  | 'SUCCEEDED'
  | 'DECLINED_FINAL'
  | 'OUTCOME_UNKNOWN';

/** Customer-visible intent status. A different machine from the one above. */
export type IntentStatus =
  | 'CREATED'
  | 'AUTHORIZED'
  | 'PARTIALLY_CAPTURED'
  | 'CAPTURED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'REVERSED'
  | 'CANCELLED'
  | 'FAILED';

export type ProviderOutcome =
  | 'APPROVED'
  | 'DECLINED'
  | 'TIMEOUT_BEFORE_SEND'
  | 'TIMEOUT_AFTER_SEND';

export type PostingDirection = 'DEBIT' | 'CREDIT';

export interface Allocation {
  allocationId: string;
  purpose: string;
  amountMinor: number;
}

export interface PaymentIntent {
  intentId: string;
  tenantId: string;
  channel: Channel;
  currency: string;
  amountMinor: number;
  allocations: Allocation[];
  /** The region whose operational store is authoritative for this intent. */
  authorityRegion: string;
  /** Synthetic token reference. Never a card number; see docs/MODEL.md. */
  tokenRef: string;
  status: IntentStatus;
  capturedMinor: number;
  refundedMinor: number;
}

export interface Operation {
  operationId: string;
  tenantId: string;
  intentId: string;
  kind: OperationKind;
  amountMinor: number;
  /** Canonical hash of the request parameters. Article 12 owns the contract. */
  requestHash: string;
  state: OperationState;
  providerRef: string | null;
}

export interface ProviderEffect {
  providerRef: string;
  /** The provider's own object id, which is what its callbacks carry. */
  objectId: string;
  kind: OperationKind;
  amountMinor: number;
  currency: string;
  outcome: 'APPROVED' | 'DECLINED';
  endpointRegion: string;
}

export interface Posting {
  postingId: string;
  operationId: string;
  account: string;
  direction: PostingDirection;
  amountMinor: number;
  currency: string;
}

export interface SettlementLine {
  providerRef: string;
  grossMinor: number;
  feeMinor: number;
  netMinor: number;
  currency: string;
}

export interface ReconciliationException {
  code: string;
  providerRef: string;
  detail: string;
}

/** One declared transition. The lifecycle spec is data, not control flow. */
export interface Transition {
  from: OperationState;
  to: OperationState;
}

/**
 * One row of the authority map: who owns a field, who may hold a copy, and
 * how long that copy is allowed to be behind before a read of it is a defect.
 */
export interface AuthorityRule {
  field: string;
  owner: Authority;
  writer: Component;
  /** Milliseconds a non-authoritative reader may lag. 0 means no copy allowed. */
  divergenceWindowMs: number;
}
