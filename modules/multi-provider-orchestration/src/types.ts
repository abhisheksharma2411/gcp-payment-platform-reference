// Domain types for multi-provider payment orchestration.
//
// Local and deterministic. Not a client for any payment provider, and no
// provider's real API, fee schedule or capability set is reproduced here.
// Every modelled behaviour is recorded in ../docs/MODEL.md.

/** What a provider can actually do. The contract the router reads. */
export interface CapabilityContract {
  readonly provider: string;
  readonly methods: readonly string[];
  readonly currencies: readonly string[];
  readonly countries: readonly string[];
  /** Whether authorization and capture can be separated. */
  readonly separateCapture: boolean;
  readonly refunds: boolean;
  /** Whether a token minted here can be presented to another provider. */
  readonly tokensPortable: boolean;
  /** The provider honours an idempotency key the caller supplies. */
  readonly honoursIdempotencyKey: boolean;
  /** A lookup exists to resolve an unknown outcome. Without it, an unknown
   *  outcome can only be settled by reconciliation on the next statement. */
  readonly supportsQuery: boolean;
  readonly timeoutMs: number;
}

export interface PaymentRequest {
  readonly operationId: string;
  readonly businessRef: string;
  readonly method: string;
  readonly currency: string;
  readonly country: string;
  readonly amountMinor: number;
  readonly needsSeparateCapture?: boolean;
}

/**
 * What happened on one attempt against one provider.
 *
 * The distinction that matters is not success versus failure. It is whether
 * the request can be proven **not** to have reached the provider. Everything
 * about safe failover follows from that single bit.
 */
export type AttemptOutcome =
  /** Never left us: capability mismatch, open circuit, local refusal. */
  | "NOT_SENT"
  /** The provider answered and said no. A decline is an answer. */
  | "DECLINED"
  /** The provider answered and said yes. */
  | "AUTHORIZED"
  /** We sent it and do not know. The dangerous one. */
  | "UNKNOWN";

export interface Attempt {
  readonly provider: string;
  readonly outcome: AttemptOutcome;
  /** The key presented to this provider. Provider-scoped by construction. */
  readonly providerKey: string;
  /** Present only when the provider answered. */
  readonly providerRef?: string;
  /** The provider's own code, preserved rather than flattened. */
  readonly rawCode?: string;
  /** Our normalised reading of `rawCode`. */
  readonly normalisedReason?: string;
  readonly atMs: number;
}

/** Why the router chose what it chose. Written on every decision. */
export interface RoutingDecision {
  readonly operationId: string;
  readonly policyVersion: string;
  readonly chosen: string | null;
  /** Every provider considered, and why it was kept or dropped. */
  readonly considered: readonly {
    readonly provider: string;
    readonly eligible: boolean;
    readonly reason: string;
    readonly score?: number;
  }[];
  readonly atMs: number;
}

export type FailoverVerdict =
  | "SAFE"               // the attempt provably did not reach the provider
  | "BLOCKED_UNKNOWN"    // it may have been accepted; reconciliation first
  | "BLOCKED_AUTHORIZED" // it succeeded; there is nothing to fail over
  | "ALLOWED_DECLINED";  // the provider answered no; cascading is a policy choice

export interface Tally {
  requests: number;
  attempts: number;
  authorizations: number;
  failoversAllowed: number;
  failoversBlocked: number;
}
