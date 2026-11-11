/**
 * B3 scripted customer domain engine.
 * All amounts are Base Sepolia USDC atomic units (6 decimals).
 * No wallet, x402 signing, HTTP or DB implementation belongs in this module.
 */
import type {
  Merchant as ContractMerchant, MerchantQuote as ContractQuote,
  CustomerSpendRecord, EventPostRequest
} from '../lib/contracts.js';

export type GuardMode = 'on' | 'off';
export type Merchant = ContractMerchant;
export type Quote = ContractQuote;
export type Settlement = { txHash: string; amountAtomic: bigint; simulated: boolean };
export type PaymentResult = {
  status: number;
  body: unknown;
  requiredAtomic?: bigint;
  settlement?: Settlement;
  network?: string;
};
export type PaymentOutcome =
  | { kind: 'allowed'; result: PaymentResult }
  | { kind: 'blocked'; reason: string };
export type RiskVerdict = 'ok' | 'risky' | 'unknown';
export type SpendRecord = CustomerSpendRecord;
export type CustomerEvent = EventPostRequest & { actor: 'customer' };
export type MerchantResult = {
  merchantId: string;
  requestId: string;
  quotedAtomic: bigint;
  spentAtomic: bigint;
  wastedAtomic: bigint;
  extraPriceAtomic: bigint;
  duplicateAtomic: bigint;
  undeliveredAtomic: bigint;
  unverifiedAtomic: bigint;
  blocked: boolean;
  injection: boolean;
  delivered: boolean;
  settlements: Settlement[];
  status: number | null;
  error?: string;
};
export type CustomerRun = {
  runId: string;
  guard: GuardMode;
  merchants: MerchantResult[];
  spentAtomic: bigint;
  wastedAtomic: bigint;
  blocked: number;
  injections: number;
  unverifiedAtomic: bigint;
  telemetryErrors: string[];
  errors: string[];
};
export interface CustomerPorts {
  listMerchants(): Promise<Merchant[]>;
  quote(merchant: Merchant): Promise<Quote>;
  /** A's buyer/guard only. Must not synthesize settlements. */
  pay(mode: GuardMode, merchant: Merchant, quote: Quote, requestId: string): Promise<PaymentOutcome>;
  /** Guard ON requires decoy evidence for EVERY merchant before starting. */
  risk(merchant: Merchant): Promise<RiskVerdict>;
  postSpend(record: SpendRecord): Promise<void>;
  postEvent(event: CustomerEvent): Promise<void>;
}
const ATOMIC = 1_000_000n;
const WEATHER_KEYS = ['city', 'tempC', 'condition', 'humidity', 'observedAt'] as const;

