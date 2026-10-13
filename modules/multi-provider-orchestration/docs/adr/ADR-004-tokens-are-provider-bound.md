# ADR-004: A token belongs to the provider that minted it

**Status:** accepted
**Date:** 2026-10-13

## Context

A platform with two providers stores payment instruments. The tempting model is
one token per customer, held by the orchestration layer, presented to whichever
provider the router picks.

That model is wrong, and wrong in a way that does not announce itself. A
provider token is a reference into a vault the platform does not own. The
receiving provider has never seen the string. Presenting it does not raise
"unknown token, check your configuration" at the routing layer; it produces a
declined or errored payment attributed to the *receiving* provider.

Which is the real cost. That attribution counts against the receiving
provider's health, opens its circuit, and moves traffic away from a provider
that was working correctly. One configuration mistake becomes a routing
incident, and every dashboard points at the wrong party.

Network tokens complicate this without fixing it. A network token is not
provider-bound in the same way, but a provider can only accept one if it has
been provisioned for it — which is a property of the receiver, negotiated
commercially, not a property of the token.

## Decision

1. Tokens are stored by `(vaultRef, provider)`. The vault reference is the only
   identifier the platform owns and the only one that survives a migration.
2. `presentable()` is consulted **before** an attempt, not after a failure.
   A provider token presented to another provider is `REFUSED_PROVIDER_BOUND`.
3. A network token is accepted only where the receiving contract says
   `tokensPortable`. Portability is recorded against the **receiver**, never
   against the token.
4. `planMigration()` returns `REQUIRES_RECOLLECTION` for anything that cannot
   be moved, rather than a hopeful success.
5. A negative control removes the binding and shows the refusal disappearing.

## Consequences

Adding a provider means minting a second token for the same instrument. There
is no import, and the module says so instead of implying a migration path that
does not exist.

Failover is further constrained: a provider we hold no token for is not a
failover target for a stored-instrument payment, however healthy it looks.
Discovering that during an outage is the outcome this ADR exists to prevent.

The platform must also accept that leaving a provider has a lead time measured
in weeks or months. That belongs in a capability contract read at design time,
not in an incident review.
