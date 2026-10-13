/**
 * The integrated platform.
 *
 * Command handling, provider integration, durable state, event publication,
 * financial posting and read models are separate here, and the separation is
 * the point: each one is specified in depth by another article in the series,
 * and what this file contains is the wiring between them plus the decisions
 * that only the wiring forces.
 *
 * Everything is single-process and in-memory. `docs/MODEL.md` lists every way
 * that departs from the platform it describes.
 */
import type { Clock } from './clock.ts';
import { callbackEffectId, commandEffectId, requestHash } from './ids.ts';
import { LEGS, Ledger } from './ledger.ts';
import { ProviderSimulator } from './provider.ts';
import { isLegalTransition } from './authority.ts';
import { newTrace, record, type Trace } from './trace.ts';
import type {
  Allocation,
  Channel,
  IntentStatus,
  Operation,
  OperationKind,
  OperationState,
  PaymentIntent,
} from './types.ts';

/**
 * Control hooks. Every one of these is a deliberate defect used by a negative
 * control; the default platform sets none of them.
 */
export interface Mutations {
  /** The ledger writes a field the authority map gives to another component. */
  wrongWriterForPosting?: boolean;
  /** A callback applies an effect without resolving it to an operation. */
  skipCallbackResolution?: boolean;
  /** A posting is written for an operation with no provider effect behind it. */
  postWithoutEvidence?: boolean;
  /** An approved capture writes no posting. */
  skipPostingOnCapture?: boolean;
  /** The reporting read is served from a copy far outside its window. */
  staleReportingRead?: boolean;
  /** One leg of a posting pair is dropped. */
  unbalancedPosting?: boolean;
  /** A terminal operation is moved again. */
  allowIllegalTransition?: boolean;
  /** A read for one tenant is served another tenant's record. */
  allowCrossTenant?: boolean;
  /** A synthetic account number is written into a traced field. */
  leakCardholderData?: boolean;
  /** A settlement mismatch produces neither a match nor an exception. */
  skipSettlementException?: boolean;
  /** The ledger truncates every amount to whole currency units. */
  truncateLedgerAmounts?: boolean;
  /** A retry after an ambiguous result is routed to a second provider region. */
  failoverRegionOnRetry?: boolean;
}

export interface PlatformOptions {
  clock: Clock;
  provider?: ProviderSimulator;
  mutations?: Mutations;
  /** The region whose operational store is authoritative. */
  homeRegion?: string;
  /** The region a failover would send a retry to. */
  failoverRegion?: string;
  /** How far behind the reporting copy is, in milliseconds. */
  reportingLagMs?: number;
  /**
   * Resume from another platform instance. Models a process restart in which
   * the durable stores survive and the process memory does not: the operation
   * and intent records, the object index, the ledger and the trace carry over,
   * and nothing in flight does.
   */
  resumeFrom?: PaymentPlatform;
}

export interface CreateIntentRequest {
  intentId: string;
  tenantId: string;
  channel: Channel;
  currency: string;
  allocations: Allocation[];
  tokenRef: string;
}

export interface OperationRequest {
  operationId: string;
  intentId: string;
  tenantId: string;
  amountMinor: number;
  scripted?: 'APPROVED' | 'DECLINED' | 'TIMEOUT_BEFORE_SEND' | 'TIMEOUT_AFTER_SEND';
}

export interface OperationResult {
  decision: 'FIRST' | 'REPLAY' | 'CONFLICT' | 'REJECTED';
  state: OperationState;
  /** What the caller is told. The third value is the one that matters. */
  customerAnswer: 'DEFINITIVE_SUCCESS' | 'DEFINITIVE_FAILURE' | 'PENDING' | 'UNKNOWN';
  providerRef: string | null;
  reason: string | null;
}

export interface CallbackRequest {
  objectId: string;
  eventType: string;
  providerRef: string;
  amountMinor: number;
}

export interface CallbackResult {
  applied: boolean;
  reason: 'APPLIED' | 'DUPLICATE' | 'UNRESOLVED' | 'CONFLICT' | 'NOT_NEEDED';
  operationId: string | null;
}

const PAN_SHAPED = '4000000000000001'; // Luhn-invalid by construction. See docs/MODEL.md.

