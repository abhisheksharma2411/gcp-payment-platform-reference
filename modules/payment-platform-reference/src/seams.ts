/**
 * The seam auditor.
 *
 * Twelve coded findings about what the integrated platform got wrong in the
 * places where two individually correct components meet. Every one of them
 * requires records from at least two components, which is why none of the
 * component articles' own checks can produce them.
 *
 * Two restrictions make this an instrument rather than a test helper.
 *
 * 1. It reads the trace and the two declarations -- the authority map and the
 *    transition list -- and nothing else. It never touches a live store, so
 *    the same checks run over records a production system wrote.
 *
 * 2. It shares no arithmetic with the platform. `signedMinor` below is a
 *    second implementation of the ledger's sign convention, written against
 *    the trace's own fields. That duplication is deliberate: the recurring
 *    defect in this programme is a checker that calls the helper it is
 *    checking, and `make seams` includes a control that demonstrates exactly
 *    what that costs.
 */
import { AUTHORITY_MAP, isLegalTransition, TERMINAL_STATES } from './authority.ts';
import { entriesOfKind, type Trace } from './trace.ts';

export interface Finding {
  code: string;
  subject: string;
  detail: string;
}

export const SEAM_CODES: Record<string, string> = {
  S01_AUTHORITY_WRITE_VIOLATION: 'a component wrote a field the authority map gives to another',
  S02_UNRESOLVED_PROVIDER_REFERENCE: 'a provider callback applied an effect it could not attribute',
  S03_POSTING_WITHOUT_EVIDENCE: 'a ledger posting with no provider effect behind it',
  S04_EVIDENCE_WITHOUT_POSTING: 'a provider effect that moved money and was never posted',
  S05_STALE_READ_BEYOND_WINDOW: 'a non-authoritative copy read further behind than it is allowed to be',
  S06_UNBALANCED_JOURNAL: 'the postings for one operation do not sum to zero',
  S07_ILLEGAL_LIFECYCLE_TRANSITION: 'an operation moved along an edge the transition list does not contain',
  S08_CROSS_TENANT_ACCESS: 'a read served one tenant another tenant record',
  S09_CARDHOLDER_DATA_OUTSIDE_VAULT: 'an account-number-shaped value recorded outside the vault',
  S10_SETTLEMENT_UNEXPLAINED: 'a settlement line that was neither matched nor turned into an exception',
  S11_POSTED_AMOUNT_MISMATCH: 'the posted amount does not equal the amount the command asked for',
  S12_UNRECORDED_PROVIDER_EFFECT: 'settlement evidence of a provider effect the platform never recorded',
};

/** A second implementation of the sign convention. See the header. */
function signedMinor(direction: string, amountMinor: number): number {
  if (direction === 'DEBIT') return amountMinor;
  if (direction === 'CREDIT') return 0 - amountMinor;
  throw new Error(`unknown posting direction ${direction}`);
}

const MONEY_KINDS = new Set(['CAPTURE', 'REFUND', 'REVERSE']);
const DIGIT_RUN = /(?<![0-9])[0-9]{13,19}(?![0-9])/;

