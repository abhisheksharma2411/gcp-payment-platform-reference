// Two deterministic provider simulators with different capabilities and
// different failure modes.
//
// Neither reproduces any real provider's API, codes or behaviour. They differ
// along the dimensions the article argues a generic interface must not erase:
// one honours a caller-supplied idempotency key and offers a lookup, the other
// does neither, and that single difference changes what is safe to do after a
// timeout.

import type { AttemptOutcome, CapabilityContract } from "./types.ts";

export const ACQUIRER_A: CapabilityContract = {
  provider: "acquirer-a",
  methods: ["card", "wallet"],
  currencies: ["EUR", "GBP", "USD"],
  countries: ["DE", "FR", "GB", "US"],
  separateCapture: true,
  refunds: true,
  tokensPortable: false,
  honoursIdempotencyKey: true,
  supportsQuery: true,
  timeoutMs: 8_000,
};

export const ACQUIRER_B: CapabilityContract = {
  provider: "acquirer-b",
  methods: ["card", "bank_transfer"],
  currencies: ["EUR", "SEK"],
  countries: ["DE", "SE"],
  separateCapture: false,
  refunds: true,
  tokensPortable: false,
  honoursIdempotencyKey: false,
  supportsQuery: false,
  timeoutMs: 20_000,
};

/** What the simulated provider does on a given call. */
export type ProviderMode = "authorize" | "decline" | "timeout" | "unavailable";

export interface ProviderResponse {
  readonly outcome: AttemptOutcome;
  readonly providerRef?: string;
  readonly rawCode?: string;
  readonly deduplicated: boolean;
}

/**
 * A provider that may or may not remember your key.
 *
 * The honest detail: a call that times out still *happened* at the provider.
 * The key is recorded before the response is lost, so a provider that honours
 * keys can answer a retry correctly and one that does not cannot.
 */
export class SimulatedProvider {
  readonly contract: CapabilityContract;
  readonly #byKey = new Map<string, { ref: string; outcome: AttemptOutcome; code: string }>();
  #calls = 0;

  constructor(contract: CapabilityContract) {
    this.contract = contract;
  }

  call(key: string, mode: ProviderMode, nowMs: number): ProviderResponse {
    this.#calls += 1;

    if (mode === "unavailable") {
      // Refused at the door. Nothing was accepted, and we can prove it.
      return { outcome: "NOT_SENT", rawCode: "TRANSPORT_REFUSED", deduplicated: false };
    }

    if (this.contract.honoursIdempotencyKey) {
      const prior = this.#byKey.get(key);
      if (prior !== undefined) {
        return { outcome: prior.outcome, providerRef: prior.ref, rawCode: prior.code, deduplicated: true };
      }
    }

    if (mode === "decline") {
      const code = "DO_NOT_HONOUR";
      if (this.contract.honoursIdempotencyKey) {
        this.#byKey.set(key, { ref: `${this.contract.provider}-dec-${nowMs}`, outcome: "DECLINED", code });
      }
      return { outcome: "DECLINED", rawCode: code, deduplicated: false };
    }

    const ref = `${this.contract.provider}-${key.slice(0, 10)}`;
    if (this.contract.honoursIdempotencyKey) {
      this.#byKey.set(key, { ref, outcome: "AUTHORIZED", code: "APPROVED" });
    }

    if (mode === "timeout") {
      // The authorization is recorded above. The answer is lost below. The
      // caller cannot tell this apart from "never arrived".
      return { outcome: "UNKNOWN", rawCode: "TIMEOUT", deduplicated: false };
    }

    return { outcome: "AUTHORIZED", providerRef: ref, rawCode: "APPROVED", deduplicated: false };
  }

  /**
   * Ask what happened to a key.
   *
   * Only available when the contract says so. A provider without a lookup
   * leaves an unknown outcome unresolvable until the next statement, which is
   * why `supportsQuery` is part of the capability contract rather than an
   * implementation detail of the adapter.
   */
  lookup(key: string): ProviderResponse | null {
    if (!this.contract.supportsQuery) return null;
    const prior = this.#byKey.get(key);
    if (prior === undefined) return null;
    return { outcome: prior.outcome, providerRef: prior.ref, rawCode: prior.code, deduplicated: true };
  }

  get calls(): number {
    return this.#calls;
  }
}

/**
 * Normalise a provider code without discarding it.
 *
 * The normalised reason is for routing and reporting. The raw code stays on
 * the attempt record, because two providers' "declined" are not the same fact
 * and an operator reading an incident needs the one the provider actually
 * sent.
 */
export function normalise(rawCode: string | undefined): string {
  switch (rawCode) {
    case "APPROVED": return "approved";
    case "DO_NOT_HONOUR": return "declined_by_issuer";
    case "TIMEOUT": return "no_answer";
    case "TRANSPORT_REFUSED": return "not_sent";
    default: return "unmapped";
  }
}
