/**
 * Settlement ingest and reconciliation, at the depth the integration needs.
 *
 * Article 19 owns settlement files, fees, bank deposits and the exception
 * workflow. What is here is the minimum required to make one point that only
 * the integrated view can make: settlement is the only place where a provider
 * effect the platform never recorded becomes visible at all.
 */
import type { Clock } from './clock.ts';
import { LEGS } from './ledger.ts';
import type { PaymentPlatform } from './platform.ts';
import type { ProviderSimulator } from './provider.ts';
import { entriesOfKind, record } from './trace.ts';
import type { SettlementLine } from './types.ts';

export interface SettlementFileOptions {
  /** Basis points taken as a fee on each approved movement. */
  feeBps?: number;
  /** Provider references whose gross amount is deliberately altered. */
  corrupt?: Record<string, number>;
}

/**
 * Build a settlement file from what the PROVIDER believes, not from what the
 * platform believes. That asymmetry is what makes the file evidence.
 */
export function buildSettlementFile(
  provider: ProviderSimulator,
  options: SettlementFileOptions = {},
): SettlementLine[] {
  const feeBps = options.feeBps ?? 250;
  const corrupt = options.corrupt ?? {};
  const lines: SettlementLine[] = [];
  for (const rec of provider.allApproved()) {
    if (rec.operationKind === 'AUTHORIZE' || rec.operationKind === 'VOID') continue;
    const gross = corrupt[rec.providerRef] ?? rec.amountMinor;
    const feeMinor = Math.floor((gross * feeBps) / 10000);
    lines.push({
      providerRef: rec.providerRef,
      grossMinor: gross,
      feeMinor,
      netMinor: gross - feeMinor,
      currency: rec.currency,
    });
  }
  lines.sort((a, b) => (a.providerRef < b.providerRef ? -1 : 1));
  return lines;
}

export interface IngestOptions {
  /** Record neither a match nor an exception. A negative control only. */
  skipException?: boolean;
}

export interface IngestSummary {
  matched: number;
  exceptions: number;
  lines: number;
}

/**
 * Compare each line against the platform's own provider-evidence records,
 * post the matched ones, and raise an exception for everything else.
 */
export function ingestSettlement(
  platform: PaymentPlatform,
  clock: Clock,
  lines: SettlementLine[],
  options: IngestOptions = {},
): IngestSummary {
  const effects = entriesOfKind(platform.trace, 'provider_effect');
  let matched = 0;
  let exceptions = 0;

  for (const line of lines) {
    record(platform.trace, {
      at: clock.now(),
      kind: 'settlement_line',
      providerRef: line.providerRef,
      grossMinor: line.grossMinor,
      feeMinor: line.feeMinor,
      netMinor: line.netMinor,
      currency: line.currency,
    });

    const effect = effects.find((e) => e.providerRef === line.providerRef);
    if (options.skipException) continue;

    if (!effect) {
      exceptions += 1;
      platform.exceptions.push({
        code: 'UNRECORDED_PROVIDER_EFFECT',
        providerRef: line.providerRef,
        detail: 'settlement reports an effect the platform has no record of',
      });
      record(platform.trace, {
        at: clock.now(),
        kind: 'settlement_outcome',
        providerRef: line.providerRef,
        matched: false,
        exceptionCode: 'UNRECORDED_PROVIDER_EFFECT',
      });
      continue;
    }

    if (effect.amountMinor !== line.grossMinor) {
      exceptions += 1;
      platform.exceptions.push({
        code: 'AMOUNT_MISMATCH',
        providerRef: line.providerRef,
        detail: `platform ${effect.amountMinor} != settlement ${line.grossMinor}`,
      });
      record(platform.trace, {
        at: clock.now(),
        kind: 'settlement_outcome',
        providerRef: line.providerRef,
        matched: false,
        exceptionCode: 'AMOUNT_MISMATCH',
      });
      continue;
    }

    matched += 1;
    record(platform.trace, {
      at: clock.now(),
      kind: 'settlement_outcome',
      providerRef: line.providerRef,
      matched: true,
      exceptionCode: null,
    });

    // A settlement posting is its own business operation, with its own id.
    const settleOp = `settle_${line.providerRef}`;
    const postings = platform.ledger.post(
      settleOp,
      line.currency,
      LEGS.settlement(line.grossMinor, line.feeMinor),
    );
    for (const p of postings) {
      record(platform.trace, {
        at: clock.now(),
        kind: 'posting',
        postingId: p.postingId,
        operationId: p.operationId,
        tenantId: 'settlement',
        account: p.account,
        direction: p.direction,
        amountMinor: p.amountMinor,
        currency: p.currency,
        // The ledger writes every posting. Settlement asks; it does not write.
        writer: 'ledger',
        field: 'ledger.posting',
      });
    }
  }

  return { matched, exceptions, lines: lines.length };
}
