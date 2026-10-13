# ADR-001: One effect-identity rule, two derivations, one mandatory join

**Status:** accepted
**Date:** 2026-10-09

## Context

Two articles in this series already derive effect identity, and they derive it
differently.

```
Article 12   effectId = sha256(operationId ∥ \0 ∥ kind)
Article 17   effectId = hash(consumer ∥ aggregateType:aggregateId#sequence ∥ kind ∥ subject)
```

Article 12's identity is the operation id the caller chose, which is required
to survive every hop. Article 17's is the aggregate's position, chosen because
an event id is a field the publisher writes and a relay that regenerates it
defeats any guard keyed on it.

An integrated platform has both inbound paths, so it cannot simply pick one.
The synchronous command path has a caller and therefore an operation id. The
provider-callback path has neither: the provider generated the event, nothing
the platform chose travels with it, and the provider's own documentation warns
that its event ids are not unique per change. Stripe's webhook page states it
directly: "In some cases, two separate Event objects are generated and sent. To
identify these duplicates, use the ID of the object in `data.object` along with
the `event.type`."

## Decision

One rule, stated once: **effect identity derives from whatever the originator
of the effect controls and cannot regenerate.** That yields two derivations.

```
command path    effectId = sha256('cmd' ∥ operationId ∥ kind)
callback path   effectId = sha256('cb'  ∥ providerObjectId ∥ eventType)
```

And one consequence that neither source article has to state, because neither
has two paths: **the two namespaces must be joined before any effect is
applied.** `PaymentPlatform.handleCallback` resolves the provider object id to
an operation id first, and refuses to apply anything it cannot resolve.

## Why this and not a single derivation

Forcing the callback path onto the operation id is not available: there is no
operation id in a callback, and the only way to obtain one is the join, which
is the thing being discussed. Forcing the command path onto the provider object
id is worse: the object id does not exist until the provider has answered, so
the identity of a retry would not exist at the moment a retry is needed.

## Consequences

- `S02_UNRESOLVED_PROVIDER_REFERENCE` exists because the join can be skipped,
  and control `unresolved-callback` shows what skipping it looks like: an
  applied effect with nothing to attribute it to.
- Both source articles' rules survive unchanged in their own domains. Article
  12 is cited for the operation id and the request fingerprint; Article 17 is
  cited for reaching past an event to something with a position of its own.
- The join needs an index from provider object id to operation id, and that
  index is a durable store with its own availability. A platform whose join
  index is unavailable must queue callbacks, not apply them.
