/**
 * The audit timeline for one business operation id.
 *
 * Required scope asks the platform to expose this, and assembling it is where
 * the cardholder-data boundary and the audit requirement pull against each
 * other. The timeline is built from references only. Nothing in it resolves a
 * token, so the whole timeline can be read outside the cardholder-data
 * environment; the one component that could resolve the reference is the only
 * one that stays inside it. Article 20 owns that boundary.
 */
import type { Trace, TraceEntry } from './trace.ts';

export interface TimelineRow {
  at: number;
  kind: string;
  summary: string;
}

function touches(entry: TraceEntry, operationId: string, providerRefs: Set<string>, objectIds: Set<string>): boolean {
  switch (entry.kind) {
    case 'command':
      return entry.operationId === operationId;
    case 'state':
      return entry.entity === 'operation' && entry.id === operationId;
    case 'provider_call':
      return entry.operationId === operationId;
    case 'provider_effect':
      return entry.attributedOperationId === operationId || providerRefs.has(entry.providerRef);
    case 'callback':
      return entry.resolvedOperationId === operationId || objectIds.has(entry.objectId);
    case 'posting':
      return entry.operationId === operationId;
    case 'settlement_line':
      return providerRefs.has(entry.providerRef);
    case 'settlement_outcome':
      return providerRefs.has(entry.providerRef);
    case 'event':
      return entry.operationId === operationId;
    default:
      return false;
  }
}

function summarise(entry: TraceEntry): string {
  switch (entry.kind) {
    case 'command':
      return `${entry.operationKind} ${entry.amountMinor} ${entry.currency} -> ${entry.decision}`;
    case 'state':
      return `${entry.entity} ${entry.id}: ${entry.from} -> ${entry.to}`;
    case 'provider_call':
      return `${entry.endpointRegion} key=${entry.idempotencyKey} -> ${entry.outcome}`;
    case 'provider_effect':
      return `${entry.providerRef} ${entry.operationKind} ${entry.amountMinor} ${entry.currency}`;
    case 'callback':
      return `${entry.eventType} ${entry.objectId} applied=${entry.applied}`;
    case 'posting':
      return `${entry.direction} ${entry.account} ${entry.amountMinor} ${entry.currency}`;
    case 'settlement_line':
      return `${entry.providerRef} gross=${entry.grossMinor} fee=${entry.feeMinor}`;
    case 'settlement_outcome':
      return `${entry.providerRef} matched=${entry.matched} exception=${entry.exceptionCode ?? 'none'}`;
    case 'event':
      return `${entry.eventType} seq=${entry.sequence}`;
    default:
      return entry.kind;
  }
}

export function timelineFor(trace: Trace, operationId: string): TimelineRow[] {
  // Two passes: the first learns which provider references and object ids
  // belong to this operation, the second collects everything that mentions
  // them. A single pass would miss evidence that arrived before attribution.
  const providerRefs = new Set<string>();
  const objectIds = new Set<string>();
  for (const e of trace.entries) {
    if (e.kind === 'provider_call' && e.operationId === operationId && e.providerRef) {
      providerRefs.add(e.providerRef);
    }
    if (e.kind === 'provider_effect' && e.attributedOperationId === operationId) {
      providerRefs.add(e.providerRef);
      objectIds.add(e.objectId);
    }
    if (e.kind === 'callback' && e.resolvedOperationId === operationId) {
      objectIds.add(e.objectId);
    }
  }
  const rows: TimelineRow[] = [];
  for (const e of trace.entries) {
    if (!touches(e, operationId, providerRefs, objectIds)) continue;
    rows.push({ at: e.at, kind: e.kind, summary: summarise(e) });
  }
  return rows;
}
