// Routing, attempting, and the one decision the whole module exists for:
// whether failing over to another provider is safe.
//
// The rule is short. Failover is safe only when the attempt can be proven not
// to have reached the provider. Everything else is a guess with somebody's
// money behind it.

import { route, type RoutingPolicy } from "./policy.ts";
import { HealthRegistry } from "./health.ts";
import { SimulatedProvider, normalise, type ProviderMode } from "./providers.ts";
import type {
  Attempt, CapabilityContract, FailoverVerdict, PaymentRequest,
  RoutingDecision, Tally,
} from "./types.ts";

export interface OrchestratorOptions {
  readonly policy: RoutingPolicy;
  /** What each provider does on a given attempt, by operation and index. */
  readonly mode?: (provider: string, operationId: string, attemptIndex: number) => ProviderMode;
  /**
   * Whether a decline at one provider may be re-offered to another. A policy
   * choice with real consequences, not a correctness question -- see ADR-002.
   */
  readonly cascadeDeclines?: boolean;
  /**
   * Negative controls only. Each removes one guard so a test can be shown to
   * go red when it is gone. A suite that stays green with a guard removed is
   * not testing the guard.
   */
  readonly mutation?: Mutation;
}

export type Mutation =
  /** Fail over after an UNKNOWN outcome. The double-charge. */
  | "allow-failover-after-unknown"
  /** Present one key to every provider instead of a provider-scoped one. */
  | "shared-key-across-providers"
  /** Count a decline as a health failure. */
  | "declines-open-circuit";

export const MUTATIONS: readonly Mutation[] = [
  "allow-failover-after-unknown",
  "shared-key-across-providers",
  "declines-open-circuit",
];

export interface OperationResult {
  readonly operationId: string;
  readonly decisions: readonly RoutingDecision[];
  readonly attempts: readonly Attempt[];
  readonly settled: "AUTHORIZED" | "DECLINED" | "UNRESOLVED" | "NO_ROUTE";
  /** Set when the operation ends unresolved and needs reconciliation. */
  readonly awaitingReconciliation?: { provider: string; providerKey: string };
}

/**
 * The failover decision, in one place.
 *
 * `NOT_SENT` is the only outcome that permits moving to another provider
 * without further thought, because it is the only one that proves the first
 * provider has nothing recorded.
 */
export function failoverVerdict(outcome: Attempt["outcome"]): FailoverVerdict {
  switch (outcome) {
    case "NOT_SENT": return "SAFE";
    case "UNKNOWN": return "BLOCKED_UNKNOWN";
    case "AUTHORIZED": return "BLOCKED_AUTHORIZED";
    case "DECLINED": return "ALLOWED_DECLINED";
  }
}

/**
 * The key presented to a provider.
 *
 * Scoped to the provider on purpose. The same operation reaching two providers
 * must present two different keys, because a key is a promise to one party
 * about one request, and reusing it across parties means nothing to either.
 */
export function providerKey(operationId: string, provider: string): string {
  return `${provider}:${operationId}`;
}

export class Orchestrator {
  readonly contracts: readonly CapabilityContract[];
  readonly providers: ReadonlyMap<string, SimulatedProvider>;
  readonly health: HealthRegistry;
  readonly options: OrchestratorOptions;
  readonly tally: Tally = {
    requests: 0, attempts: 0, authorizations: 0,
    failoversAllowed: 0, failoversBlocked: 0,
  };
  /** Sticky selection: an operation keeps the provider it first reached. */
  readonly #sticky = new Map<string, string>();
  readonly #audit: RoutingDecision[] = [];

  constructor(
    providers: readonly SimulatedProvider[],
    options: OrchestratorOptions,
    health = new HealthRegistry(),
  ) {
    this.providers = new Map(providers.map((p) => [p.contract.provider, p]));
    this.contracts = providers.map((p) => p.contract);
    this.health = health;
    this.options = options;
  }