export class PaymentPlatform {
  readonly trace: Trace;
  readonly ledger: Ledger;
  readonly provider: ProviderSimulator;
  readonly intents: Map<string, PaymentIntent>;
  readonly operations: Map<string, Operation>;
  readonly exceptions: { code: string; providerRef: string; detail: string }[] = [];

  private readonly clock: Clock;
  private readonly mut: Mutations;
  private readonly homeRegion: string;
  private readonly failoverRegion: string;
  private readonly reportingLagMs: number;
  /** provider object id -> operation id. The join the callback path needs. */
  private readonly objectIndex: Map<string, string>;
  /** effect identity -> applied. The inbox, at the provider boundary. */
  private readonly appliedEffects: Map<string, number>;
  private eventSeq = 0;

  constructor(options: PlatformOptions) {
    this.clock = options.clock;
    this.mut = options.mutations ?? {};
    this.homeRegion = options.homeRegion ?? 'europe-west1';
    this.failoverRegion = options.failoverRegion ?? 'europe-west4';
    this.reportingLagMs = options.reportingLagMs ?? 2000;
    const prior = options.resumeFrom;
    this.provider = options.provider ?? prior?.provider ?? new ProviderSimulator();
    this.trace = prior ? prior.trace : newTrace();
    this.intents = new Map(prior ? prior.intents : []);
    this.operations = new Map(prior ? prior.operations : []);
    this.objectIndex = new Map(prior ? prior.objectIndex : []);
    this.appliedEffects = new Map(prior ? prior.appliedEffects : []);
    this.eventSeq = prior ? prior.eventSeq : 0;
    this.ledger =
      prior?.ledger ??
      new Ledger(
        this.mut.truncateLedgerAmounts
          ? { normaliseMinor: (n) => Math.trunc(n / 100) * 100 }
          : {},
      );
  }

  // ---------------------------------------------------------------- intents

  createIntent(req: CreateIntentRequest): PaymentIntent {
    const existing = this.intents.get(req.intentId);
    if (existing) return existing;
    const amountMinor = req.allocations.reduce((a, x) => a + x.amountMinor, 0);
    const intent: PaymentIntent = {
      intentId: req.intentId,
      tenantId: req.tenantId,
      channel: req.channel,
      currency: req.currency,
      amountMinor,
      allocations: req.allocations,
      authorityRegion: this.homeRegion,
      tokenRef: req.tokenRef,
      status: 'CREATED',
      capturedMinor: 0,
      refundedMinor: 0,
    };
    this.intents.set(intent.intentId, intent);
    record(this.trace, {
      at: this.clock.now(),
      kind: 'state',
      entity: 'intent',
      id: intent.intentId,
      tenantId: intent.tenantId,
      from: 'NONE',
      to: 'CREATED',
      writer: 'payment-api',
      field: 'intent.status',
    });
    if (this.mut.leakCardholderData) {
      record(this.trace, {
        at: this.clock.now(),
        kind: 'field',
        name: 'intent.debugPaymentMethod',
        value: PAN_SHAPED,
        writer: 'payment-api',
      });
    } else {
      record(this.trace, {
        at: this.clock.now(),
        kind: 'field',
        name: 'vault.tokenRef',
        value: intent.tokenRef,
        writer: 'card-vault',
      });
    }
    return intent;
  }

  // ------------------------------------------------------------- operations

  authorize(req: OperationRequest): OperationResult {
    return this.runOperation('AUTHORIZE', req);
  }

  capture(req: OperationRequest): OperationResult {
    return this.runOperation('CAPTURE', req);
  }

  refund(req: OperationRequest): OperationResult {
    return this.runOperation('REFUND', req);
  }

  reverse(req: OperationRequest): OperationResult {
    return this.runOperation('REVERSE', req);
  }

  private reject(
    kind: OperationKind,
    req: OperationRequest,
    hash: string,
    reason: string,
  ): OperationResult {
    record(this.trace, {
      at: this.clock.now(),
      kind: 'command',
      operationId: req.operationId,
      tenantId: req.tenantId,
      intentId: req.intentId,
      operationKind: kind,
      amountMinor: req.amountMinor,
      currency: this.intents.get(req.intentId)?.currency ?? 'XXX',
      requestHash: hash,
      decision: 'REJECTED',
    });
    return {
      decision: 'REJECTED',
      state: 'DECLINED_FINAL',
      customerAnswer: 'DEFINITIVE_FAILURE',
      providerRef: null,
      reason,
    };
  }

