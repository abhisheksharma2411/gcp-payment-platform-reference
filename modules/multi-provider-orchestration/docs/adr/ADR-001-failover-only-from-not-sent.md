# ADR-001: Failover is permitted only from `NOT_SENT`

**Status:** accepted
**Date:** 2026-10-13

## Context

An orchestrator exists to move work between providers. The question is when it
may, and the attractive answer — *when the attempt failed* — is wrong, because
"failed" covers two situations that differ in the only way that matters.

A provider that refused the connection has nothing recorded. A provider that
timed out may have authorised the payment and lost the answer on the way back.
Both look like a failure to the caller. Only one of them is safe to walk away
from.

## Decision

The attempt outcome is modelled as four values, and failover is permitted from
exactly one:

| outcome | failover | why |
|---|---|---|
| `NOT_SENT` | **safe** | the only outcome that proves the provider has nothing recorded |
| `DECLINED` | a policy choice | the provider answered; see ADR-002 |
| `AUTHORIZED` | nothing to fail over | |
| `UNKNOWN` | **blocked** | it may have been accepted; reconciliation first |

`failoverVerdict` is a pure function with no dependencies, so the rule can be
read in one place and tested without constructing anything.

## Consequences

- An operation that times out ends `UNRESOLVED` and carries the provider and
  key it needs for reconciliation. It does **not** get a second provider.
- That costs availability. The report measures the cost: under a provider that
  times out on every call, three of fifty operations end unresolved before the
  circuit opens and moves the rest to a healthy provider.
- Removing this one condition produced **3 double authorizations in 25
  operations** (`make report`). Not 25, because the circuit breaker bounds how
  many operations reach the condition at all — the blast radius is the product
  of two guards and only one was removed.
- A provider whose capability contract offers no lookup leaves the unknown
  unresolvable until a statement arrives. That is why `supportsQuery` is in the
  capability contract rather than hidden in the adapter: it changes what the
  platform may safely do after a timeout.
