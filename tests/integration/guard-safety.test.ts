/**
 * B5 A-Guard pre-sign decision tests. A-owned modules are never modified.
 * No wallet import, signature, facilitator, settlement, HTTP server or DB writes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkBeforeSign, type GuardOptions } from '../../src/guard/guardedFetch.js';
import type { BeforeSignContext } from '../../src/lib/x402buyer.js';
import { BASE_SEPOLIA_USDC } from '../../src/lib/contracts.js';

const endpoint = 'https://example.test/m/honest/data';
const terms: BeforeSignContext = {
  url: endpoint, amountAtomic: 10_000n,
  payTo: '0x000000000000000000000000000000000000dEaD',
  asset: BASE_SEPOLIA_USDC, network: 'eip155:84532',
};
const options: GuardOptions = { feedUrl: 'http://127.0.0.1:65533',
  minScore: 0.6, quotedAtomic: 10_000n };
const unknown = { merchantId: null, score: 0.5, verdict: 'unknown', flags: [], evidence: [] };
const good = { merchantId: 'honest', score: 6 / 7, verdict: 'ok', flags: [], evidence: [] };
const bad = { merchantId: 'ghost', score: 1 / 7, verdict: 'risky',
  flags: ['NON_DELIVERY'], evidence: [{
    flag: 'NON_DELIVERY', by: 'rule', txHash: '0xmockabc', explorerUrl: null,
    quoted: '10000', charged: '10000', detail: 'missing data', ts: Date.now(),
  }] };

/** Substitute only the network read performed by the decision helper. */
async function withRisk<T>(value: unknown | Error, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => {
    if (value instanceof Error) throw value;
    return new Response(JSON.stringify(value), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try { return await run(); }
  finally { globalThis.fetch = previous; }
}

test('B5/A guard: deterministic risky verdict blocks at decision stage', async () => {
  const reason = await withRisk(bad, () => checkBeforeSign(terms, options));
  assert.match(reason ?? '', /risk score/i);
});

test('B5/A guard: feed disconnected defaults fail closed', async () => {
  const reason = await withRisk(new Error('simulated offline'), () => checkBeforeSign(terms, options));
  assert.match(reason ?? '', /risk feed unavailable/i);
});

test('B5/A guard: unknown high-value merchant is capped', async () => {
  const reason = await withRisk(unknown, () => checkBeforeSign({
    ...terms, amountAtomic: 30_000n,
  }, { ...options, quotedAtomic: undefined }));
  assert.match(reason ?? '', /unknown seller/i);
});

test('B5/A guard: live quote mismatch is blocked before approval', async () => {
  const reason = await withRisk(good, () => checkBeforeSign({
    ...terms, amountAtomic: 50_000n,
  }, options));
  assert.match(reason ?? '', /PRICE_CHANGE/);
});

test('B5/A guard: judge-only advisory does not block valid low-price merchant', async () => {
  const advisory = { ...good, flags: ['PROMPT_INJECTION'], evidence: [{
    flag: 'PROMPT_INJECTION', by: 'judge', txHash: null, explorerUrl: null,
    quoted: '10000', charged: '10000', detail: 'synthetic', ts: Date.now(),
  }] };
  const decision = await withRisk(advisory, () => checkBeforeSign(terms, options));
  assert.equal(decision, null);
});

test('B5/A safety: reject non-Base-Sepolia chain before signing', async () => {
  const decision = await withRisk(good, () => checkBeforeSign({
    ...terms, network: 'eip155:8453',
  }, options));
  assert.ok(decision, 'FAIL-CLOSED EXPECTED: non-testnet network was allowed by guard decision');
});

test('B5/A safety: reject unexpected payment asset before signing', async () => {
  const decision = await withRisk(good, () => checkBeforeSign({
    ...terms, asset: '0x0000000000000000000000000000000000000001',
  }, options));
  assert.ok(decision, 'FAIL-CLOSED EXPECTED: non-USDC asset was allowed by guard decision');
});