  private runOperation(kind: OperationKind, req: OperationRequest): OperationResult {
    const intent = this.intents.get(req.intentId);
    const hash = requestHash({
      intentId: req.intentId,
      kind,
      amountMinor: req.amountMinor,
      tenantId: req.tenantId,
    });
    if (!intent) return this.reject(kind, req, hash, 'unknown_intent');
    if (intent.tenantId !== req.tenantId && !this.mut.allowCrossTenant) {
      return this.reject(kind, req, hash, 'cross_tenant_denied');
    }

    const prior = this.operations.get(req.operationId);
    if (prior) {
      const decision = prior.requestHash === hash ? 'REPLAY' : 'CONFLICT';
      record(this.trace, {
        at: this.clock.now(),
        kind: 'command',
        operationId: req.operationId,
        tenantId: req.tenantId,
        intentId: req.intentId,
        operationKind: kind,
        amountMinor: req.amountMinor,
        currency: intent.currency,
        requestHash: hash,
        decision,
      });
      if (decision === 'CONFLICT') {
        return {
          decision,
          state: prior.state,
          customerAnswer: 'DEFINITIVE_FAILURE',
          providerRef: prior.providerRef,
          reason: 'request_hash_mismatch',
        };
      }
      return {
        decision,
        state: prior.state,
        customerAnswer: this.answerFor(prior.state),
        providerRef: prior.providerRef,
        reason: null,
      };
    }

    const guard = this.guardAmount(kind, intent, req.amountMinor);
    if (guard) return this.reject(kind, req, hash, guard);

    record(this.trace, {
      at: this.clock.now(),
      kind: 'command',
      operationId: req.operationId,
      tenantId: req.tenantId,
      intentId: req.intentId,
      operationKind: kind,
      amountMinor: req.amountMinor,
      currency: intent.currency,
      requestHash: hash,
      decision: 'FIRST',
    });

    const op: Operation = {
      operationId: req.operationId,
      tenantId: req.tenantId,
      intentId: req.intentId,
      kind,
      amountMinor: req.amountMinor,
      requestHash: hash,
      state: 'RECEIVED',
      providerRef: null,
    };
    this.operations.set(op.operationId, op);
    this.moveOperation(op, 'IN_FLIGHT');

    const response = this.provider.charge({
      endpointRegion: this.homeRegion,
      idempotencyKey: op.operationId,
      intentRef: intent.intentId,
      operationKind: kind,
      amountMinor: req.amountMinor,
      currency: intent.currency,
      scripted: req.scripted ?? 'APPROVED',
    });

    record(this.trace, {
      at: this.clock.now(),
      kind: 'provider_call',
      operationId: op.operationId,
      endpointRegion: this.homeRegion,
      idempotencyKey: op.operationId,
      outcome: response.outcome,
      providerRef: response.providerRef,
    });

    if (response.outcome === 'APPROVED' && response.providerRef && response.objectId) {
      this.acceptEffect(op, intent, response.providerRef, response.objectId, this.homeRegion);
      return {
        decision: 'FIRST',
        state: op.state,
        customerAnswer: 'DEFINITIVE_SUCCESS',
        providerRef: op.providerRef,
        reason: null,
      };
    }
    if (response.outcome === 'DECLINED') {
      this.moveOperation(op, 'DECLINED_FINAL');
      if (kind === 'AUTHORIZE') this.moveIntent(intent, 'FAILED');
      this.publish(op, intent, 'payment.declined');
      return {
        decision: 'FIRST',
        state: op.state,
        customerAnswer: 'DEFINITIVE_FAILURE',
        providerRef: null,
        reason: response.declineReason,
      };
    }
    // Both timeouts land here. The platform cannot tell them apart.
    this.moveOperation(op, 'OUTCOME_UNKNOWN');
    this.publish(op, intent, 'payment.outcome_unknown');
    return {
      decision: 'FIRST',
      state: op.state,
      customerAnswer: 'UNKNOWN',
      providerRef: null,
      reason: 'provider_timeout',
    };
  }

