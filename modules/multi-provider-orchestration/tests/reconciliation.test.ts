// What happens to an operation the provider left unknown, and what happens to
// a policy change while that operation is still in flight.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator.ts";
import { SimulatedProvider, ACQUIRER_A, ACQUIRER_B, type ProviderMode } from "../src/providers.ts";
import { POLICY_2026_10_1, type RoutingPolicy } from "../src/policy.ts";
import type { PaymentRequest } from "../src/types.ts";

const T0 = Date.UTC(2026, 0, 5);
const req = (o: Partial<PaymentRequest> = {}): PaymentRequest => ({
  operationId: "op-1", businessRef: "order-1", method: "card",
  currency: "EUR", country: "DE", amountMinor: 2500, ...o,
});
const build = (mode?: (p: string, op: string, i: number) => ProviderMode) =>
  new Orchestrator(
    [new SimulatedProvider(ACQUIRER_A), new SimulatedProvider(ACQUIRER_B)],
    { policy: POLICY_2026_10_1, mode },
  );

test("R1 reconciliation CLEARS an unknown outcome where a lookup exists", () => {
  // acquirer-a supports a query. Force the route there by asking for a
  // currency only it takes, then time it out.
  const o = build(() => "timeout");
  const r = o.submit(req({ currency: "USD", country: "US" }), T0);

  assert.equal(r.settled, "UNRESOLVED");
  assert.equal(r.awaitingReconciliation?.provider, "acquirer-a");

  const outcome = o.reconcile("op-1", "acquirer-a", T0 + 60_000);
  assert.equal(outcome.kind, "CLEARED");
  assert.equal(outcome.kind === "CLEARED" && outcome.attempt.outcome, "AUTHORIZED");
  // It really had authorised. The answer was lost, not the authorization.
  assert.equal(o.tally.authorizations, 1);
});

test("R2 reconciliation ESCALATES where the provider offers no lookup", () => {
  assert.equal(ACQUIRER_B.supportsQuery, false);
  const o = build(() => "timeout");
  const r = o.submit(req({ currency: "SEK", country: "SE" }), T0);

  assert.equal(r.awaitingReconciliation?.provider, "acquirer-b");

  const outcome = o.reconcile("op-1", "acquirer-b", T0 + 60_000);
  assert.equal(outcome.kind, "ESCALATED");
  if (outcome.kind !== "ESCALATED") return;
  assert.equal(outcome.providerKey, "acquirer-b:op-1");
  assert.match(outcome.reason, /no lookup/);
  // Nothing was invented to make the number look better.
  assert.equal(o.tally.authorizations, 0);
});

test("R3 an escalation carries the provider and the key somebody needs", () => {
  const o = build(() => "timeout");
  o.submit(req({ currency: "SEK", country: "SE" }), T0);
  const outcome = o.reconcile("op-1", "acquirer-b", T0 + 60_000);
  assert.equal(outcome.kind === "ESCALATED" && outcome.provider, "acquirer-b");
});

test("P1 a policy change mid-flight does not re-route a started operation", () => {
  // acquirer-b is cheaper, so it wins under the shipped policy.
  const o = build(() => "timeout");
  const first = o.submit(req(), T0);
  assert.equal(first.attempts[0]!.provider, "acquirer-b");
  assert.equal(first.decisions[0]!.policyVersion, "policy-2026.10.1");

  // Deploy a policy that would reverse the preference.
  const next: RoutingPolicy = {
    version: "policy-2026.11.1",
    weights: { costPerMille: { "acquirer-a": 1, "acquirer-b": 99 }, preference: {} },
  };
  o.setPolicy(next);

  const retry = o.submit(req(), T0 + 1_000);
  assert.equal(
    retry.attempts[0]!.provider, "acquirer-b",
    "a started operation keeps its provider; re-routing it is a second payment",
  );
  // The new version governs the decision record, but not the provider.
  assert.equal(retry.decisions[0]!.policyVersion, "policy-2026.11.1");
  assert.deepEqual(retry.decisions[0]!.considered.map((c) => c.provider), ["acquirer-b"]);
});

test("P2 a fresh operation does follow the new policy", () => {
  const o = build(() => "authorize");
  o.setPolicy({
    version: "policy-2026.11.1",
    weights: { costPerMille: { "acquirer-a": 1, "acquirer-b": 99 }, preference: {} },
  });
  const r = o.submit(req({ operationId: "op-2" }), T0);
  assert.equal(r.attempts[0]!.provider, "acquirer-a");
});

test("P3 every decision records the version that made it", () => {
  const o = build(() => "authorize");
  o.submit(req({ operationId: "op-3" }), T0);
  o.setPolicy({ version: "policy-2026.11.1", weights: { costPerMille: {}, preference: {} } });
  o.submit(req({ operationId: "op-4" }), T0 + 1_000);

  assert.deepEqual(
    o.audit().map((d) => `${d.operationId}@${d.policyVersion}`),
    ["op-3@policy-2026.10.1", "op-4@policy-2026.11.1"],
  );
});