  submit(request: PaymentRequest, nowMs: number): OperationResult {
    this.tally.requests += 1;
    const decisions: RoutingDecision[] = [];
    const attempts: Attempt[] = [];
    const excluded = new Set<string>();
    let at = nowMs;

    for (let i = 0; i < this.contracts.length + 1; i += 1) {
      // Sticky: once an operation has reached a provider, it stays there. A
      // retry that re-routes is a second operation somewhere else.
      const stuck = this.#sticky.get(request.operationId);
      const pool = this.contracts.filter(
        (c) => !excluded.has(c.provider) && (stuck === undefined || c.provider === stuck),
      );
      const decision = route(request, pool, this.health, this.options.policy, at);
      decisions.push(decision);
      this.#audit.push(decision);

      if (decision.chosen === null) {
        return {
          operationId: request.operationId,
          decisions, attempts,
          settled: attempts.length === 0 ? "NO_ROUTE" : "UNRESOLVED",
        };
      }

      const provider = this.providers.get(decision.chosen)!;
      const key = this.options.mutation === "shared-key-across-providers"
        ? request.operationId
        : providerKey(request.operationId, decision.chosen);
      const mode = this.options.mode?.(decision.chosen, request.operationId, i) ?? "authorize";
      const response = provider.call(key, mode, at);
      this.tally.attempts += 1;

      const attempt: Attempt = {
        provider: decision.chosen,
        outcome: response.outcome,
        providerKey: key,
        providerRef: response.providerRef,
        rawCode: response.rawCode,
        normalisedReason: normalise(response.rawCode),
        atMs: at,
      };
      attempts.push(attempt);

      // A decline is an answer, not a health signal. Counting it as failure
      // opens the circuit on a merchant whose customers are being refused for
      // good reasons -- and moves that traffic somewhere it is also refused.
      this.health.record(
        decision.chosen,
        response.outcome === "AUTHORIZED" ? "success"
          : response.outcome === "DECLINED"
            ? (this.options.mutation === "declines-open-circuit" ? "failure" : "neutral")
            : "failure",
        at,
      );

      const verdict = failoverVerdict(response.outcome);

      if (response.outcome === "AUTHORIZED") {
        this.tally.authorizations += 1;
        this.#sticky.set(request.operationId, decision.chosen);
        return { operationId: request.operationId, decisions, attempts, settled: "AUTHORIZED" };
      }

      if (verdict === "BLOCKED_UNKNOWN" && this.options.mutation !== "allow-failover-after-unknown") {
        this.tally.failoversBlocked += 1;
        this.#sticky.set(request.operationId, decision.chosen);
        return {
          operationId: request.operationId, decisions, attempts,
          settled: "UNRESOLVED",
          awaitingReconciliation: { provider: decision.chosen, providerKey: key },
        };
      }

      if (verdict === "ALLOWED_DECLINED" && !this.options.cascadeDeclines) {
        return { operationId: request.operationId, decisions, attempts, settled: "DECLINED" };
      }

      // SAFE, or a cascading decline. Move on and never return here.
      this.tally.failoversAllowed += 1;
      excluded.add(decision.chosen);
      at += 50;
    }

    return { operationId: request.operationId, decisions, attempts, settled: "UNRESOLVED" };
  }

  /**
   * Resolve an operation the provider left unknown.
   *
   * Possible only where the contract offers a lookup. Where it does not, the
   * operation stays unresolved until a statement arrives, and the article is
   * explicit that this is a capability difference rather than an engineering
   * shortcoming of the adapter.
   */
  resolve(operationId: string, provider: string, nowMs: number): Attempt | null {
    const p = this.providers.get(provider);
    if (p === undefined) return null;
    const found = p.lookup(providerKey(operationId, provider));
    if (found === null) return null;
    if (found.outcome === "AUTHORIZED") this.tally.authorizations += 1;
    return {
      provider, outcome: found.outcome,
      providerKey: providerKey(operationId, provider),
      providerRef: found.providerRef, rawCode: found.rawCode,
      normalisedReason: normalise(found.rawCode), atMs: nowMs,
    };
  }

  audit(): readonly RoutingDecision[] {
    return [...this.#audit];
  }
}
