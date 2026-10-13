// Inbound provider notifications, normalised without being flattened.
//
// Two providers reporting the same operation is not a duplicate. It is two
// parties telling you about their own side of two different attempts, and a
// handler that deduplicates on the operation id alone will discard one of
// them -- usually the one that mattered.

import { normalise } from "./providers.ts";
import type { AttemptOutcome } from "./types.ts";

export interface InboundWebhook {
  readonly provider: string;
  /** The provider's identity for this notification. Unique per provider only. */
  readonly eventId: string;
  readonly operationId: string;
  readonly rawCode: string;
  readonly providerRef?: string;
  readonly atMs: number;
}

export interface NormalisedEvent {
  readonly provider: string;
  readonly operationId: string;
  readonly outcome: AttemptOutcome;
  readonly normalisedReason: string;
  /** Kept, always. Two providers' "declined" are not the same fact. */
  readonly rawCode: string;
  readonly providerRef?: string;
  readonly atMs: number;
}

export type Acceptance = "ACCEPTED" | "DUPLICATE_EVENT";

function outcomeOf(rawCode: string): AttemptOutcome {
  switch (rawCode) {
    case "APPROVED": return "AUTHORIZED";
    case "DO_NOT_HONOUR": return "DECLINED";
    case "TIMEOUT": return "UNKNOWN";
    default: return "UNKNOWN";
  }
}

/**
 * De-duplicates on `(provider, eventId)` -- never on the operation alone.
 *
 * The composite key is the whole point. One operation can legitimately produce
 * a notification from each provider it was attempted against, and those are
 * two facts, not one fact twice.
 */
export class WebhookInbox {
  readonly #seen = new Set<string>();
  readonly #events: NormalisedEvent[] = [];
  #suppressed = 0;
  /** Negative control only: key on the operation, losing one provider's account. */
  readonly #dedupeOnOperationOnly: boolean;

  constructor(dedupeOnOperationOnly = false) {
    this.#dedupeOnOperationOnly = dedupeOnOperationOnly;
  }

  receive(w: InboundWebhook): Acceptance {
    const key = this.#dedupeOnOperationOnly
      ? w.operationId
      : `${w.provider}\u0000${w.eventId}`;
    if (this.#seen.has(key)) {
      this.#suppressed += 1;
      return "DUPLICATE_EVENT";
    }
    this.#seen.add(key);
    this.#events.push({
      provider: w.provider,
      operationId: w.operationId,
      outcome: outcomeOf(w.rawCode),
      normalisedReason: normalise(w.rawCode),
      rawCode: w.rawCode,
      providerRef: w.providerRef,
      atMs: w.atMs,
    });
    return "ACCEPTED";
  }

  /** Every event recorded for one operation, in arrival order. */
  forOperation(operationId: string): readonly NormalisedEvent[] {
    return this.#events.filter((e) => e.operationId === operationId);
  }

  /**
   * Operations that two providers have both reported as authorized.
   *
   * This is the shape of a double charge, and it is detectable here precisely
   * because the inbox kept both events instead of collapsing them.
   */
  doubleAuthorizations(): readonly string[] {
    const byOp = new Map<string, Set<string>>();
    for (const e of this.#events) {
      if (e.outcome !== "AUTHORIZED") continue;
      const set = byOp.get(e.operationId) ?? new Set<string>();
      set.add(e.provider);
      byOp.set(e.operationId, set);
    }
    return [...byOp.entries()].filter(([, p]) => p.size > 1).map(([op]) => op).sort();
  }

  get suppressedCount(): number {
    return this.#suppressed;
  }

  get acceptedCount(): number {
    return this.#events.length;
  }
}