  private guardAmount(kind: OperationKind, intent: PaymentIntent, amountMinor: number): string | null {
    if (amountMinor <= 0) return 'non_positive_amount';
    if (kind === 'CAPTURE' && intent.capturedMinor + amountMinor > intent.amountMinor) {
      return 'capture_exceeds_authorised';
    }
    if (kind === 'REFUND' && intent.refundedMinor + amountMinor > intent.capturedMinor) {
      return 'refund_exceeds_captured';
    }
    if (kind === 'REVERSE' && amountMinor > intent.capturedMinor - intent.refundedMinor) {
      return 'reversal_exceeds_open_capture';
    }
    return null;
  }

  /** Attribute a provider effect and do whatever accounting it implies. */
  private acceptEffect(
    op: Operation,
    intent: PaymentIntent,
    providerRef: string,
    objectId: string,
    endpointRegion: string,
  ): void {
    op.providerRef = providerRef;
    this.objectIndex.set(objectId, op.operationId);
    record(this.trace, {
      at: this.clock.now(),
      kind: 'provider_effect',
      providerRef,
      objectId,
      operationKind: op.kind,
      amountMinor: op.amountMinor,
      currency: intent.currency,
      endpointRegion,
      attributedOperationId: op.operationId,
    });
    this.moveOperation(op, 'SUCCEEDED');
    this.applyAccounting(op, intent);
    this.publish(op, intent, `payment.${op.kind.toLowerCase()}_succeeded`);
  }

  private applyAccounting(op: Operation, intent: PaymentIntent): void {
    const writer = this.mut.wrongWriterForPosting ? 'reporting' : 'ledger';
    const writeLegs = (legs: ReturnType<typeof LEGS.capture>) => {
      const effective = this.mut.unbalancedPosting ? legs.slice(0, 1) : legs;
      const postings = this.ledger.post(op.operationId, intent.currency, effective);
      for (const p of postings) {
        record(this.trace, {
          at: this.clock.now(),
          kind: 'posting',
          postingId: p.postingId,
          operationId: p.operationId,
          tenantId: op.tenantId,
          account: p.account,
          direction: p.direction,
          amountMinor: p.amountMinor,
          currency: p.currency,
          writer,
          field: 'ledger.posting',
        });
      }
    };

    if (op.kind === 'AUTHORIZE') {
      // An authorisation moves no money. There is nothing to post.
      this.moveIntent(intent, 'AUTHORIZED');
      return;
    }
    if (op.kind === 'CAPTURE') {
      intent.capturedMinor += op.amountMinor;
      if (!this.mut.skipPostingOnCapture) writeLegs(LEGS.capture(op.amountMinor));
      this.moveIntent(
        intent,
        intent.capturedMinor >= intent.amountMinor ? 'CAPTURED' : 'PARTIALLY_CAPTURED',
      );
      return;
    }
    if (op.kind === 'REFUND') {
      intent.refundedMinor += op.amountMinor;
      writeLegs(LEGS.refund(op.amountMinor));
      this.moveIntent(
        intent,
        intent.refundedMinor >= intent.capturedMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
      );
      return;
    }
    if (op.kind === 'REVERSE') {
      intent.refundedMinor += op.amountMinor;
      writeLegs(LEGS.reversal(op.amountMinor));
      this.moveIntent(intent, 'REVERSED');
    }
  }

  // --------------------------------------------------------------- recovery

