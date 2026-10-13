/**
 * The trace is the only thing the seam auditor is allowed to read.
 *
 * That restriction is the whole design. An auditor that reads the live stores
 * is a test helper: it can only ever run where the objects are in memory. An
 * auditor restricted to the records the platform chose to write can run in
 * production over the same records, and it fails loudly when the platform
 * chose not to write something -- which is itself the finding worth having.
 */
import type {
  Component,
  OperationKind,
  PostingDirection,
  ProviderOutcome,
} from './types.ts';

export interface CommandEntry {
  at: number;
  kind: 'command';
  operationId: string;
  tenantId: string;
  intentId: string;
  operationKind: OperationKind;
  amountMinor: number;
  currency: string;
  requestHash: string;
  decision: 'FIRST' | 'REPLAY' | 'CONFLICT' | 'REJECTED';
}

export interface StateEntry {
  at: number;
  kind: 'state';
  entity: 'operation' | 'intent';
  id: string;
  tenantId: string;
  from: string;
  to: string;
  writer: Component;
  field: string;
}

export interface ProviderCallEntry {
  at: number;
  kind: 'provider_call';
  operationId: string;
  endpointRegion: string;
  idempotencyKey: string;
  outcome: ProviderOutcome;
  /** Null when the platform never learned the provider's reference. */
  providerRef: string | null;
}

export interface ProviderEffectEntry {
  at: number;
  kind: 'provider_effect';
  providerRef: string;
  objectId: string;
  operationKind: OperationKind;
  amountMinor: number;
  currency: string;
  endpointRegion: string;
  /** The operation the platform attributed this effect to, if it could. */
  attributedOperationId: string | null;
}

export interface CallbackEntry {
  at: number;
  kind: 'callback';
  objectId: string;
  eventType: string;
  resolvedOperationId: string | null;
  applied: boolean;
  effectId: string;
}

export interface PostingEntry {
  at: number;
  kind: 'posting';
  postingId: string;
  operationId: string;
  tenantId: string;
  account: string;
  direction: PostingDirection;
  amountMinor: number;
  currency: string;
  writer: Component;
  field: string;
}

export interface ReadEntry {
  at: number;
  kind: 'read';
  store: string;
  field: string;
  /** The timestamp the read data was current as of. */
  asOfMs: number;
  tenantId: string;
  actorTenantId: string;
  allowed: boolean;
}

export interface SettlementEntry {
  at: number;
  kind: 'settlement_line';
  providerRef: string;
  grossMinor: number;
  feeMinor: number;
  netMinor: number;
  currency: string;
}

export interface SettlementOutcomeEntry {
  at: number;
  kind: 'settlement_outcome';
  providerRef: string;
  matched: boolean;
  exceptionCode: string | null;
}

export interface EventEntry {
  at: number;
  kind: 'event';
  eventType: string;
  operationId: string;
  intentId: string;
  sequence: number;
}

export interface FieldEntry {
  at: number;
  kind: 'field';
  /** A free-text field recorded somewhere. Scanned for cardholder data. */
  name: string;
  value: string;
  writer: Component;
}

export type TraceEntry =
  | CommandEntry
  | StateEntry
  | ProviderCallEntry
  | ProviderEffectEntry
  | CallbackEntry
  | PostingEntry
  | ReadEntry
  | SettlementEntry
  | SettlementOutcomeEntry
  | EventEntry
  | FieldEntry;

export interface Trace {
  entries: TraceEntry[];
}

export function newTrace(): Trace {
  return { entries: [] };
}

export function record(trace: Trace, entry: TraceEntry): void {
  trace.entries.push(entry);
}

export function entriesOfKind<K extends TraceEntry['kind']>(
  trace: Trace,
  kind: K,
): Extract<TraceEntry, { kind: K }>[] {
  return trace.entries.filter((e) => e.kind === kind) as Extract<
    TraceEntry,
    { kind: K }
  >[];
}

/** Human-readable rendering used by `make report`. Stable across runs. */
export function renderTrace(trace: Trace, isoOf: (ms: number) => string): string {
  const lines: string[] = [];
  for (const e of trace.entries) {
    const rest = Object.entries(e)
      .filter(([k]) => k !== 'at' && k !== 'kind')
      // Millisecond fields render as offsets. A raw epoch value is a
      // thirteen-digit run, and a payments repository should have no
      // thirteen-digit runs in it at all.
      .map(([k, v]) => `${k}=${k.endsWith('Ms') ? isoOf(Number(v)) : String(v)}`)
      .join(' ');
    lines.push(`${isoOf(e.at)}  ${e.kind.padEnd(18)} ${rest}`);
  }
  return lines.join('\n');
}
