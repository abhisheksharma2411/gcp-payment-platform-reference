import { test } from "node:test";
import assert from "node:assert/strict";
import { check, divergence } from "../src/capability.ts";
import { ACQUIRER_A, ACQUIRER_B } from "../src/providers.ts";
import type { PaymentRequest } from "../src/types.ts";

const req = (o: Partial<PaymentRequest> = {}): PaymentRequest => ({
  operationId: "op-1", businessRef: "order-1", method: "card",
  currency: "EUR", country: "DE", amountMinor: 2500, ...o,
});

test("C1 a capability match is eligible", () => {
  assert.equal(check(ACQUIRER_A, req()).eligible, true);
  assert.equal(check(ACQUIRER_B, req()).eligible, true);
});

test("C2 a currency mismatch names the currency", () => {
  const r = check(ACQUIRER_B, req({ currency: "GBP" }));
  assert.equal(r.eligible, false);
  assert.match(r.reason, /currency GBP/);
});

test("C3 a payment-method mismatch names the method", () => {
  const r = check(ACQUIRER_B, req({ method: "wallet" }));
  assert.equal(r.eligible, false);
  assert.match(r.reason, /method wallet/);
});

test("C4 a country mismatch names the country", () => {
  const r = check(ACQUIRER_A, req({ country: "SE" }));
  assert.equal(r.eligible, false);
  assert.match(r.reason, /country SE/);
});

test("C5 separate capture is a capability, not an assumption", () => {
  // Acquirer B authorises and captures together. A platform that assumed every
  // provider could hold an authorization would discover this at the worst time.
  assert.equal(check(ACQUIRER_B, req({ needsSeparateCapture: true })).eligible, false);
  assert.equal(check(ACQUIRER_A, req({ needsSeparateCapture: true })).eligible, true);
});

test("C6 the first failing dimension is reported, not a boolean", () => {
  // The routing audit has to say why a provider was dropped. "Ineligible" is
  // not something an operator can act on.
  const r = check(ACQUIRER_B, req({ currency: "USD", country: "US" }));
  assert.equal(r.eligible, false);
  assert.ok(r.reason.length > 10);
});

test("C7 the two providers diverge on the things a generic API would erase", () => {
  const d = divergence(ACQUIRER_A, ACQUIRER_B);
  const joined = d.join(" | ");
  for (const dimension of ["separateCapture", "honoursIdempotencyKey", "supportsQuery", "currencies", "timeoutMs"]) {
    assert.ok(joined.includes(dimension), `divergence should name ${dimension}`);
  }
});
