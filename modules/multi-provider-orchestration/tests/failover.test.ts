// The decision the module exists for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator, failoverVerdict, providerKey } from "../src/orchestrator.ts";
import { SimulatedProvider, ACQUIRER_A, ACQUIRER_B, type ProviderMode } from "../src/providers.ts";
import { POLICY_2026_10_1 } from "../src/policy.ts";
import { HealthRegistry } from "../src/health.ts";
import type { PaymentRequest } from "../src/types.ts";

const T0 = Date.UTC(2026, 0, 5);
const req = (o: Partial<PaymentRequest> = {}): PaymentRequest => ({
  operationId: "op-1", businessRef: "order-1", method: "card",
  currency: "EUR", country: "DE", amountMinor: 2500, ...o,
});
const build = (mode?: (p: string, op: string, i: number) => ProviderMode, cascade = false) =>
  new Orchestrator(
    [new SimulatedProvider(ACQUIRER_A), new SimulatedProvider(ACQUIRER_B)],
    { policy: POLICY_2026_10_1, mode, cascadeDeclines: cascade },
  );

test("F1 only NOT_SENT permits failover without further thought", () => {
  assert.equal(failoverVerdict("NOT_SENT"), "SAFE");
  assert.equal(failoverVerdict("UNKNOWN"), "BLOCKED_UNKNOWN");
  assert.equal(failoverVerdict("AUTHORIZED"), "BLOCKED_AUTHORIZED");
  assert.equal(failoverVerdict("DECLINED"), "ALLOWED_DECLINED");
});

test("F2 a provider unavailable before send fails over safely", () => {
  const o = build((p) => (p === "acquirer-b" ? "unavailable" : "authorize"));
  const r = o.submit(req(), T0);
  assert.equal(r.settled, "AUTHORIZED");
  assert.deepEqual(r.attempts.map((a) => a.provider), ["acquirer-b", "acquirer-a"]);
  assert.equal(r.attempts[0]!.outcome, "NOT_SENT");
  assert.equal(o.tally.failoversAllowed, 1);
  assert.equal(o.tally.failoversBlocked, 0);
});

test("F3 a timeout after possible acceptance BLOCKS failover", () => {
  // The whole article in one test. The first provider may have authorised; a
  // second attempt elsewhere is how one payment becomes two.
  const o = build((p) => (p === "acquirer-b" ? "timeout" : "authorize"));
  const r = o.submit(req(), T0);
  assert.equal(r.settled, "UNRESOLVED");
  assert.equal(r.attempts.length, 1, "must not try the second provider");
  assert.equal(r.attempts[0]!.outcome, "UNKNOWN");
  assert.equal(o.tally.failoversBlocked, 1);
  assert.equal(o.tally.authorizations, 0);
  assert.deepEqual(r.awaitingReconciliation, {
    provider: "acquirer-b",
    providerKey: "acquirer-b:op-1",
  });
});

test("F4 a known decline is not a technical error", () => {
  const o = build(() => "decline");
  const r = o.submit(req(), T0);
  assert.equal(r.settled, "DECLINED");
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0]!.normalisedReason, "declined_by_issuer");
  assert.equal(r.attempts[0]!.rawCode, "DO_NOT_HONOUR", "the provider's own code is preserved");
});

test("F5 cascading a decline is a policy choice, and off by default", () => {
  const off = build(() => "decline", false).submit(req(), T0);
  assert.equal(off.attempts.length, 1);

  const on = build((p, _op, i) => (i === 0 ? "decline" : "authorize"), true).submit(req(), T0);
  assert.equal(on.attempts.length, 2);
  assert.equal(on.settled, "AUTHORIZED");
});

test("F6 the key presented to each provider is provider-scoped", () => {
  assert.equal(providerKey("op-1", "acquirer-a"), "acquirer-a:op-1");
  assert.notEqual(providerKey("op-1", "acquirer-a"), providerKey("op-1", "acquirer-b"));
  const o = build((p) => (p === "acquirer-b" ? "unavailable" : "authorize"));
  const r = o.submit(req(), T0);
  const keys = r.attempts.map((a) => a.providerKey);
  assert.equal(new Set(keys).size, keys.length, "one key per provider, never reused across them");
});

test("F7 an unknown outcome is resolvable only where the contract says so", () => {
  const o = build((p) => (p === "acquirer-a" ? "timeout" : "unavailable"));
  const r = o.submit(req({ currency: "GBP" }), T0);  // GBP excludes acquirer-b
  assert.equal(r.settled, "UNRESOLVED");

  // acquirer-a supports query, so the unknown can be settled.
  const resolved = o.resolve("op-1", "acquirer-a", T0 + 60_000);
  assert.ok(resolved);
  assert.equal(resolved.outcome, "AUTHORIZED");
  assert.equal(resolved.rawCode, "APPROVED");
});

test("F8 a provider without a lookup leaves the unknown unresolved", () => {
  const o = build(() => "timeout");
  const r = o.submit(req(), T0);
  assert.equal(r.awaitingReconciliation?.provider, "acquirer-b");
  // acquirer-b has supportsQuery: false. Nothing to ask.
  assert.equal(o.resolve("op-1", "acquirer-b", T0 + 60_000), null);
});

test("F9 selection is sticky once an operation has reached a provider", () => {
  const o = build((p, _op, i) => (i === 0 ? "timeout" : "authorize"));
  const first = o.submit(req(), T0);
  assert.equal(first.awaitingReconciliation?.provider, "acquirer-b");

  // A retry of the same operation must not wander to the other provider.
  const again = o.submit(req(), T0 + 1000);
  assert.ok(again.attempts.every((a) => a.provider === "acquirer-b"));
});

test("F10 no eligible provider settles as NO_ROUTE with an auditable reason", () => {
  const o = build();
  const r = o.submit(req({ currency: "JPY" }), T0);
  assert.equal(r.settled, "NO_ROUTE");
  assert.equal(r.attempts.length, 0);
  assert.equal(r.decisions[0]!.considered.length, 2);
  assert.ok(r.decisions[0]!.considered.every((c) => !c.eligible));
});

test("F11 a decline does not open the circuit", () => {
  // A merchant whose customers are being refused for good reasons must not
  // have its traffic moved somewhere it will also be refused.
  const health = new HealthRegistry();
  const o = new Orchestrator(
    [new SimulatedProvider(ACQUIRER_A), new SimulatedProvider(ACQUIRER_B)],
    { policy: POLICY_2026_10_1, mode: () => "decline" },
    health,
  );
  for (let i = 0; i < 10; i += 1) o.submit(req({ operationId: `op-${i}` }), T0 + i * 10);
  assert.equal(health.state("acquirer-b", T0 + 200), "CLOSED");
});
