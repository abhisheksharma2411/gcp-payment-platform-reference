// Token ownership across providers.
//
// The vault reference is the only identifier the platform owns. Everything
// else is somebody else's name for the same instrument, and the difference is
// the whole point: a token minted by a provider is a row in that provider's
// database, and presenting it to a second provider asks a stranger to look up
// a key they have never seen.
//
// Nothing here reproduces any real provider's or card network's tokenisation.
// The two schemes modelled are the two that behave differently, and the
// limits are recorded in ../docs/MODEL.md.

import type { CapabilityContract } from "./types.ts";

export type TokenScheme =
  /** Minted by one provider, meaningful only there. The common case. */
  | "provider"
  /** Minted by the card network. Portable only to providers provisioned
   *  for it -- which is a capability, not a property of the token. */
  | "network";

export interface Token {
  /** The vault reference. Ours. The only identifier that survives a
   *  provider migration, because it never belonged to the provider. */
  readonly vaultRef: string;
  /** The provider's own reference, or the network's. Not ours. */
  readonly reference: string;
  readonly scheme: TokenScheme;
  /** Who minted `reference`. For a provider token, the provider name. */
  readonly mintedBy: string;
}

export type TokenVerdict =
  /** The receiving provider minted it, or is provisioned for the network. */
  | "ACCEPTED"
  /** A provider token presented to a provider that did not mint it. */
  | "REFUSED_PROVIDER_BOUND"
  /** A network token presented where the contract says tokens do not
   *  travel. The token is portable; this provider is not provisioned. */
  | "REFUSED_NOT_PROVISIONED";

/** The one guard that can be removed here. Registered for the same reason. */
export type TokenMutation = "tokens-portable-across-providers";

export const TOKEN_MUTATIONS: readonly TokenMutation[] = ["tokens-portable-across-providers"];

export interface TokenDecision {
  readonly verdict: TokenVerdict;
  readonly reason: string;
}

/**
 * May this token be presented to this provider?
 *
 * Asked before the attempt, not after, because the failure it prevents is not
 * a declined payment. It is a declined payment that looks like a provider
 * problem, counts against that provider's health, and moves traffic away from
 * a provider that was working perfectly well.
 */
export function presentable(
  token: Token,
  receiving: CapabilityContract,
  mutation?: TokenMutation,
): TokenDecision {
  if (mutation === "tokens-portable-across-providers") {
    return { verdict: "ACCEPTED", reason: "guard removed (negative control)" };
  }
  if (token.mintedBy === receiving.provider) {
    return { verdict: "ACCEPTED", reason: "minted by this provider" };
  }
  if (token.scheme === "provider") {
    return {
      verdict: "REFUSED_PROVIDER_BOUND",
      reason: `token minted by ${token.mintedBy}; ${receiving.provider} has no such record`,
    };
  }
  if (!receiving.tokensPortable) {
    return {
      verdict: "REFUSED_NOT_PROVISIONED",
      reason: `${receiving.provider} is not provisioned for ${token.mintedBy} network tokens`,
    };
  }
  return { verdict: "ACCEPTED", reason: `network token, ${receiving.provider} provisioned` };
}

export type MigrationVerdict =
  /** The instrument must be collected again. No copy is possible. */
  | "REQUIRES_RECOLLECTION"
  /** A network token the receiving provider is provisioned for. */
  | "PORTABLE";

export interface MigrationPlan {
  readonly vaultRef: string;
  readonly from: string;
  readonly to: string;
  readonly verdict: MigrationVerdict;
  readonly reason: string;
}

/**
 * What it would take to move one stored instrument to another provider.
 *
 * The honest answer is usually "you cannot," and the reason is worth stating
 * plainly: a provider token is a reference into a vault the platform does not
 * own. There is no export. Migration means re-collecting the instrument from
 * the customer, or a provider-to-provider transfer negotiated outside the
 * software -- which is a commercial process with a lead time, not a function
 * call. A platform that discovers this during an outage has discovered it too
 * late, which is why it belongs in the capability contract.
 */
export function planMigration(
  token: Token,
  from: CapabilityContract,
  to: CapabilityContract,
): MigrationPlan {
  const base = { vaultRef: token.vaultRef, from: from.provider, to: to.provider };
  if (token.scheme === "network" && to.tokensPortable) {
    return { ...base, verdict: "PORTABLE", reason: "network token, receiving provider provisioned" };
  }
  if (token.scheme === "network") {
    return {
      ...base,
      verdict: "REQUIRES_RECOLLECTION",
      reason: `network token, but ${to.provider} is not provisioned for it`,
    };
  }
  return {
    ...base,
    verdict: "REQUIRES_RECOLLECTION",
    reason: `${from.provider} token cannot be exported; the instrument must be collected again`,
  };
}

/**
 * The platform's own record of one instrument across providers.
 *
 * One vault reference, many provider tokens. The map is deliberately keyed by
 * provider: there is no "the token for this customer," because that phrase is
 * only meaningful once you say which provider is being asked.
 */
export class TokenVault {
  readonly #byVaultRef = new Map<string, Map<string, Token>>();

  store(token: Token): void {
    let perProvider = this.#byVaultRef.get(token.vaultRef);
    if (perProvider === undefined) {
      perProvider = new Map<string, Token>();
      this.#byVaultRef.set(token.vaultRef, perProvider);
    }
    perProvider.set(token.mintedBy, token);
  }

  /** The token to present to this provider, or null if we hold none. */
  forProvider(vaultRef: string, provider: string): Token | null {
    return this.#byVaultRef.get(vaultRef)?.get(provider) ?? null;
  }

  /** Every token held for one instrument, by minter, in a stable order. */
  minters(vaultRef: string): readonly string[] {
    return [...(this.#byVaultRef.get(vaultRef)?.keys() ?? [])].sort();
  }
}