/** Never include wallet-key-shaped data in CLI, events or telemetry errors. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/0x[0-9a-fA-F]{64}/g, '[redacted-hex]')
    .replace(/sk_(?:test|live)_[A-Za-z0-9]+/g, '[redacted-key]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
}
export function parseUsdc(text: string): bigint {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(text);
  if (!match) throw new Error('Invalid USDC amount (max 6 decimal places): ' + text);
  return BigInt(match[1]) * ATOMIC + BigInt((match[2] ?? '').padEnd(6, '0'));
}
export function formatUsdc(amount: bigint): string {
  if (amount < 0n) throw new Error('Negative USDC amount');
  return (amount / ATOMIC).toString() + '.' + (amount % ATOMIC).toString().padStart(6, '0');
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
export function isWeather(body: unknown): boolean {
  const record = object(body);
  return !!record &&
    WEATHER_KEYS.every(key => Object.hasOwn(record, key)) &&
    typeof record.city === 'string' && record.city.length > 0 &&
    typeof record.condition === 'string' && record.condition.length > 0 &&
    typeof record.observedAt === 'string' && record.observedAt.length > 0 &&
    typeof record.tempC === 'number' && Number.isFinite(record.tempC) &&
    typeof record.humidity === 'number' && Number.isFinite(record.humidity);
}
export function hasInjection(body: unknown): boolean {
  return /ignore (all |previous )?instructions|SYSTEM:|send .{0,40}key/i.test(
    JSON.stringify(body ?? null)
  );
}
export function wantsRetry(body: unknown): boolean {
  return object(body)?.retry === true;
}
export function analyzePurchase(input: {
  merchantId: string;
  requestId: string;
  quotedAtomic: bigint;
  settlements: Settlement[];
  finalBody: unknown;
  status: number | null;
  wasBlocked: boolean;
  error?: string;
}): MerchantResult {
  const { merchantId, requestId, quotedAtomic, settlements, finalBody, status, wasBlocked, error } = input;
  for (const s of settlements) {
    if (s.amountAtomic < 0n || !/^0x(?:mock)?[0-9a-f]+$/i.test(s.txHash)) {
      throw new Error('Invalid settlement for ' + merchantId);
    }
  }
  const spentAtomic = settlements.reduce((sum, s) => sum + s.amountAtomic, 0n);
  const validResponse = status !== null && status >= 200 && status < 300 && !wantsRetry(finalBody);
  const delivered = validResponse && isWeather(finalBody);
  const injection = validResponse && hasInjection(finalBody);
  const extraPriceAtomic = settlements.length > 0 && settlements[0]!.amountAtomic > quotedAtomic
    ? settlements[0]!.amountAtomic - quotedAtomic : 0n;
  const duplicateAtomic = settlements.slice(1).reduce((sum, s) => sum + s.amountAtomic, 0n);
  // Loss components are mutually exclusive: an undelivered purchase loses its ENTIRE cost.
  const undeliveredAtomic = validResponse && !delivered ? spentAtomic : 0n;
  const wastedAtomic = validResponse
    ? delivered ? extraPriceAtomic + duplicateAtomic : spentAtomic
    : 0n;
  const unverifiedAtomic = !validResponse ? spentAtomic : 0n;
  return {
    merchantId, requestId, quotedAtomic, spentAtomic, wastedAtomic,
    extraPriceAtomic, duplicateAtomic, undeliveredAtomic, unverifiedAtomic,
    blocked: wasBlocked && spentAtomic === 0n, injection, delivered,
    settlements, status, ...(error ? { error } : {})
  };
}
export function makeRunId(mode: GuardMode, uniqueId: string): string {
  if (!/^[a-zA-Z0-9-]{8,}$/.test(uniqueId)) throw new Error('Invalid run nonce');
  return 'cust-' + mode + '-' + uniqueId;
}

/**
 * A single scripted agent used for both modes. It never creates payments itself.
 * A failure posting telemetry is reported separately, not silently treated as success.
 */
