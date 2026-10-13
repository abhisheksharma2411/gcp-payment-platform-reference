# ADR-002: The authority map declares a divergence window, not just an owner

**Status:** accepted
**Date:** 2026-10-09

## Context

Four stores hold an answer about one payment: the operational store that the
customer's status comes from, the provider-evidence store, the ledger, and the
reporting copy. Naming an owner per field is the usual advice and it is not
enough, because at any instant three of the four are legitimately behind and a
reader of the stale one is not necessarily wrong.

Spanner's instance-configuration guidance makes the problem concrete rather
than theoretical. For multi-region configurations it advises: "For optimal read
performance outside of the default leader region, use staleness of at least 15
seconds." A reporting read fresher than that is not on offer. A platform that
declares its reporting copy must match the operational store is declaring
something the database underneath it will not do.

## Decision

Every row of `AUTHORITY_MAP` carries three things: the field, the component
permitted to write it, and `divergenceWindowMs` — how far behind a
non-authoritative reader may be before reading it is a defect.

```
reporting.intentStatus   owner reporting   writer reporting   window 15000
intent.status            owner operational writer payment-api window 0
```

The auditor checks both halves: a write by the wrong component is
`S01_AUTHORITY_WRITE_VIOLATION`, and a read served further behind than its
window is `S05_STALE_READ_BEYOND_WINDOW`.

## Rejected alternative

An owner-only map, with freshness left to each reader's judgement. It was
rejected because it makes the interesting failure unreportable. The defect that
matters is not "two stores disagree" — they always do — but "somebody acted on
a disagreement that had gone on too long", and an owner-only map cannot express
the second sentence.

## Consequences

- The window is a declaration, so it can be wrong. A platform that writes 15000
  because that is what Spanner suggests, and then builds a refund-eligibility
  check on the reporting copy, has a 15-second hole it has formally approved.
  The map makes the hole visible; it does not close it.
- Zero is a legitimate window and means "no copy may be read at all".
- The windows here are declared and never measured against a real replica.
