/** Customer-owned preflight regression against A's merged network/asset policy. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE_SEPOLIA_USDC } from '../src/lib/contracts.js';
import { assertSepoliaTerms } from '../src/agents/customer.js';
import { normalizeBuyerResult, normalizeGuardResult } from '../src/agents/customerPayment.js';

const merchantUrl = 'http://127.0.0.1:4021/m/honest/data';
const canonical = {
  scheme: 'exact', network: 'eip155:84532', asset: BASE_SEPOLIA_USDC,
  amount: '10000', payTo: '0x000000000000000000000000000000000000dEaD',
  maxTimeoutSeconds: 120, extra: {}
};
type Terms = typeof canonical;
function challenge(accepts: Terms[]): Response {
  const required = {
    x402Version: 2, resource: {
      url: merchantUrl, description: 'weather', mimeType: 'application/json'
    }, accepts
  };
  return new Response(JSON.stringify({ error: 'payment required' }), {
    status: 402, headers: {
      'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64')
    }
  });
}
async function withChallenge(
  accepts: Terms[], action: () => Promise<void>
): Promise<void> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return challenge(accepts);
  }) as typeof fetch;
  try {
    await action();
    assert.equal(calls, 1, 'preflight must inspect exactly one unsigned challenge');
  } finally { globalThis.fetch = original; }
}
test('Customer preflight accepts canonical Base Sepolia USDC atomic requirement', async () => {
  await withChallenge([canonical], async () =>
    assert.doesNotReject(assertSepoliaTerms(merchantUrl, 'test-request', 100_000n)));
});
test('Customer preflight rejects non-Base-Sepolia network', async () => {
  await withChallenge([{ ...canonical, network: 'eip155:8453' }], async () =>
    assert.rejects(assertSepoliaTerms(merchantUrl, 'test-request', 100_000n), /Non-Base-Sepolia/));
});
test('Customer preflight rejects alternate token before Buyer / Guard invocation', async () => {
  await withChallenge([{ ...canonical, asset: '0x0000000000000000000000000000000000000001' }], async () =>
    assert.rejects(assertSepoliaTerms(merchantUrl, 'test-request', 100_000n), /asset rejected/));
});
test('Customer preflight rejects a mixed canonical + malicious token alternative', async () => {
  await withChallenge([canonical, { ...canonical, asset: '0x0000000000000000000000000000000000000001' }], async () =>
    assert.rejects(assertSepoliaTerms(merchantUrl, 'test-request', 100_000n), /asset rejected/));
});
test('Customer preflight rejects an over-cap atomic amount without float math', async () => {
  await withChallenge([{ ...canonical, amount: '100001' }], async () =>
    assert.rejects(assertSepoliaTerms(merchantUrl, 'test-request', 100_000n), /exceeds capped/));
});
test('A post-preflight network/asset refusal never becomes a risk-block statistic', () => {
  for (const reason of [
    'unsupported payment network: Base Sepolia only',
    'unsupported payment asset: Base Sepolia USDC only',
    'unsupported x402 payment scheme'
  ]) {
    const denied = {
      blocked: true as const, outcome: 'blocked' as const,
      blockedBy: 'guard' as const, reason
    };
    assert.equal(normalizeBuyerResult(denied).kind, 'failed');
    assert.equal(normalizeGuardResult({
      allowed: false, reason, result: denied
    }).kind, 'failed');
  }
});
