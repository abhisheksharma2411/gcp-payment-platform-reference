# ADR-004: The seam auditor shares no code with the components it audits

**Status:** accepted
**Date:** 2026-10-09

## Context

The recurring defect in this programme is a checker that calls the helper it is
checking. Article 14's invariants and balance rebuild both call `signedMinor`;
Article 17's inbox and effect identity share a hash helper; Article 1's audit
re-derives the provider key with the minting helper; Article 7's `Ledger.post`
and `Ledger.isBalanced` both call `sumPostings`; Article 21's `reproduce()`
recomputes a manifest hash with the function that produced it. In every case a
bug in the shared helper is invisible, because the error and the check agree.

## Decision

`src/seams.ts` imports two declarations — the authority map and the transition
list — and the trace reader. It imports no component. Its `signedMinor` is a
second implementation written against the trace's own fields, and it throws on
a direction it does not recognise rather than defaulting.

The ledger's own `post` and `isBalanced` deliberately keep sharing
`normaliseMinor`, because leaving the defect in place is the only way to
measure what it costs.

## The measurement

`controlPostedAmountMismatch` replaces `normaliseMinor` with a truncation to
whole currency units. Both legs of every pair move together, so:

- `Ledger.isBalanced('op_cap_1')` returns **true**;
- the auditor returns **`S11_POSTED_AMOUNT_MISMATCH`**.

The difference is not that the auditor is cleverer. It is that the auditor
compares the postings against the command that caused them, and the ledger has
never seen a command. An independent check needs an independent *input*, not
merely independent code.

## Consequences

- `S06_UNBALANCED_JOURNAL` and `S11_POSTED_AMOUNT_MISMATCH` are separate codes
  because they fail in different circumstances: a dropped leg trips S06 and not
  S11, a symmetric arithmetic error trips S11 and not S06.
- Two sign conventions now exist and could drift apart. Test `A08` pins the
  auditor's behaviour on an unrecognised direction; nothing pins the two
  implementations to each other, deliberately, because pinning them would
  reintroduce the coupling this decision removes.
- The auditor cannot check anything the platform did not write down. That is
  the cost, and it is the same cost an auditor has in production.
