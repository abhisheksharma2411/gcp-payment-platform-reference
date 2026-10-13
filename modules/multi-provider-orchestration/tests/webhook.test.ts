import { test } from "node:test";
import assert from "node:assert/strict";
import { WebhookInbox } from "../src/webhook.ts";

const T0 = Date.UTC(2026, 0, 5);
const w = (provider: string, eventId: string, rawCode = "APPROVED", operationId = "op-1") =>
  ({ provider, eventId, operationId, rawCode, atMs: T0 });

test("W1 a repeated event from one provider is suppressed", () => {
  const i = new WebhookInbox();
  assert.equal(i.receive(w("acquirer-a", "evt-1")), "ACCEPTED");
  assert.equal(i.receive(w("acquirer-a", "evt-1")), "DUPLICATE_EVENT");
  assert.equal(i.suppressedCount, 1);
  assert.equal(i.acceptedCount, 1);
});

test("W2 the same event id from two providers is TWO facts", () => {
  // Event ids are unique per provider only. De-duplicating on the id alone
  // discards one provider's account of its own attempt.
  const i = new WebhookInbox();
  assert.equal(i.receive(w("acquirer-a", "evt-1")), "ACCEPTED");
  assert.equal(i.receive(w("acquirer-b", "evt-1")), "ACCEPTED");
  assert.equal(i.acceptedCount, 2);
  assert.equal(i.suppressedCount, 0);
});

test("W3 one operation can legitimately have an event from each provider", () => {
  const i = new WebhookInbox();
  i.receive(w("acquirer-a", "a-1", "DO_NOT_HONOUR"));
  i.receive(w("acquirer-b", "b-1", "APPROVED"));
  const events = i.forOperation("op-1");
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.outcome).sort(), ["AUTHORIZED", "DECLINED"]);
});

test("W4 the provider's own code survives normalisation", () => {
  const i = new WebhookInbox();
  i.receive(w("acquirer-a", "evt-1", "DO_NOT_HONOUR"));
  const e = i.forOperation("op-1")[0]!;
  assert.equal(e.normalisedReason, "declined_by_issuer");
  assert.equal(e.rawCode, "DO_NOT_HONOUR", "two providers' declines are not the same fact");
});

test("W5 a double authorization is detectable because both events were kept", () => {
  // This is the shape of the failure the whole module exists to prevent, and
  // it is visible here only because the inbox did not collapse the two events.
  const i = new WebhookInbox();
  i.receive(w("acquirer-a", "a-1", "APPROVED", "op-9"));
  i.receive(w("acquirer-b", "b-1", "APPROVED", "op-9"));
  assert.deepEqual(i.doubleAuthorizations(), ["op-9"]);
});

test("W6 one authorization and one decline is not a double authorization", () => {
  const i = new WebhookInbox();
  i.receive(w("acquirer-a", "a-1", "DO_NOT_HONOUR", "op-9"));
  i.receive(w("acquirer-b", "b-1", "APPROVED", "op-9"));
  assert.deepEqual(i.doubleAuthorizations(), []);
});

test("W7 an unmapped provider code is preserved and marked unmapped", () => {
  const i = new WebhookInbox();
  i.receive(w("acquirer-a", "evt-1", "SOME_NEW_CODE"));
  const e = i.forOperation("op-1")[0]!;
  assert.equal(e.normalisedReason, "unmapped");
  assert.equal(e.rawCode, "SOME_NEW_CODE");
  assert.equal(e.outcome, "UNKNOWN", "an unrecognised code must not be read as success");
});