  /**
   * Resolve an ambiguous outcome by asking the provider what it knows.
   *
   * `failoverRegionOnRetry` sends the retry to a second regional endpoint
   * instead, which is the seam this module exists to show: the platform's own
   * failover is correct, the idempotency key is correct, and the two together
   * produce a second charge.
   */
  reconcileUnknown(operationId: string): OperationResult {
    const op = this.operations.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    const intent = this.intents.get(op.intentId);
    if (!intent) throw new Error(`unknown intent ${op.intentId}`);

    if (this.mut.failoverRegionOnRetry) {
      const response = this.provider.charge({
        endpointRegion: this.failoverRegion,
        idempotencyKey: op.operationId,
        intentRef: intent.intentId,
        operationKind: op.kind,
        amountMinor: op.amountMinor,
        currency: intent.currency,
        scripted: 'APPROVED',
      });
      record(this.trace, {
        at: this.clock.now(),
        kind: 'provider_call',
        operationId: op.operationId,
        endpointRegion: this.failoverRegion,
        idempotencyKey: op.operationId,
        outcome: response.outcome,
        providerRef: response.providerRef,
      });
      if (response.providerRef && response.objectId) {
        this.acceptEffect(op, intent, response.providerRef, response.objectId, this.failoverRegion);
      }
      return {
        decision: 'FIRST',
        state: op.state,
        customerAnswer: this.answerFor(op.state),
        providerRef: op.providerRef,
        reason: 'failover_retry',
      };
    }

    const found = this.provider.lookupByIdempotencyKey(this.homeRegion, op.operationId);
    record(this.trace, {
      at: this.clock.now(),
      kind: 'provider_call',
      operationId: op.operationId,
      endpointRegion: this.homeRegion,
      idempotencyKey: op.operationId,
      outcome: found ? (found.outcome === 'APPROVED' ? 'APPROVED' : 'DECLINED') : 'DECLINED',
      providerRef: found ? found.providerRef : null,
    });
    if (found && found.outcome === 'APPROVED') {
      this.acceptEffect(op, intent, found.providerRef, found.objectId, this.homeRegion);
      return {
        decision: 'FIRST',
        state: op.state,
        customerAnswer: 'DEFINITIVE_SUCCESS',
        providerRef: op.providerRef,
        reason: 'resolved_by_lookup',
      };
    }
    this.moveOperation(op, 'DECLINED_FINAL');
    this.publish(op, intent, 'payment.declined');
    return {
      decision: 'FIRST',
      state: op.state,
      customerAnswer: 'DEFINITIVE_FAILURE',
      providerRef: null,
      reason: 'no_provider_effect_found',
    };
  }

  /**
   * A provider callback. There is no operation id in it, so the first thing
   * that has to happen is the join, and nothing may be applied before it.
   */
  handleCallback(cb: CallbackRequest): CallbackResult {
    const effectId = callbackEffectId(cb.objectId, cb.eventType);
    const seen = this.appliedEffects.get(effectId);
    if (seen !== undefined) {
      record(this.trace, {
        at: this.clock.now(),
        kind: 'callback',
        objectId: cb.objectId,
        eventType: cb.eventType,
        resolvedOperationId: this.objectIndex.get(cb.objectId) ?? null,
        applied: false,
        effectId,
      });
      if (seen !== cb.amountMinor) {
        this.exceptions.push({
          code: 'CALLBACK_CONFLICT',
          providerRef: cb.providerRef,
          detail: `same object and event type, amount ${cb.amountMinor} != ${seen}`,
        });
        return { applied: false, reason: 'CONFLICT', operationId: this.objectIndex.get(cb.objectId) ?? null };
      }
      return { applied: false, reason: 'DUPLICATE', operationId: this.objectIndex.get(cb.objectId) ?? null };
    }

    let operationId = this.objectIndex.get(cb.objectId) ?? null;
    if (operationId === null && !this.mut.skipCallbackResolution) {
      const rec = this.provider.lookup(cb.providerRef);
      // The provider's record carries the key the platform sent, which is the
      // operation id. That is the only join available on this path.
      if (rec && this.operations.has(rec.idempotencyKey)) {
        operationId = rec.idempotencyKey;
        this.objectIndex.set(cb.objectId, operationId);
      }
    }

    const applied = this.mut.skipCallbackResolution ? true : operationId !== null;
    record(this.trace, {
      at: this.clock.now(),
      kind: 'callback',
      objectId: cb.objectId,
      eventType: cb.eventType,
      resolvedOperationId: this.mut.skipCallbackResolution ? null : operationId,
      applied,
      effectId,
    });
    if (!applied) return { applied: false, reason: 'UNRESOLVED', operationId: null };
    this.appliedEffects.set(effectId, cb.amountMinor);

    if (operationId === null) {
      // skipCallbackResolution: an effect applied with nothing to attribute it to.
      return { applied: true, reason: 'APPLIED', operationId: null };
    }
    const op = this.operations.get(operationId);
    const intent = op ? this.intents.get(op.intentId) : undefined;
    if (!op || !intent) return { applied: false, reason: 'UNRESOLVED', operationId: null };

    if (op.state === 'OUTCOME_UNKNOWN') {
      const rec = this.provider.lookup(cb.providerRef);
      if (rec && rec.outcome === 'APPROVED') {
        this.acceptEffect(op, intent, rec.providerRef, rec.objectId, rec.endpointRegion);
        return { applied: true, reason: 'APPLIED', operationId };
      }
      this.moveOperation(op, 'DECLINED_FINAL');
      return { applied: true, reason: 'APPLIED', operationId };
    }
    return { applied: true, reason: 'NOT_NEEDED', operationId };
  }

