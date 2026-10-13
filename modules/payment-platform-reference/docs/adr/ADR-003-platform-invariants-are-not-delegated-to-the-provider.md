# ADR-003: The platform enforces its own amount invariants, even where the provider already does

**Status:** accepted
**Date:** 2026-10-09

## Context

Two of the platform's amount rules are also enforced by the provider. Adyen's
API-idempotency page lists them among its default accounting rules: "Captures:
when partial captures are allowed, it is not possible to capture a higher
amount than the authorized one." and "Refunds: when multiple refunds are
allowed, by default the total refunded value cannot exceed the captured
amount."

Duplicating a rule the provider already enforces looks like waste. The
simulator in this module enforces both, and `tests/provider.test.ts` P07 and
`tests/lifecycle.test.ts` L05 show the provider refusing a request the platform
would also have refused.

## Decision

The platform enforces both rules itself, before the provider is called.

## Why

Test `T07` is the argument. It runs the regional-failover defect with a full
capture instead of a partial one. The second charge is refused — not by the
platform, which behaved identically in both runs, but by the provider's
capture-cannot-exceed-authorised rule. With a partial capture (`T04`) the same
defect produces two charges.

So the provider's rule is a bound on one shape of the defect and not on the
defect. A platform that omits its own check passes or fails depending on an
amount, and on the rules of whichever provider it was routed to that day. Those
rules are defaults — the source says "by default" — and they are per provider.

## Consequences

- Two implementations of the same rule can disagree, and when they do the
  provider wins, because the provider is the one moving the money. The platform
  records the disagreement as a reconciliation exception rather than overriding
  it.
- The duplicated rule is the reason `partial-capture-and-refund` can show a
  refusal that never reaches the provider, which is cheaper and gives a better
  error.
- This does not extend to rules the platform cannot evaluate, such as issuer
  decisioning. Those stay where they are.
