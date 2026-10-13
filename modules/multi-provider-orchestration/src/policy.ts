// The routing policy. Versioned, deterministic, and auditable.
//
// Deterministic matters for a reason that is easy to miss: if the same request
// can route to a different provider on a retry, then a retry is a second
// operation at a second provider, and every guarantee above this layer is
// gone.

import { check } from "./capability.ts";
import type { HealthRegistry } from "./health.ts";
import type { CapabilityContract, PaymentRequest, RoutingDecision } from "./types.ts";

export interface PolicyWeights {
  readonly costPerMille: Readonly<Record<string, number>>;
  readonly preference: Readonly<Record<string, number>>;
}

export interface RoutingPolicy {
  readonly version: string;
  readonly weights: PolicyWeights;
}

export const POLICY_2026_10_1: RoutingPolicy = {
  version: "policy-2026.10.1",
  weights: {
    costPerMille: { "acquirer-a": 12, "acquirer-b": 9 },
    preference: { "acquirer-a": 0, "acquirer-b": 0 },
  },
};

/**
 * Choose a provider, and record why every candidate was kept or dropped.
 *
 * Order is fixed: capability, then circuit, then score. Capability first
 * because a healthy provider that cannot take the currency is not a candidate,
 * and scoring it wastes the explanation a reader of the audit needs.
 *
 * Ties break on provider name, not on map order, so the decision does not
 * depend on how the registry was built.
 */
export function route(
  request: PaymentRequest,
  contracts: readonly CapabilityContract[],
  health: HealthRegistry,
  policy: RoutingPolicy,
  nowMs: number,
): RoutingDecision {
  const considered: RoutingDecision["considered"][number][] = [];
  const eligible: { provider: string; score: number }[] = [];

  for (const c of [...contracts].sort((x, y) => x.provider.localeCompare(y.provider))) {
    const cap = check(c, request);
    if (!cap.eligible) {
      considered.push({ provider: c.provider, eligible: false, reason: cap.reason });
      continue;
    }
    if (!health.admits(c.provider, nowMs)) {
      considered.push({
        provider: c.provider,
        eligible: false,
        reason: `circuit ${health.state(c.provider, nowMs)}`,
      });
      continue;
    }
    const score =
      (policy.weights.costPerMille[c.provider] ?? 0) -
      (policy.weights.preference[c.provider] ?? 0);
    considered.push({ provider: c.provider, eligible: true, reason: "eligible", score });
    eligible.push({ provider: c.provider, score });
  }

  eligible.sort((a, b) => (a.score - b.score) || a.provider.localeCompare(b.provider));

  return {
    operationId: request.operationId,
    policyVersion: policy.version,
    chosen: eligible[0]?.provider ?? null,
    considered,
    atMs: nowMs,
  };
}
