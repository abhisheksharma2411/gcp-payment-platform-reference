import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthRegistry, DEFAULT_HEALTH } from "../src/health.ts";

const T0 = Date.UTC(2026, 0, 5);

test("H1 a circuit opens only after consecutive failures", () => {
  const h = new HealthRegistry();
  h.record("p", "failure", T0);
  h.record("p", "failure", T0 + 1);
  assert.equal(h.state("p", T0 + 2), "CLOSED");
  h.record("p", "failure", T0 + 2);
  assert.equal(h.state("p", T0 + 3), "OPEN");
});

test("H2 one success resets the run", () => {
  const h = new HealthRegistry();
  h.record("p", "failure", T0);
  h.record("p", "failure", T0 + 1);
  h.record("p", "success", T0 + 2);
  h.record("p", "failure", T0 + 3);
  h.record("p", "failure", T0 + 4);
  assert.equal(h.state("p", T0 + 5), "CLOSED");
});

test("H3 OPEN becomes HALF_OPEN on a clock, not on a request", () => {
  // Admitting one probe rather than a flood is the difference between
  // recovering and knocking the provider over again.
  //
  // The window runs from the instant the circuit OPENED, which is the third
  // failure, not from the first one.
  const h = new HealthRegistry();
  for (let i = 0; i < 3; i += 1) h.record("p", "failure", T0 + i);
  const openedAt = T0 + 2;
  assert.equal(h.state("p", openedAt + DEFAULT_HEALTH.openForMs - 1), "OPEN");
  assert.equal(h.state("p", openedAt + DEFAULT_HEALTH.openForMs), "HALF_OPEN");
  assert.equal(h.admits("p", openedAt + DEFAULT_HEALTH.openForMs), true);
});

test("H4 closing needs hysteresis, not one lucky probe", () => {
  const h = new HealthRegistry();
  for (let i = 0; i < 3; i += 1) h.record("p", "failure", T0 + i);
  const t = T0 + 2 + DEFAULT_HEALTH.openForMs;
  h.state("p", t);
  h.record("p", "success", t);
  assert.equal(h.state("p", t + 1), "HALF_OPEN", "one success is not recovery");
  h.record("p", "success", t + 1);
  assert.equal(h.state("p", t + 2), "CLOSED");
});

test("H5 a failed probe in HALF_OPEN reopens immediately", () => {
  const h = new HealthRegistry();
  for (let i = 0; i < 3; i += 1) h.record("p", "failure", T0 + i);
  const t = T0 + 2 + DEFAULT_HEALTH.openForMs;
  h.state("p", t);
  h.record("p", "failure", t);
  assert.equal(h.state("p", t + 1), "OPEN");
});

test("H6 stale observations stop counting", () => {
  // Two failures an hour ago are not evidence about now, and a router that
  // treats them as evidence will keep a healthy provider out of the pool.
  const h = new HealthRegistry();
  h.record("p", "failure", T0);
  h.record("p", "failure", T0 + 1);
  // Strictly later than the window: an observation exactly at the boundary is
  // still evidence, and the implementation uses a strict comparison.
  const later = T0 + 1 + DEFAULT_HEALTH.staleAfterMs + 1;
  assert.equal(h.state("p", later), "CLOSED");
  h.record("p", "failure", later);
  assert.equal(h.state("p", later + 1), "CLOSED", "the old run was discarded");
});

test("H7 a neutral observation moves nothing", () => {
  const h = new HealthRegistry();
  for (let i = 0; i < 10; i += 1) h.record("p", "neutral", T0 + i);
  assert.equal(h.state("p", T0 + 20), "CLOSED");
  assert.equal(h.transitions, 0);
});

test("H8 flapping is visible as a transition count", () => {
  const h = new HealthRegistry();
  let t = T0;
  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (let i = 0; i < 3; i += 1) h.record("p", "failure", t++);
    t += DEFAULT_HEALTH.openForMs;
    h.state("p", t);
    h.record("p", "success", t++);
    h.record("p", "success", t++);
  }
  assert.ok(h.transitions >= 6, `expected repeated transitions, saw ${h.transitions}`);
});
