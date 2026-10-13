# ADR-003: The idempotency key is scoped to the provider

**Status:** accepted
**Date:** 2026-10-13

## Context

The platform has one operation id. Each provider wants an idempotency key. The
tempting move is to send the operation id to both, so the identifier is the
same everywhere and reconciliation is easy.

## Decision

`providerKey(operationId, provider)` returns `"<provider>:<operationId>"`, and
the operation id itself is never presented to a provider.

## Consequences

- A key is a promise to **one party** about **one request**. Presenting the
  same string to two providers means nothing to either of them, and makes the
  two calls look related in a way neither can act on.
- It also removes a real hazard: if two providers ever shared a key namespace —
  through a shared gateway, a reseller, or the same underlying acquirer — one
  provider's record of the key could answer the other's request.
- Negative control `N2` shows the mutation: with one shared key, both attempts
  present `op-1` and provider-scoped identity is gone.
- The cost is that reconciliation has to strip the prefix. That is one function
  and it is worth it.
