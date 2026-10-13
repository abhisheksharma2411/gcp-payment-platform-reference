# ADR-002: A decline is an answer, not a failure

**Status:** accepted
**Date:** 2026-10-13

## Context

A declined authorization is the provider working correctly. It answered,
promptly, with the answer its issuer gave. Two designs treat it as a failure,
and both are wrong in ways that are hard to see from inside.

## Decision

**A decline does not move the health signal.** `HealthRegistry.record` takes a
third value, `neutral`, and declines use it.

**A decline does not cascade by default.** Re-offering a declined payment to a
second provider is a deliberate policy choice (`cascadeDeclines`), off unless
switched on.

## Consequences

- A merchant whose customers are being refused for good reasons does not open
  the circuit on its own provider. Test `F11` holds the circuit `CLOSED` across
  ten consecutive declines; negative control `N3` shows it opening after four
  once declines are counted as failures.
- Cascading is available because it is sometimes right — a soft decline at one
  acquirer can succeed at another. It is off by default because the failure
  mode of getting it wrong is retrying a hard decline across every provider
  until one of them flags the merchant.
- The report's "first declines" row shows 50 attempts and 0 authorizations:
  with cascading off, each operation stops at the first answer. That is the
  intended behaviour and it is visible rather than assumed.
