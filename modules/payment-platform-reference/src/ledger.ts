/**
 * A minimal double-entry ledger.
 *
 * Article 14 owns postings, balances, reversals and audit export on Spanner.
 * Nothing here extends that design; this is the smallest ledger the
 * integration needs in order to have something for the seam auditor to
 * disagree with.
 *
 * One structural detail is deliberate and is the subject of ADR-004.
 * `post` and `isBalanced` share `normaliseMinor`. That is the defect shape
 * this programme keeps rediscovering -- a checker that shares arithmetic with
 * the thing it checks -- and it is left in on purpose so that the independence
 * control in `make seams` can demonstrate what it costs. The ledger's own
 * balance check stays green under a mutation that changes every stored
 * amount, because both sides of the equation move together.
 */
import type { Posting, PostingDirection } from './types.ts';

export interface LedgerOptions {
  /** Mutation hook. The identity function is the correct implementation. */
  normaliseMinor?: (amountMinor: number) => number;
}

export interface PostingLeg {
  account: string;
  direction: PostingDirection;
  amountMinor: number;
}

export class Ledger {
  private readonly postings: Posting[] = [];
  private seq = 0;
  private readonly normalise: (n: number) => number;

  constructor(options: LedgerOptions = {}) {
    this.normalise = options.normaliseMinor ?? ((n) => n);
  }

  /** DEBIT is positive, CREDIT is negative. Both callers go through here. */
  private signedMinor(p: { direction: PostingDirection; amountMinor: number }): number {
    const n = this.normalise(p.amountMinor);
    return p.direction === 'DEBIT' ? n : -n;
  }

  post(operationId: string, currency: string, legs: PostingLeg[]): Posting[] {
    const written: Posting[] = [];
    for (const leg of legs) {
      this.seq += 1;
      const posting: Posting = {
        postingId: `post_${String(this.seq).padStart(4, '0')}`,
        operationId,
        account: leg.account,
        direction: leg.direction,
        amountMinor: this.normalise(leg.amountMinor),
        currency,
      };
      this.postings.push(posting);
      written.push(posting);
    }
    return written;
  }

  /** The ledger's own invariant. Shares `signedMinor` with `post`. */
  isBalanced(operationId: string): boolean {
    const mine = this.postings.filter((p) => p.operationId === operationId);
    if (mine.length === 0) return true;
    return mine.reduce((acc, p) => acc + this.signedMinor(p), 0) === 0;
  }

  all(): readonly Posting[] {
    return this.postings;
  }

  balance(account: string): number {
    return this.postings
      .filter((p) => p.account === account)
      .reduce((acc, p) => acc + this.signedMinor(p), 0);
  }

  accounts(): string[] {
    return [...new Set(this.postings.map((p) => p.account))].sort();
  }
}

/** The legs for each kind of money movement. Kept in one place on purpose. */
export const LEGS = {
  capture(amountMinor: number): PostingLeg[] {
    return [
      { account: 'provider_receivable', direction: 'DEBIT', amountMinor },
      { account: 'merchant_revenue', direction: 'CREDIT', amountMinor },
    ];
  },
  refund(amountMinor: number): PostingLeg[] {
    return [
      { account: 'merchant_refunds', direction: 'DEBIT', amountMinor },
      { account: 'provider_receivable', direction: 'CREDIT', amountMinor },
    ];
  },
  reversal(amountMinor: number): PostingLeg[] {
    return [
      { account: 'merchant_revenue', direction: 'DEBIT', amountMinor },
      { account: 'provider_receivable', direction: 'CREDIT', amountMinor },
    ];
  },
  settlement(grossMinor: number, feeMinor: number): PostingLeg[] {
    return [
      { account: 'bank_cash', direction: 'DEBIT', amountMinor: grossMinor - feeMinor },
      { account: 'provider_fees', direction: 'DEBIT', amountMinor: feeMinor },
      { account: 'provider_receivable', direction: 'CREDIT', amountMinor: grossMinor },
    ];
  },
};
