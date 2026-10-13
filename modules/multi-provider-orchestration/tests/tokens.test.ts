// A token is provider-bound, and the vault reference is the only identifier
// the platform owns.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenVault, planMigration, presentable, type Token } from "../src/tokens.ts";
import { ACQUIRER_A, ACQUIRER_B } from "../src/providers.ts";

const providerToken: Token = {
  vaultRef: "vault-1", reference: "tok_a_7781", scheme: "provider", mintedBy: "acquirer-a",
};
const networkToken: Token = {
  vaultRef: "vault-1", reference: "ntk_4410", scheme: "network", mintedBy: "scheme-network",
};

test("T1 a provider token is accepted only by the provider that minted it", () => {
  assert.equal(presentable(providerToken, ACQUIRER_A).verdict, "ACCEPTED");
  assert.equal(presentable(providerToken, ACQUIRER_B).verdict, "REFUSED_PROVIDER_BOUND");
});

test("T2 the refusal names the minter, because an operator has to act on it", () => {
  const d = presentable(providerToken, ACQUIRER_B);
  assert.match(d.reason, /acquirer-a/);
  assert.match(d.reason, /acquirer-b has no such record/);
});

test("T3 a network token still needs the receiving provider to be provisioned", () => {
  // Portability is a capability of the receiver, not a property of the token.
  assert.equal(ACQUIRER_B.tokensPortable, false);
  assert.equal(presentable(networkToken, ACQUIRER_B).verdict, "REFUSED_NOT_PROVISIONED");

  const provisioned = { ...ACQUIRER_B, tokensPortable: true };
  assert.equal(presentable(networkToken, provisioned).verdict, "ACCEPTED");
});

test("T4 migrating a provider token requires collecting the instrument again", () => {
  const plan = planMigration(providerToken, ACQUIRER_A, ACQUIRER_B);
  assert.equal(plan.verdict, "REQUIRES_RECOLLECTION");
  assert.match(plan.reason, /cannot be exported/);
  assert.equal(plan.vaultRef, "vault-1");
});

test("T5 a network token migrates only where the receiver is provisioned", () => {
  assert.equal(planMigration(networkToken, ACQUIRER_A, ACQUIRER_B).verdict, "REQUIRES_RECOLLECTION");
  assert.equal(
    planMigration(networkToken, ACQUIRER_A, { ...ACQUIRER_B, tokensPortable: true }).verdict,
    "PORTABLE",
  );
});

test("T6 one instrument holds a separate token per provider", () => {
  const vault = new TokenVault();
  vault.store(providerToken);
  vault.store({ vaultRef: "vault-1", reference: "tok_b_22", scheme: "provider", mintedBy: "acquirer-b" });

  assert.deepEqual(vault.minters("vault-1"), ["acquirer-a", "acquirer-b"]);
  assert.equal(vault.forProvider("vault-1", "acquirer-a")?.reference, "tok_a_7781");
  assert.equal(vault.forProvider("vault-1", "acquirer-b")?.reference, "tok_b_22");
  // Failing over to a provider we hold no token for is not a routing problem.
  assert.equal(vault.forProvider("vault-1", "acquirer-c"), null);
});

test("NC-T removing the binding lets a provider token be presented anywhere", () => {
  // The negative control. With the guard gone the refusal disappears, which
  // is how the guard is shown to be doing the work.
  assert.equal(presentable(providerToken, ACQUIRER_B).verdict, "REFUSED_PROVIDER_BOUND");
  assert.equal(
    presentable(providerToken, ACQUIRER_B, "tokens-portable-across-providers").verdict,
    "ACCEPTED",
  );
});
