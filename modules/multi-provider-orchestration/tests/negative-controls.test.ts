// A suite that stays green when a guard is removed is not testing the guard.
//
// Each mutation here deletes exactly one mechanism, and each must turn a named
// behaviour red. The last test guards the harness itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator, MUTATIONS, type Mutation } from "../src/orchestrator.ts";
import { SimulatedProvider, ACQUIRER_A, ACQUIRER_B } from "../src/providers.ts";
import { POLICY_2026_10_1 } from "../src/policy.ts";
import { HealthRegistry } from "../src/health.ts";
import { WebhookInbox, WEBHOOK_MUTATIONS } from "../src/webhook.ts";
import type { PaymentRequest } from "../src/types.ts";
import type { ProviderMode } from "../src/providers.ts";
import { TOKEN_MUTATIONS } from "../src/tokens.ts";

const T0 = Date.UTC(2026, 0, 5);
const req = (o: Partial<PaymentRequest> = {}): PaymentRequest => ({
  operationId: "op-1", businessRef: "order-1", method: "card",
  currency: "EUR", country: "DE", amountMinor: 2500, ...o,
});
const build = (
  mode?: (p: string, op: string, i: number) => ProviderMode,
  mutation?: Mutation,
  health = new HealthRegistry(),
) => new Orchestrator(
  [new SimulatedProvider(ACQUIRER_A), new SimulatedProvider(ACQUIRER_B)],
  { policy: POLICY_2026_10_1, mode, mutation },
  health,
);

test("N1 removing the unknown-outcome guard produces a double authorization", () => {
  // The failure the module exists to prevent, demonstrated rather than asserted.
  // acquirer-b times out having already authorised; the mutation lets the
  // operation move to acquirer-a, which authorises it again.
  const o = build((p) => (p === "acquirer-b" ? "timeout" : "authorize"), "allow-failover-after-unknown");
  const r = o.submit(req(), T0);

  assert.equal(r.attempts.length, 2, "the mutation lets it try the second provider");
  assert.equal(r.settled, "AUTHORIZED");

  // One payment, two providers holding an authorization.
  const inbox = new WebhookInbox();
  inbox.receive({ provider: "acquirer-b", eventId: "b-1", operationId: "op-1", rawCode: "APPROVED", atMs: T0 });
  inbox.receive({ provider: "acquirer-a", eventId: "a-1", operationId: "op-1", rawCode: "APPROVED", atMs: T0 });
  assert.deepEqual(inbox.doubleAuthorizations(), ["op-1"]);
});

test("N1b with the guard in place, the same scenario stops at one attempt", () => {
  const o = build((p) => (p === "acquirer-b" ? "timeout" : "authorize"));
  const r = o.submit(req(), T0);
  assert.equal(r.attempts.length, 1);
  assert.equal(r.settled, "UNRESOLVED");
});

test("N2 sharing one key across providers breaks provider-scoped identity", () => {
  const o = build((p) => (p === "acquirer-b" ? "unavailable" : "authorize"), "shared-key-across-providers");
  const r = o.submit(req(), T0);
  const keys = r.attempts.map((a) => a.providerKey);
  assert.equal(new Set(keys).size, 1, "the mutation presents one key to both");
  assert.equal(keys[0], "op-1", "and it is not provider-scoped");
});

test("N3 counting declines as failures opens the circuit on a refused merchant", () => {
  const health = new HealthRegistry();
  const o = build(() => "decline", "declines-open-circuit", health);
  for (let i = 0; i < 4; i += 1) o.submit(req({ operationId: `op-${i}` }), T0 + i * 10);
  assert.equal(health.state("acquirer-b", T0 + 100), "OPEN");

  // Without the mutation the same traffic leaves the circuit closed (F11).
  const clean = new HealthRegistry();
  const o2 = build(() => "decline", undefined, clean);
  for (let i = 0; i < 4; i += 1) o2.submit(req({ operationId: `op-${i}` }), T0 + i * 10);
  assert.equal(clean.state("acquirer-b", T0 + 100), "CLOSED");
});

test("N4 de-duplicating webhooks on the operation alone loses a provider's account", () => {
  const broken = new WebhookInbox("dedupe-on-operation-only");
  broken.receive({ provider: "acquirer-a", eventId: "a-1", operationId: "op-9", rawCode: "APPROVED", atMs: T0 });
  broken.receive({ provider: "acquirer-b", eventId: "b-1", operationId: "op-9", rawCode: "APPROVED", atMs: T0 });

  assert.equal(broken.acceptedCount, 1, "the second provider's event was discarded");
  assert.deepEqual(broken.doubleAuthorizations(), [],
    "and the double authorization is now invisible");

  const correct = new WebhookInbox();
  correct.receive({ provider: "acquirer-a", eventId: "a-1", operationId: "op-9", rawCode: "APPROVED", atMs: T0 });
  correct.receive({ provider: "acquirer-b", eventId: "b-1", operationId: "op-9", rawCode: "APPROVED", atMs: T0 });
  assert.deepEqual(correct.doubleAuthorizations(), ["op-9"]);
});

test("N5 every removable guard in the module is exercised by a named control", () => {
  // The registry this used to check held only the orchestrator's mutations,
  // so a guard removal added in webhook.ts or tokens.ts would not have failed
  // it. A completeness check covering one of three registries is not a
  // completeness check. The inventory now spans all three.
  const inventory = [
    ...MUTATIONS,
    ...WEBHOOK_MUTATIONS,
    ...TOKEN_MUTATIONS,
  ].sort();

  assert.deepEqual(inventory, [
    "allow-failover-after-unknown",   // N1  -> src/orchestrator.ts
    "declines-open-circuit",          // N3  -> src/orchestrator.ts
    "dedupe-on-operation-only",       // N4  -> src/webhook.ts
    "shared-key-across-providers",    // N2  -> src/orchestrator.ts
    "tokens-portable-across-providers", // NC-T -> src/tokens.ts
  ]);
  // Five guards, five controls. Adding a sixth anywhere fails here until it
  // has one.
  assert.equal(new Set(inventory).size, 5);
});

test("N6 the harness can report a failure", () => {
  // Guards the guard. If assertions were not being evaluated, every test above
  // would pass vacuously.
  assert.throws(() => {
    const o = build();
    const r = o.submit(req(), T0);
    assert.equal(r.settled, "NO_ROUTE");
  });
});
