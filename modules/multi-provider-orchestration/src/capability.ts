// The capability contract, and what it is allowed to decide.
//
// A router that asks "is this provider healthy?" without first asking "can
// this provider even do this?" produces a confident route to a provider that
// will refuse on arrival. Capability is checked first and separately.

import type { CapabilityContract, PaymentRequest } from "./types.ts";

export interface CapabilityCheck {
  readonly eligible: boolean;
  readonly reason: string;
}

/**
 * Whether a provider can carry this request at all.
 *
 * Returns the *first* failing dimension rather than a boolean, because the
 * routing audit has to say why a provider was dropped, and "ineligible" is
 * not an explanation anyone can act on.
 */
export function check(c: CapabilityContract, r: PaymentRequest): CapabilityCheck {
  if (!c.methods.includes(r.method)) {
    return { eligible: false, reason: `method ${r.method} not supported` };
  }
  if (!c.currencies.includes(r.currency)) {
    return { eligible: false, reason: `currency ${r.currency} not supported` };
  }
  if (!c.countries.includes(r.country)) {
    return { eligible: false, reason: `country ${r.country} not supported` };
  }
  if (r.needsSeparateCapture === true && !c.separateCapture) {
    return { eligible: false, reason: "separate capture not supported" };
  }
  return { eligible: true, reason: "capability match" };
}

/**
 * The dimensions on which two providers differ.
 *
 * Used by the report to make the point that a generic interface has to erase
 * something: these are the fields a lowest-common-denominator API would have
 * to drop, and each one changes what the caller may safely do.
 */
export function divergence(
  a: CapabilityContract,
  b: CapabilityContract,
): readonly string[] {
  const out: string[] = [];
  const diffSet = (name: string, x: readonly string[], y: readonly string[]) => {
    const only = [...x].filter((v) => !y.includes(v));
    const other = [...y].filter((v) => !x.includes(v));
    if (only.length || other.length) {
      out.push(`${name}: ${a.provider} only [${only.join(",")}], ${b.provider} only [${other.join(",")}]`);
    }
  };
  diffSet("methods", a.methods, b.methods);
  diffSet("currencies", a.currencies, b.currencies);
  diffSet("countries", a.countries, b.countries);
  for (const [name, x, y] of [
    ["separateCapture", a.separateCapture, b.separateCapture],
    ["refunds", a.refunds, b.refunds],
    ["tokensPortable", a.tokensPortable, b.tokensPortable],
    ["honoursIdempotencyKey", a.honoursIdempotencyKey, b.honoursIdempotencyKey],
    ["supportsQuery", a.supportsQuery, b.supportsQuery],
  ] as const) {
    if (x !== y) out.push(`${name}: ${a.provider}=${x}, ${b.provider}=${y}`);
  }
  if (a.timeoutMs !== b.timeoutMs) {
    out.push(`timeoutMs: ${a.provider}=${a.timeoutMs}, ${b.provider}=${b.timeoutMs}`);
  }
  return out;
}
