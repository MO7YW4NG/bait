/** Runtime validation at HTTP boundaries, independent of TypeScript assertions. */
import assert from 'node:assert/strict';
import {
  BASE_SEPOLIA_NETWORK, FEED_EVENT_TYPES, RISK_FLAGS,
  parseAtomicString, quoteToAtomic,
} from '../../src/lib/contracts.js';

export type JsonObject = Record<string, unknown>;
export function object(value: unknown, label: string): JsonObject {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be a JSON object`);
  return value as JsonObject;
}
export function atomic(value: unknown, label: string): bigint {
  assert.equal(typeof value, 'string', `${label} must be an atomic-unit string`);
  return parseAtomicString(value as string);
}
function str(value: unknown, label: string): string {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  return value as string;
}
function timestamp(value: unknown, label: string): void {
  assert.ok(typeof value === 'number' && Number.isSafeInteger(value), `${label} must be a safe integer`);
  assert.ok((value as number) >= 1_577_836_800_000 && (value as number) <= Date.now() + 86_400_000,
    `${label} must be Unix milliseconds, not seconds`);
}
function flag(value: unknown): void {
  assert.ok(typeof value === 'string' && (RISK_FLAGS as readonly string[]).includes(value), `unknown risk flag: ${String(value)}`);
}
export function normalizeUrl(raw: string): string {
  const parsed = new URL(raw);
  assert.ok(['http:', 'https:'].includes(parsed.protocol), 'merchant URL must be HTTP(S)');
  assert.ok(!parsed.username && !parsed.password, 'merchant URL must not include credentials');
  return parsed.origin + (parsed.pathname.replace(/\/+$/, '') || '/');
}
export function validateSettlement(value: unknown): void {
  const s = object(value, 'settlement');
  const tx = str(s.txHash, 'settlement.txHash');
  assert.match(tx, /^0x(?:mock)?[a-f0-9]+$/i);
  atomic(s.amountAtomic, 'settlement.amountAtomic');
  assert.equal(typeof s.simulated, 'boolean');
  assert.equal(s.simulated, /^0xmock/i.test(tx), 'mock receipts must be simulated, real receipts must not');
  if (s.network !== undefined) assert.equal(s.network, BASE_SEPOLIA_NETWORK);
}
export function validateRisk(value: unknown): JsonObject {
  const r = object(value, 'risk');
  assert.ok(r.merchantId === null || typeof r.merchantId === 'string', 'merchantId must be string|null');
  assert.ok(typeof r.score === 'number' && Number.isFinite(r.score) && r.score >= 0 && r.score <= 1,
    'score must be numeric in [0,1]');
  assert.ok(['ok', 'risky', 'unknown'].includes(r.verdict as string), 'invalid verdict');
  assert.ok(Array.isArray(r.flags) && Array.isArray(r.evidence), 'flags/evidence arrays required');
  for (const f of r.flags as unknown[]) flag(f);
  for (const [i, item] of (r.evidence as unknown[]).entries()) {
    const e = object(item, `evidence[${i}]`);
    flag(e.flag);
    assert.ok(['rule', 'judge'].includes(e.by as string), 'invalid evidence source');
    assert.ok(e.txHash === null || typeof e.txHash === 'string');
    assert.ok(e.explorerUrl === null || typeof e.explorerUrl === 'string');
    atomic(e.quoted, `evidence[${i}].quoted`);
    atomic(e.charged, `evidence[${i}].charged`);
    str(e.detail, `evidence[${i}].detail`);
    timestamp(e.ts, `evidence[${i}].ts`);
    if (typeof e.txHash === 'string' && /^0xmock/i.test(e.txHash)) {
      assert.equal(e.explorerUrl, null, 'mock settlement must not have an explorer link');
    }
    if (typeof e.explorerUrl === 'string') {
      assert.match(e.txHash as string, /^0x[a-f0-9]{64}$/i);
      assert.equal(e.explorerUrl, `https://sepolia.basescan.org/tx/${e.txHash}`);
    }
  }
  if (r.merchantId === null) assert.equal(r.verdict, 'unknown');
  return r;
}
export function validateStats(value: unknown): JsonObject {
  const stats = object(value, 'stats');
  const off = object(stats.off, 'stats.off');
  const on = object(stats.on, 'stats.on');
  for (const [mode, entry] of [['off', off], ['on', on]] as const) {
    atomic(entry.spent, `${mode}.spent`);
    atomic(entry.wasted, `${mode}.wasted`);
  }
  assert.ok(Number.isSafeInteger(off.injections) && (off.injections as number) >= 0);
  assert.ok(Number.isSafeInteger(on.blocked) && (on.blocked as number) >= 0);
  return stats;
}
export function validateEvent(value: unknown): JsonObject {
  const e = object(value, 'event');
  assert.ok(Number.isSafeInteger(e.id) && (e.id as number) > 0, 'event.id must be positive integer');
  timestamp(e.ts, 'event.ts');
  str(e.actor, 'event.actor');
  assert.ok((FEED_EVENT_TYPES as readonly string[]).includes(e.type as string), 'event.type invalid');
  object(e.payload, 'event.payload');
  return e;
}
export function validateMerchant(value: unknown): JsonObject {
  const m = object(value, 'merchant');
  str(m.id, 'merchant.id'); str(m.name, 'merchant.name');
  str(m.quoteUrl, 'merchant.quoteUrl'); str(m.dataUrl, 'merchant.dataUrl');
  normalizeUrl(m.quoteUrl as string); normalizeUrl(m.dataUrl as string);
  return m;
}
export function validateQuote(value: unknown, expectedMerchantId: string): void {
  const q = object(value, 'merchant quote');
  assert.equal(q.merchantId, expectedMerchantId);
  str(q.product, 'quote.product'); str(q.description, 'quote.description');
  const atomicPrice = quoteToAtomic(str(q.priceUsdc, 'quote.priceUsdc'));
  if (q.priceAtomic !== undefined) assert.equal(atomic(q.priceAtomic, 'quote.priceAtomic'), atomicPrice);
}
export function validateWriteAck(value: unknown): void {
  const ack = object(value, 'API write acknowledgement');
  assert.equal(ack.ok, true);
  if (ack.id !== undefined) assert.ok(Number.isSafeInteger(ack.id) && (ack.id as number) > 0);
}
export function assertDemoTargets(value: unknown): void {
  const stats = validateStats(value);
  const off = object(stats.off, 'off'); const on = object(stats.on, 'on');
  assert.equal(atomic(off.spent, 'off.spent'), 100_000n, 'OFF spent must equal 0.100 USDC');
  assert.equal(atomic(off.wasted, 'off.wasted'), 60_000n, 'OFF wasted must equal 0.060 USDC');
  assert.equal(off.injections, 1, 'OFF injections must equal 1');
  assert.equal(atomic(on.spent, 'on.spent'), 10_000n, 'ON spent must equal 0.010 USDC');
  assert.equal(atomic(on.wasted, 'on.wasted'), 0n, 'ON wasted must equal zero');
  assert.equal(on.blocked, 4, 'ON blocked must equal 4');
}
