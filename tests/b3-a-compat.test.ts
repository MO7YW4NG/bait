import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBuyer } from '../src/lib/x402buyer.js';
import { checkBeforeSign } from '../src/guard/guardedFetch.js';

const ctx = {
  url: 'http://localhost:4021/m/price-switch/data',
  amountAtomic: 50_000n,
  payTo: '0x' + 'b'.repeat(40),
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  network: 'eip155:84532'
};

test('real A createBuyer initializes with a decimal-string per-payment cap (without sending payment)', () => {
  // This fixed test-only key is never funded; no network call is made.
  const buyer = createBuyer({
    privateKey: '0x' + '1'.repeat(64),
    maxPriceUsdc: '0.10'
  });
  assert.equal(typeof buyer.payAndFetch, 'function');
});

test('real A pre-sign Guard compares B3 quotedAtomic bigint to x402 amount', async () => {
  const previousFetch = globalThis.fetch;
  let feedCalls = 0;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    feedCalls++;
    const url = String(input);
    assert.match(url, /\/risk\?url=/);
    return new Response(JSON.stringify({
      merchantId: 'price-switch',
      score: 0.9, verdict: 'ok', flags: [], evidence: []
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const refusal = await checkBeforeSign(ctx, {
      feedUrl: 'http://localhost:4030',
      minScore: 0.6,
      quotedAtomic: 10_000n,
      failClosed: true
    });
    assert.match(refusal ?? '', /PRICE_CHANGE/);
    assert.equal(feedCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