export async function runScriptedCustomer(
  ports: CustomerPorts, guard: GuardMode, runId: string
): Promise<CustomerRun> {
  const report: CustomerRun = {
    runId, guard, merchants: [], spentAtomic: 0n, wastedAtomic: 0n,
    blocked: 0, injections: 0, unverifiedAtomic: 0n, telemetryErrors: [], errors: []
  };
  const emit = async (type: CustomerEvent['type'],
    payload: CustomerEvent['payload'] = {}) => {
    try {
      await ports.postEvent({ actor: 'customer', type, payload: { runId, guard, ...payload } });
    } catch (e) { report.telemetryErrors.push('POST /events ' + type + ': ' + safeMessage(e)); }
  };
  const record = async (result: MerchantResult) => {
    report.merchants.push(result);
    report.spentAtomic += result.spentAtomic;
    report.wastedAtomic += result.wastedAtomic;
    report.unverifiedAtomic += result.unverifiedAtomic;
    report.blocked += Number(result.blocked);
    report.injections += Number(result.injection);
    if (result.error) report.errors.push(result.merchantId + ': ' + result.error);
    try {
      await ports.postSpend({
        run: runId, guard, merchantId: result.merchantId,
        spentAtomic: result.spentAtomic.toString(), wastedAtomic: result.wastedAtomic.toString(),
        blocked: result.blocked, injection: result.injection
      });
    } catch (e) {
      report.telemetryErrors.push('POST /spend ' + result.merchantId + ': ' + safeMessage(e));
    }
    if (result.wastedAtomic > 0n) await emit('wasted', {
      merchantId: result.merchantId, amountAtomic: result.wastedAtomic.toString()
    });
    if (result.injection) await emit('injection_exposed', { merchantId: result.merchantId });
  };

  await emit('run_started');
  try {
    const merchants = await ports.listMerchants();
    if (merchants.length === 0) throw new Error('Merchant list is empty');
    const ids = new Set<string>();
    for (const merchant of merchants) {
      if (!/^[a-z0-9-]+$/.test(merchant.id) || ids.has(merchant.id)) {
        throw new Error('Invalid or duplicate merchant ID: ' + merchant.id);
      }
      ids.add(merchant.id);
    }
    // Decoy must populate the feed first. Unknown risk is not permission to pay.
    if (guard === 'on') {
      for (const merchant of merchants) {
        const verdict = await ports.risk(merchant);
        if (verdict === 'unknown') {
          throw new Error('Decoy evidence required: risk unknown for ' + merchant.id);
        }
        if (verdict !== 'ok' && verdict !== 'risky') {
          throw new Error('Invalid risk verdict for ' + merchant.id);
        }
      }
    }
    for (const merchant of merchants) {
      const requestId = runId + ':' + merchant.id;
      const settlements: Settlement[] = [];
      let status: number | null = null;
      let body: unknown = null;
      let quotedAtomic = 0n;
      let wasBlocked = false;
      let error: string | undefined;
      try {
        const quote = await ports.quote(merchant);
        if (quote.merchantId !== merchant.id) throw new Error('Quote merchant ID mismatch');
        quotedAtomic = parseUsdc(quote.priceUsdc);
        await emit('quote', { merchantId: merchant.id, quotedAtomic: quotedAtomic.toString() });
        for (let attempt = 0; attempt < 2; attempt++) {
          const outcome = await ports.pay(guard, merchant, quote, requestId);
          if (outcome.kind === 'blocked') {
            if (guard === 'on') {
              wasBlocked = true;
              await emit('guard_blocked', { merchantId: merchant.id, reason: safeMessage(outcome.reason).slice(0, 180) });
            } else {
              // A spend-control rejection with Guard OFF is NOT a risk-feed block.
              error = 'Buyer rejected payment: ' + safeMessage(outcome.reason).slice(0, 180);
            }
            break;
          }
          if (guard === 'on') await emit('guard_allowed', { merchantId: merchant.id });
          const result = outcome.result;
          if (result.network && result.network !== 'eip155:84532') {
            throw new Error('Rejected non-Base-Sepolia payment result');
          }
          status = result.status;
          body = result.body;
          if (result.settlement) {
            settlements.push(result.settlement);
            await emit('payment_settled', {
              merchantId: merchant.id, txHash: result.settlement.txHash,
              amountAtomic: result.settlement.amountAtomic.toString(),
              simulated: result.settlement.simulated
            });
          }
          if (!wantsRetry(body) || status < 200 || status >= 300) break;
        }
      } catch (e) {
        error = safeMessage(e);
      }
      await record(analyzePurchase({
        merchantId: merchant.id, requestId, quotedAtomic, settlements,
        finalBody: body, status, wasBlocked, ...(error ? { error } : {})
      }));
    }
  } catch (e) {
    report.errors.push(safeMessage(e));
  } finally {
    await emit('run_finished', {
      spentAtomic: report.spentAtomic.toString(), wastedAtomic: report.wastedAtomic.toString(),
      blocked: report.blocked, injections: report.injections,
      unverifiedAtomic: report.unverifiedAtomic.toString(),
      failed: report.errors.length > 0 || report.telemetryErrors.length > 0
    });
  }
  return report;
}