  // ----------------------------------------------------------- read models

  /** A read of the operational store. Authoritative, and tenant-scoped. */
  readOperational(intentId: string, actorTenantId: string): IntentStatus | null {
    const intent = this.intents.get(intentId);
    if (!intent) return null;
    const allowed = intent.tenantId === actorTenantId || Boolean(this.mut.allowCrossTenant);
    const at = this.clock.now();
    record(this.trace, {
      at,
      kind: 'read',
      store: 'operational',
      field: 'intent.status',
      asOfMs: at,
      tenantId: intent.tenantId,
      actorTenantId,
      allowed,
    });
    return allowed ? intent.status : null;
  }

  /** A read of the reporting copy. Behind by construction; declared as such. */
  readReporting(intentId: string, actorTenantId: string): IntentStatus | null {
    const intent = this.intents.get(intentId);
    if (!intent) return null;
    const lag = this.mut.staleReportingRead ? 60000 : this.reportingLagMs;
    const at = this.clock.now();
    record(this.trace, {
      at,
      kind: 'read',
      store: 'reporting',
      field: 'reporting.intentStatus',
      asOfMs: at - lag,
      tenantId: intent.tenantId,
      actorTenantId,
      allowed: true,
    });
    return intent.status;
  }

  // ------------------------------------------------------------- internals

  private answerFor(state: OperationState): OperationResult['customerAnswer'] {
    if (state === 'SUCCEEDED') return 'DEFINITIVE_SUCCESS';
    if (state === 'DECLINED_FINAL') return 'DEFINITIVE_FAILURE';
    if (state === 'OUTCOME_UNKNOWN') return 'UNKNOWN';
    return 'PENDING';
  }

  private moveOperation(op: Operation, to: OperationState): void {
    const from = op.state;
    if (!isLegalTransition(from, to) && !this.mut.allowIllegalTransition) {
      throw new Error(`illegal transition ${from} -> ${to} for ${op.operationId}`);
    }
    op.state = to;
    record(this.trace, {
      at: this.clock.now(),
      kind: 'state',
      entity: 'operation',
      id: op.operationId,
      tenantId: op.tenantId,
      from,
      to,
      writer: 'payment-api',
      field: 'operation.state',
    });
  }

  private moveIntent(intent: PaymentIntent, to: IntentStatus): void {
    const from = intent.status;
    intent.status = to;
    record(this.trace, {
      at: this.clock.now(),
      kind: 'state',
      entity: 'intent',
      id: intent.intentId,
      tenantId: intent.tenantId,
      from,
      to,
      writer: 'payment-api',
      field: 'intent.status',
    });
  }

  private publish(op: Operation, intent: PaymentIntent, eventType: string): void {
    this.eventSeq += 1;
    record(this.trace, {
      at: this.clock.now(),
      kind: 'event',
      eventType,
      operationId: op.operationId,
      intentId: intent.intentId,
      sequence: this.eventSeq,
    });
  }

  /** Used by the posting-without-evidence control. */
  postWithoutEvidence(operationId: string, currency: string, amountMinor: number): void {
    const postings = this.ledger.post(operationId, currency, LEGS.capture(amountMinor));
    for (const p of postings) {
      record(this.trace, {
        at: this.clock.now(),
        kind: 'posting',
        postingId: p.postingId,
        operationId: p.operationId,
        tenantId: 'tnt_alpha',
        account: p.account,
        direction: p.direction,
        amountMinor: p.amountMinor,
        currency: p.currency,
        writer: 'ledger',
        field: 'ledger.posting',
      });
    }
  }

  /**
   * Move an operation along an edge the transition list does not contain.
   * Refuses unless a control has asked for exactly that.
   */
  forceOperationState(operationId: string, to: OperationState): void {
    if (!this.mut.allowIllegalTransition) {
      throw new Error('forceOperationState requires the allowIllegalTransition control');
    }
    const op = this.operations.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    this.moveOperation(op, to);
  }

  /** Effect identity on the command path, exposed for the identity tests. */
  effectIdFor(operationId: string, kind: OperationKind): string {
    return commandEffectId(operationId, kind);
  }
}
