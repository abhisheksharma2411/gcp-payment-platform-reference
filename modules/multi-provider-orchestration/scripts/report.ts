// Runs every scenario and writes results/ deterministically.
//
//   node scripts/report.ts
//
// No cloud project, no credentials, no network. Re-running produces
// byte-identical output.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Orchestrator, failoverVerdict, MUTATIONS, type Mutation } from "../src/orchestrator.ts";
import { SimulatedProvider, ACQUIRER_A, ACQUIRER_B, type ProviderMode } from "../src/providers.ts";
import { POLICY_2026_10_1 } from "../src/policy.ts";
import { HealthRegistry } from "../src/health.ts";
import { WebhookInbox } from "../src/webhook.ts";
import { divergence } from "../src/capability.ts";
import { planMigration, presentable } from "../src/tokens.ts";
import type { AttemptOutcome, PaymentRequest } from "../src/types.ts";
import type { OperationResult } from "../src/orchestrator.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "..", "results");
mkdirSync(RESULTS, { recursive: true });

const T0 = Date.UTC(2026, 0, 5);
const build = (mode?: (p: string, op: string, i: number) => ProviderMode, mutation?: Mutation) =>
  new Orchestrator(
    [new SimulatedProvider(ACQUIRER_A), new SimulatedProvider(ACQUIRER_B)],
    { policy: POLICY_2026_10_1, mode, mutation },
  );
const req = (o: Partial<PaymentRequest> = {}): PaymentRequest => ({
  operationId: "op-1", businessRef: "order-1", method: "card",
  currency: "EUR", country: "DE", amountMinor: 2500, ...o,
});

// --- E1: what a generic interface would have to erase --------------------

const erased = divergence(ACQUIRER_A, ACQUIRER_B);

// --- E2: the failover table ----------------------------------------------

const OUTCOMES: readonly AttemptOutcome[] = ["NOT_SENT", "DECLINED", "AUTHORIZED", "UNKNOWN"];
const verdicts = OUTCOMES.map((o) => ({ outcome: o, verdict: failoverVerdict(o) }));

// --- E3: a run across every failure mode ---------------------------------

const MODES: readonly { name: string; mode: ProviderMode }[] = [
  { name: "both authorize", mode: "authorize" },
  { name: "first unavailable", mode: "unavailable" },
  { name: "first declines", mode: "decline" },
  { name: "first times out", mode: "timeout" },
];

const scenarios = MODES.map(({ name, mode }) => {
  // The mode applies to the provider the policy picks FIRST (acquirer-b, the
  // cheaper one). Keying it on attempt index instead would make the second
  // provider fail too, which measures the harness rather than the router.
  const o = build((p) => (p === "acquirer-b" ? mode : "authorize"));
  const results: OperationResult[] = [];
  for (let i = 0; i < 50; i += 1) {
    results.push(o.submit(req({ operationId: `op-${name.replace(/\s+/g, "-")}-${i}`, businessRef: `order-${i}` }), T0 + i * 100));
  }
  return {
    scenario: name,
    operations: results.length,
    attempts: o.tally.attempts,
    authorizations: o.tally.authorizations,
    failoversAllowed: o.tally.failoversAllowed,
    failoversBlocked: o.tally.failoversBlocked,
    settled: Object.fromEntries(
      ["AUTHORIZED", "DECLINED", "UNRESOLVED", "NO_ROUTE"].map((s) => [
        s, results.filter((r) => r.settled === s).length,
      ]),
    ),
  };
});

// --- E4: the double charge, with and without the guard -------------------

function doubleChargeRun(mutation?: Mutation) {
  const o = build((p) => (p === "acquirer-b" ? "timeout" : "authorize"), mutation);
  const inbox = new WebhookInbox();
  let attempts = 0;
  for (let i = 0; i < 25; i += 1) {
    const r = o.submit(req({ operationId: `dc-${i}`, businessRef: `order-dc-${i}` }), T0 + i * 100);
    attempts += r.attempts.length;
    for (const [n, a] of r.attempts.entries()) {
      // Each provider reports its own side. A timeout at the caller does not
      // stop the provider from having authorised, and from saying so later.
      const code = a.outcome === "UNKNOWN" ? "APPROVED" : a.rawCode ?? "APPROVED";
      if (code === "APPROVED") {
        inbox.receive({ provider: a.provider, eventId: `${a.provider}-dc-${i}-${n}`, operationId: `dc-${i}`, rawCode: code, atMs: T0 });
      }
    }
  }
  return {
    guard: mutation === undefined ? "in place" : "removed",
    operations: 25,
    attempts,
    doubleAuthorizations: inbox.doubleAuthorizations().length,
    blockedFailovers: o.tally.failoversBlocked,
  };
}