export function auditSeams(trace: Trace): Finding[] {
  const findings: Finding[] = [];
  const add = (code: string, subject: string, detail: string) =>
    findings.push({ code, subject, detail });

  const commands = entriesOfKind(trace, 'command');
  const states = entriesOfKind(trace, 'state');
  const effects = entriesOfKind(trace, 'provider_effect');
  const callbacks = entriesOfKind(trace, 'callback');
  const postings = entriesOfKind(trace, 'posting');
  const reads = entriesOfKind(trace, 'read');
  const lines = entriesOfKind(trace, 'settlement_line');
  const outcomes = entriesOfKind(trace, 'settlement_outcome');
  const fields = entriesOfKind(trace, 'field');

  // S01 -- the authority map is a declaration; writes are checked against it.
  const writerOf = new Map(AUTHORITY_MAP.map((r) => [r.field, r.writer]));
  for (const e of [...states, ...postings]) {
    const expected = writerOf.get(e.field);
    if (expected && expected !== e.writer) {
      add(
        'S01_AUTHORITY_WRITE_VIOLATION',
        e.field,
        `${e.writer} wrote a field owned by ${expected}`,
      );
    }
  }
  for (const f of fields) {
    const expected = writerOf.get(f.name);
    if (expected && expected !== f.writer) {
      add('S01_AUTHORITY_WRITE_VIOLATION', f.name, `${f.writer} wrote a field owned by ${expected}`);
    }
  }

  // S02 -- nothing may be applied on the callback path before the join.
  for (const c of callbacks) {
    if (c.applied && c.resolvedOperationId === null) {
      add('S02_UNRESOLVED_PROVIDER_REFERENCE', c.objectId, `${c.eventType} applied unattributed`);
    }
  }

  // S03 / S04 -- postings and provider evidence must agree about what exists.
  const attributed = new Set(
    effects.map((e) => e.attributedOperationId).filter((x): x is string => x !== null),
  );
  const refsWithEffect = new Set(effects.map((e) => e.providerRef));
  const postedOps = new Set(postings.map((p) => p.operationId));
  for (const op of postedOps) {
    if (op.startsWith('settle_')) {
      const ref = op.slice('settle_'.length);
      if (!refsWithEffect.has(ref)) {
        add('S03_POSTING_WITHOUT_EVIDENCE', op, `no provider effect for ${ref}`);
      }
      continue;
    }
    if (!attributed.has(op)) {
      add('S03_POSTING_WITHOUT_EVIDENCE', op, 'no provider effect attributed to this operation');
    }
  }
  for (const e of effects) {
    if (!MONEY_KINDS.has(e.operationKind)) continue;
    if (e.attributedOperationId === null) continue;
    if (!postedOps.has(e.attributedOperationId)) {
      add(
        'S04_EVIDENCE_WITHOUT_POSTING',
        e.providerRef,
        `${e.operationKind} ${e.amountMinor} ${e.currency} never posted`,
      );
    }
  }

  // S05 -- the declared divergence window is the whole point of the map.
  const windowOf = new Map(AUTHORITY_MAP.map((r) => [r.field, r.divergenceWindowMs]));
  for (const r of reads) {
    const window = windowOf.get(r.field);
    if (window === undefined) continue;
    const behind = r.at - r.asOfMs;
    if (behind > window) {
      add('S05_STALE_READ_BEYOND_WINDOW', r.field, `${behind}ms behind, window ${window}ms`);
    }
  }

  // S06 -- balance, computed here from the trace's own fields.
  const byOp = new Map<string, number>();
  for (const p of postings) {
    byOp.set(p.operationId, (byOp.get(p.operationId) ?? 0) + signedMinor(p.direction, p.amountMinor));
  }
  for (const [op, sum] of [...byOp.entries()].sort()) {
    if (sum !== 0) add('S06_UNBALANCED_JOURNAL', op, `signed postings sum to ${sum}`);
  }

  // S07 -- the transition list is a declaration, same as the authority map.
  for (const s of states) {
    if (s.entity !== 'operation') continue;
    if (TERMINAL_STATES.includes(s.from)) {
      add('S07_ILLEGAL_LIFECYCLE_TRANSITION', s.id, `left terminal state ${s.from}`);
      continue;
    }
    if (!isLegalTransition(s.from, s.to)) {
      add('S07_ILLEGAL_LIFECYCLE_TRANSITION', s.id, `${s.from} -> ${s.to} is not declared`);
    }
  }

  // S08 -- tenancy, checked on the record rather than on the caller's claim.
  for (const r of reads) {
    if (r.allowed && r.tenantId !== r.actorTenantId) {
      add('S08_CROSS_TENANT_ACCESS', r.field, `${r.actorTenantId} read ${r.tenantId}`);
    }
  }

  // S09 -- cardholder data is a shape, and the shape must stay in one place.
  for (const f of fields) {
    if (DIGIT_RUN.test(f.value.replace(/[ -]/g, '')) && f.writer !== 'card-vault') {
      add('S09_CARDHOLDER_DATA_OUTSIDE_VAULT', f.name, `written by ${f.writer}`);
    }
  }

  // S10 -- a line nobody decided about is worse than a line that failed.
  const decided = new Set(outcomes.map((o) => o.providerRef));
  for (const l of lines) {
    if (!decided.has(l.providerRef)) {
      add('S10_SETTLEMENT_UNEXPLAINED', l.providerRef, 'no match and no exception recorded');
    }
  }

  // S11 -- the independent check. The command said what the customer was
  // asked for; the postings say what the books recorded. Nothing in the
  // ledger can compare the two, because the ledger never saw the command.
  const legsByOp = new Map<string, number[]>();
  for (const p of postings) {
    const list = legsByOp.get(p.operationId) ?? [];
    list.push(p.amountMinor);
    legsByOp.set(p.operationId, list);
  }
  for (const c of commands) {
    if (c.decision !== 'FIRST') continue;
    if (!MONEY_KINDS.has(c.operationKind)) continue;
    const legs = legsByOp.get(c.operationId);
    if (!legs || legs.length === 0) continue;
    if (!legs.includes(c.amountMinor)) {
      add(
        'S11_POSTED_AMOUNT_MISMATCH',
        c.operationId,
        `command ${c.amountMinor}, postings ${legs.join('/')}`,
      );
    }
  }

  // S12 -- the only place a charge the platform never saw becomes visible.
  for (const l of lines) {
    if (!refsWithEffect.has(l.providerRef)) {
      add(
        'S12_UNRECORDED_PROVIDER_EFFECT',
        l.providerRef,
        `settlement reports ${l.grossMinor} ${l.currency} with no platform record`,
      );
    }
  }

  return findings;
}

export function codesOf(findings: Finding[]): string[] {
  return [...new Set(findings.map((f) => f.code))].sort();
}
