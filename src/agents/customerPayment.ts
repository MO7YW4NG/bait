/**
 * B3-only boundary for A's production x402 Buyer / Guard.
 *
 * These ports mirror A's merged main exports. customer.ts statically imports
 * A's real SDK and pnpm check verifies assignability. No fake fallback.
 */
import type { PaymentOutcome, PaymentResult, Settlement } from './customerCore.js';

export type ABuyerResult =
  | {
      blocked: true;
      outcome: 'blocked';
      blockedBy: 'guard' | 'spend_cap';
      reason: string;
      status?: number;
      requiredAtomic?: bigint;
    }
  | {
      blocked: false;
      outcome: 'paid' | 'free' | 'failed';
      status: number;
      body: unknown;
      settlement?: Settlement;
      error?: string;
      network: 'eip155:84532';
      requiredAtomic?: bigint;
    };

export type BuyerFactoryPort = (options: {
  privateKey: string;
  maxPriceUsdc: string;
}) => {
  payAndFetch(url: string, requestId: string): Promise<ABuyerResult>;
};

export type GuardedFetchPort = (url: string, options: {
  privateKey: string;
  requestId: string;
  feedUrl: string;
  minScore: number;
  maxPriceUsdc: string;
  quotedAtomic: bigint;
  failClosed?: boolean;
}) => Promise<{ allowed: boolean; reason?: string; result: ABuyerResult }>;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A payment adapter returned a non-object');
  }
  return value as Record<string, unknown>;
}

function settlementFrom(value: unknown): Settlement | undefined {
  if (value === undefined) return undefined;
  const s = record(value);
  if (typeof s.txHash !== 'string' || !/^0x(?:mock)?[0-9a-f]+$/i.test(s.txHash) ||
    typeof s.amountAtomic !== 'bigint' || s.amountAtomic < 0n) {
    throw new Error('A returned an invalid settlement receipt');
  }
  // The receipt is the source of truth. Never drop an observed charge because
  // an earlier price cap or a later HTTP operation malfunctioned.
  return {
    txHash: s.txHash,
    amountAtomic: s.amountAtomic,
    simulated: s.simulated === true || /^0xmock/i.test(s.txHash)
  };
}

function paymentFrom(value: Record<string, unknown>): PaymentResult {
  if (typeof value.status !== 'number' || !Number.isInteger(value.status) ||
    value.status < 0 || value.status > 599) {
    throw new Error('A returned an invalid payment status');
  }
  if (value.network !== 'eip155:84532') {
    throw new Error('A returned a payment outside Base Sepolia');
  }
  const settlement = settlementFrom(value.settlement);
  return {
    status: value.status,
    body: value.body,
    network: 'eip155:84532',
    ...(settlement === undefined ? {} : { settlement }),
    ...(typeof value.requiredAtomic === 'bigint'
      ? { requiredAtomic: value.requiredAtomic } : {})
  };
}

export function normalizeBuyerResult(raw: ABuyerResult): PaymentOutcome {
  const data = record(raw);
  if (data.blocked === true) {
    if (data.outcome !== 'blocked' ||
      (data.blockedBy !== 'guard' && data.blockedBy !== 'spend_cap')) {
      throw new Error('A returned an invalid blocked outcome');
    }
    if (data.settlement !== undefined) {
      // This is an inconsistent receipt. Do not misreport it as a clean block.
      const confirmed = settlementFrom(data.settlement);
      return {
        kind: 'failed',
        reason: 'A marked a settled payment blocked; manual reconciliation required',
        result: { status: 0, body: null, network: 'eip155:84532', settlement: confirmed }
      };
    }
    // A uses blockedBy:"guard" for both risk denials and mandatory payment
    // policy enforcement. Invalid network/asset/scheme MUST NOT inflate B3's
    // risk-block metric, even if a merchant changes terms after preflight.
    if (data.blockedBy === 'guard' && typeof data.reason === 'string' &&
      /^(?:unsupported payment (?:network|asset)|unsupported x402 payment scheme|invalid USDC atomic amount|missing x402 PAYMENT-REQUIRED challenge|invalid x402 PAYMENT-REQUIRED challenge|x402 challenge has no accepted payment requirements)/i.test(data.reason)) {
      return { kind: 'failed', reason: 'Payment safety policy rejected: ' + data.reason };
    }
    return {
      kind: 'blocked',
      blockedBy: data.blockedBy,
      reason: typeof data.reason === 'string' ? data.reason : 'pre-sign payment refusal'
    };
  }
  if (data.blocked !== false) {
    throw new Error('A payment result must include blocked:boolean');
  }
  const result = paymentFrom(data);
  if (data.outcome === 'paid' && result.settlement) {
    return { kind: 'allowed', result };
  }
  if (data.outcome === 'paid') {
    return { kind: 'failed', result, reason: 'A reported paid without a settlement receipt' };
  }
  if (data.outcome === 'failed') {
    return {
      kind: 'failed', result,
      reason: typeof data.error === 'string' ? data.error : 'A buyer payment failed'
    };
  }
  if (data.outcome === 'free') {
    return { kind: 'failed', result, reason: 'Expected an x402 payment but A reported a free response' };
  }
  throw new Error('A returned unknown payment outcome');
}

export function normalizeGuardResult(raw: {
  allowed: boolean; reason?: string; result: ABuyerResult
}): PaymentOutcome {
  const data = record(raw);
  if (typeof data.allowed !== 'boolean') {
    throw new Error('A Guard result must include allowed:boolean');
  }
  if (!data.result) throw new Error('A Guard result is missing the Buyer result');
  const normalized = normalizeBuyerResult(data.result as ABuyerResult);
  if (data.allowed === false) {
    if (normalized.kind === 'blocked') return normalized;
    return {
      kind: 'failed',
      reason: 'A Guard denied the payment but returned a non-blocked Buyer result',
      ...(normalized.result ? { result: normalized.result } : {})
    };
  }
  if (normalized.kind === 'blocked') {
    return { kind: 'failed', reason: 'A Guard allowed a blocked Buyer result' };
  }
  return normalized;
}
