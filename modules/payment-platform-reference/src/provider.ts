/**
 * A deterministic provider simulator with regional endpoints.
 *
 * The regional split is not decoration. Adyen's API-idempotency page states
 * the limit plainly: "If you are targeting multiple regional endpoints
 * simultaneously, idempotency keys will not be checked for duplication in
 * other regions." So the key store below is per region, and a retry that
 * lands on a second endpoint is a second charge, exactly as it would be in
 * production. That is the behaviour this module exists to make visible.
 *
 * Two provider-side accounting rules are modelled because the same page
 * describes them: a capture cannot exceed the authorised amount, and the
 * total refunded value cannot exceed the captured amount. The platform has
 * the same two rules. Which of the two is authoritative is a seam, and the
 * answer the module takes is recorded in ADR-003.
 */
import type { OperationKind, ProviderOutcome } from './types.ts';

export interface ProviderResponse {
  outcome: ProviderOutcome;
  /** Null exactly when the platform did not learn of an effect. */
  providerRef: string | null;
  objectId: string | null;
  declineReason: string | null;
}

export interface ProviderRecord {
  providerRef: string;
  objectId: string;
  operationKind: OperationKind;
  amountMinor: number;
  currency: string;
  outcome: 'APPROVED' | 'DECLINED';
  endpointRegion: string;
  idempotencyKey: string;
  intentRef: string;
}

export interface ChargeRequest {
  endpointRegion: string;
  idempotencyKey: string;
  intentRef: string;
  operationKind: OperationKind;
  amountMinor: number;
  currency: string;
  /** Deterministic script. Nothing here is random. */
  scripted: ProviderOutcome;
}

export interface ProviderSimulatorOptions {
  /** When false, the per-region key store is shared, which no provider does. */
  perRegionKeys?: boolean;
  /** When false, the provider stops enforcing its own accounting rules. */
  enforceAccountingRules?: boolean;
}

export class ProviderSimulator {
  private readonly keys: Map<string, ProviderRecord> = new Map();
  private readonly records: Map<string, ProviderRecord> = new Map();
  private seq = 0;
  private readonly perRegionKeys: boolean;
  private readonly enforceRules: boolean;

  constructor(options: ProviderSimulatorOptions = {}) {
    this.perRegionKeys = options.perRegionKeys !== false;
    this.enforceRules = options.enforceAccountingRules !== false;
  }

  private keyOf(region: string, idempotencyKey: string): string {
    return this.perRegionKeys ? `${region}::${idempotencyKey}` : idempotencyKey;
  }

  private authorisedFor(intentRef: string): number {
    let total = 0;
    for (const r of this.records.values()) {
      if (r.intentRef === intentRef && r.outcome === 'APPROVED' && r.operationKind === 'AUTHORIZE') {
        total += r.amountMinor;
      }
    }
    return total;
  }

  private sumApproved(intentRef: string, kind: OperationKind): number {
    let total = 0;
    for (const r of this.records.values()) {
      if (r.intentRef === intentRef && r.outcome === 'APPROVED' && r.operationKind === kind) {
        total += r.amountMinor;
      }
    }
    return total;
  }

  charge(req: ChargeRequest): ProviderResponse {
    const slot = this.keyOf(req.endpointRegion, req.idempotencyKey);
    const seen = this.keys.get(slot);
    if (seen) {
      return {
        outcome: seen.outcome === 'APPROVED' ? 'APPROVED' : 'DECLINED',
        providerRef: seen.providerRef,
        objectId: seen.objectId,
        declineReason: null,
      };
    }

    if (req.scripted === 'TIMEOUT_BEFORE_SEND') {
      // Nothing reached the provider. No record, no key.
      return { outcome: 'TIMEOUT_BEFORE_SEND', providerRef: null, objectId: null, declineReason: null };
    }

    if (this.enforceRules) {
      const refusal = this.ruleRefusal(req);
      if (refusal) {
        return { outcome: 'DECLINED', providerRef: null, objectId: null, declineReason: refusal };
      }
    }

    this.seq += 1;
    const providerRef = `prov_${String(this.seq).padStart(4, '0')}`;
    const objectId = `obj_${String(this.seq).padStart(4, '0')}`;
    const outcome: 'APPROVED' | 'DECLINED' = req.scripted === 'DECLINED' ? 'DECLINED' : 'APPROVED';
    const rec: ProviderRecord = {
      providerRef,
      objectId,
      operationKind: req.operationKind,
      amountMinor: req.amountMinor,
      currency: req.currency,
      outcome,
      endpointRegion: req.endpointRegion,
      idempotencyKey: req.idempotencyKey,
      intentRef: req.intentRef,
    };
    this.keys.set(slot, rec);
    this.records.set(providerRef, rec);

    if (req.scripted === 'TIMEOUT_AFTER_SEND') {
      // The effect exists at the provider. The caller never hears about it.
      return { outcome: 'TIMEOUT_AFTER_SEND', providerRef: null, objectId: null, declineReason: null };
    }
    return {
      outcome: outcome === 'APPROVED' ? 'APPROVED' : 'DECLINED',
      providerRef,
      objectId,
      declineReason: outcome === 'DECLINED' ? 'scripted_decline' : null,
    };
  }

  private ruleRefusal(req: ChargeRequest): string | null {
    if (req.operationKind === 'CAPTURE') {
      const authorised = this.authorisedFor(req.intentRef);
      const captured = this.sumApproved(req.intentRef, 'CAPTURE');
      if (captured + req.amountMinor > authorised) return 'capture_exceeds_authorised';
    }
    if (req.operationKind === 'REFUND') {
      const captured = this.sumApproved(req.intentRef, 'CAPTURE');
      const refunded = this.sumApproved(req.intentRef, 'REFUND');
      if (refunded + req.amountMinor > captured) return 'refund_exceeds_captured';
    }
    return null;
  }

  /** Provider lookup, which is how an ambiguous outcome is resolved. */
  lookupByIdempotencyKey(region: string, idempotencyKey: string): ProviderRecord | null {
    return this.keys.get(this.keyOf(region, idempotencyKey)) ?? null;
  }

  lookup(providerRef: string): ProviderRecord | null {
    return this.records.get(providerRef) ?? null;
  }

  /** Everything the provider believes. Used to build the settlement file. */
  allApproved(): ProviderRecord[] {
    return [...this.records.values()].filter((r) => r.outcome === 'APPROVED');
  }
}
