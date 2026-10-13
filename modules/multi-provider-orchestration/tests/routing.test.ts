import { test } from "node:test";
import assert from "node:assert/strict";
import { route, POLICY_2026_10_1 } from "../src/policy.ts";
import { HealthRegistry } from "../src/health.ts";
import { ACQUIRER_A, ACQUIRER_B } from "../src/providers.ts";
import type { PaymentRequest } from "../src/types.ts";

const T0 = Date.UTC(2026, 0, 5);
const CONTRACTS = [ACQUIRER_A, ACQUIRER_B];
const req = (o: Partial<PaymentRequest> = {}): PaymentRequest => ({
  operationId: "op-1", businessRef: "order-1", method: "card",
  currency: "EUR", country: "DE", amountMinor: 2500, ...o,
});

test("R1 the same request routes the same way every time", () => {
  // If a retry can route elsewhere, a retry is a second operation at a second
  // provider, and every guarantee above this layer is gone.
  const h = new HealthRegistry();
  const first = route(req(), CONTRACTS, h, POLICY_2026_10_1, T0);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(route(req(), CONTRACTS, h, POLICY_2026_10_1, T0 + i).chosen, first.chosen);
  }
});

test("R2 the decision is independent of registry order", () => {
  const h = new HealthRegistry();
  const a = route(req(), [ACQUIRER_A, ACQUIRER_B], h, POLICY_2026_10_1, T0);
  const b = route(req(), [ACQUIRER_B, ACQUIRER_A], h, POLICY_2026_10_1, T0);
  assert.equal(a.chosen, b.chosen);
});

test("R3 every candidate is recorded with a reason", () => {
  const d = route(req({ currency: "GBP" }), CONTRACTS, new HealthRegistry(), POLICY_2026_10_1, T0);
  assert.equal(d.considered.length, 2);
  const b = d.considered.find((c) => c.provider === "acquirer-b")!;
  assert.equal(b.eligible, false);
  assert.match(b.reason, /currency GBP/);
  assert.equal(d.chosen, "acquirer-a");
});

test("R4 the decision carries the policy version", () => {
  const d = route(req(), CONTRACTS, new HealthRegistry(), POLICY_2026_10_1, T0);
  assert.equal(d.policyVersion, "policy-2026.10.1");
});

test("R5 capability is checked before health", () => {
  // A provider that cannot take the currency is not a candidate, healthy or
  // not, and the audit should say so rather than reporting a circuit state.
  const h = new HealthRegistry();
  for (let i = 0; i < 5; i += 1) h.record("acquirer-b", "failure", T0);
  const d = route(req({ currency: "GBP" }), CONTRACTS, h, POLICY_2026_10_1, T0);
  const b = d.considered.find((c) => c.provider === "acquirer-b")!;
  assert.match(b.reason, /currency/, "capability reason should win over circuit state");
});

test("R6 an open circuit removes a provider and says which state", () => {
  const h = new HealthRegistry();
  for (let i = 0; i < 3; i += 1) h.record("acquirer-b", "failure", T0);
  const d = route(req(), CONTRACTS, h, POLICY_2026_10_1, T0);
  const b = d.considered.find((c) => c.provider === "acquirer-b")!;
  assert.equal(b.eligible, false);
  assert.match(b.reason, /circuit OPEN/);
  assert.equal(d.chosen, "acquirer-a");
});

test("R7 no eligible provider yields a null choice, not a throw", () => {
  const d = route(req({ currency: "JPY" }), CONTRACTS, new HealthRegistry(), POLICY_2026_10_1, T0);
  assert.equal(d.chosen, null);
  assert.ok(d.considered.every((c) => !c.eligible));
});

test("R8 cost ordering decides between two eligible providers", () => {
  const d = route(req(), CONTRACTS, new HealthRegistry(), POLICY_2026_10_1, T0);
  // acquirer-b is cheaper in the shipped policy.
  assert.equal(d.chosen, "acquirer-b");
});