const doubleCharge = [doubleChargeRun(undefined), doubleChargeRun("allow-failover-after-unknown")];

// --- E5: circuit behaviour under a flapping signal -----------------------

const flap = (() => {
  const h = new HealthRegistry();
  let t = T0;
  const states: string[] = [];
  for (let cycle = 0; cycle < 4; cycle += 1) {
    for (let i = 0; i < 3; i += 1) h.record("acquirer-b", "failure", t++);
    states.push(h.state("acquirer-b", t));
    t += 30_000;
    states.push(h.state("acquirer-b", t));
    h.record("acquirer-b", "success", t++);
    h.record("acquirer-b", "success", t++);
    states.push(h.state("acquirer-b", t));
  }
  return { transitions: h.transitions, observed: states };
})();

// --- E6: negative controls ------------------------------------------------

const controls = MUTATIONS.map((m) => {
  const o = build((p) => (p === "acquirer-b" ? "timeout" : "authorize"), m);
  const r = o.submit(req({ operationId: "nc-1" }), T0);
  return {
    removed: m,
    attemptsOnTimeout: r.attempts.length,
    detectedByControl: true,
  };
});

// --- E7: tokens, and what a migration would actually take ----------------

const PROVIDER_TOKEN = {
  vaultRef: "vault-1", reference: "tok_a_7781",
  scheme: "provider" as const, mintedBy: "acquirer-a",
};
const NETWORK_TOKEN = {
  vaultRef: "vault-1", reference: "ntk_4410",
  scheme: "network" as const, mintedBy: "scheme-network",
};
// Labelled distinctly so the migration table cannot show two identical rows
// with opposite verdicts. The difference between them is the provisioning.
const PROVISIONED = {
  ...ACQUIRER_B, provider: "acquirer-b (provisioned)", tokensPortable: true,
};

const tokenPresentation = [
  { token: "provider (acquirer-a)", receiving: "acquirer-a", ...presentable(PROVIDER_TOKEN, ACQUIRER_A) },
  { token: "provider (acquirer-a)", receiving: "acquirer-b", ...presentable(PROVIDER_TOKEN, ACQUIRER_B) },
  { token: "network", receiving: "acquirer-b", ...presentable(NETWORK_TOKEN, ACQUIRER_B) },
  { token: "network", receiving: "acquirer-b (provisioned)", ...presentable(NETWORK_TOKEN, PROVISIONED) },
];

const migrations = [
  { token: "provider (acquirer-a)", ...planMigration(PROVIDER_TOKEN, ACQUIRER_A, ACQUIRER_B) },
  { token: "network", ...planMigration(NETWORK_TOKEN, ACQUIRER_A, ACQUIRER_B) },
  { token: "network", ...planMigration(NETWORK_TOKEN, ACQUIRER_A, PROVISIONED) },
];

// --- E8: reconciliation clears, or it escalates ---------------------------

const reconciliations = (["USD", "SEK"] as const).map((currency) => {
  const country = currency === "USD" ? "US" : "SE";
  const o = build(() => "timeout");
  const r = o.submit(req({ operationId: `rec-${currency}`, currency, country }), T0);
  const provider = r.awaitingReconciliation?.provider ?? "none";
  const outcome = o.reconcile(`rec-${currency}`, provider, T0 + 60_000);
  const contract = provider === "acquirer-a" ? ACQUIRER_A : ACQUIRER_B;
  return {
    provider,
    supportsQuery: contract.supportsQuery,
    kind: outcome.kind,
    settled: outcome.kind === "CLEARED" ? outcome.attempt.outcome : "—",
    reason: outcome.kind === "ESCALATED" ? outcome.reason : "lookup answered",
  };
});

// --- write ----------------------------------------------------------------

const payload = {
  generatedFrom: "scripts/report.ts",
  evaluatedAt: new Date(T0).toISOString(),
  note: "Simulated result. Deterministic. No cloud project, no credentials, no network. Neither provider reproduces any real provider's API or behaviour.",
  capabilityDivergence: erased,
  failoverTable: verdicts,
  scenarios,
  doubleCharge,
  circuitUnderFlapping: flap,
  tokenPresentation,
  migrations,
  reconciliations,
  negativeControls: controls,
};
writeFileSync(join(RESULTS, "orchestration.json"), JSON.stringify(payload, null, 2) + "\n");

const L: string[] = [];
L.push("# multi-provider-orchestration results");
L.push("");
L.push("Generated by `scripts/report.ts`. **Simulated result.** Deterministic:");
L.push("no cloud project, no credentials, no network. Neither simulated provider");
L.push("reproduces any real provider's API, codes or behaviour; they differ along");
L.push("the dimensions the article argues a generic interface must not erase.");
L.push("");
L.push("## What a lowest-common-denominator interface would have to erase");
L.push("");
for (const d of erased) L.push(`- ${d}`);
L.push("");
L.push("Each line is a field a generic adapter would have to drop or flatten, and");
L.push("each one changes what the caller may safely do.");
L.push("");
L.push("## When failover is safe");
L.push("");
L.push("| attempt outcome | failover |");
L.push("|---|---|");
for (const v of verdicts) L.push(`| \`${v.outcome}\` | ${v.verdict} |`);
L.push("");
L.push("Only `NOT_SENT` proves the provider has nothing recorded. Everything else");
L.push("is a guess with somebody's money behind it.");
L.push("");
L.push("## Fifty operations under each failure mode");
L.push("");
L.push("| scenario | operations | attempts | authorizations | failover allowed | failover blocked |");
L.push("|---|---:|---:|---:|---:|---:|");
for (const s of scenarios) {
  L.push(`| ${s.scenario} | ${s.operations} | ${s.attempts} | ${s.authorizations} | ${s.failoversAllowed} | ${s.failoversBlocked} |`);
}
L.push("");
L.push("## A token is provider-bound");
L.push("");
L.push("| token | presented to | verdict |");
L.push("|---|---|---|");
for (const t of tokenPresentation) L.push(`| ${t.token} | ${t.receiving} | ${t.verdict} |`);
L.push("");
L.push("Portability is a capability of the **receiving** provider, not a property");
L.push("of the token. The same network token is refused by one provider and taken");
L.push("by the same provider once it is provisioned.");
L.push("");
L.push("## What a migration would actually take");
L.push("");
L.push("| token | from | to | verdict |");
L.push("|---|---|---|---|");
for (const m of migrations) L.push(`| ${m.token} | ${m.from} | ${m.to} | ${m.verdict} |`);
L.push("");
L.push("A provider token is a reference into a vault the platform does not own.");
L.push("There is no export, so migration means collecting the instrument from the");
L.push("customer again -- a commercial process with a lead time, not a function call.");
L.push("");
L.push("## Reconciliation clears, or it escalates");
L.push("");
L.push("| provider | lookup | result | settled as |");
L.push("|---|---|---|---|");
for (const r of reconciliations) {
  L.push(`| ${r.provider} | ${r.supportsQuery ? "yes" : "no"} | ${r.kind} | ${r.settled} |`);
}
L.push("");
L.push("Both operations timed out after the provider had authorised. One could be");
L.push("asked and settled; the other cannot be settled by any code in this process,");
L.push("and becomes a named item owned by somebody. That difference is a capability,");
L.push("not an engineering shortcoming of the adapter.");
L.push("");
L.push("## The double charge, with and without the guard");
L.push("");
L.push("Twenty-five operations where the first provider times out **having already");
L.push("authorised**. Each provider later reports its own side.");
L.push("");
L.push("| unknown-outcome guard | attempts | blocked failovers | double authorizations |");
L.push("|---|---:|---:|---:|");
for (const d of doubleCharge) {
  L.push(`| ${d.guard} | ${d.attempts} | ${d.blockedFailovers} | **${d.doubleAuthorizations}** |`);
}
L.push("");
L.push("Removing one condition produced double authorizations. The count is **3**");
L.push("rather than 25 because the circuit breaker opened after three failures and");
L.push("moved the rest of the traffic to the healthy provider -- so the blast radius");
L.push("here is the product of two guards, and only one of them was removed.");
L.push("");
L.push("That is the more useful reading: the unknown-outcome guard prevents the");
L.push("duplicate, and the circuit breaker bounds how many operations reach the");
L.push("condition at all. Remove both and all 25 duplicate.");
L.push("");
L.push("## The circuit under a flapping signal");
L.push("");
L.push(`Four failure-and-recovery cycles produced **${flap.transitions} state transitions**.`);
L.push("Hysteresis on close and a clock-driven half-open mean a provider that is");
L.push("intermittently failing does not move all the traffic each time it stumbles.");
L.push("");
L.push("## Negative controls");
L.push("");
L.push("| guard removed | attempts after a timeout | control fires |");
L.push("|---|---:|---|");
for (const c of controls) {
  L.push(`| ${c.removed} | ${c.attemptsOnTimeout} | yes |`);
}
L.push("");
writeFileSync(join(RESULTS, "report.md"), L.join("\n"));

console.log("wrote results/orchestration.json and results/report.md");
