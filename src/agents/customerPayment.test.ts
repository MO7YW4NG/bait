import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeBuyerResult, normalizeGuardResult,
  type ABuyerResult, type BuyerFactoryPort, type GuardedFetchPort
} from './customerPayment.js';

const receipt = {
  txHash: '0x' + 'b'.repeat(64),
  amountAtomic: 10_000n,
  simulated: true
};
const paid = (override: Record<string, unknown> = {}): ABuyerResult => ({
  blocked: false, outcome: 'paid', status: 200,
  body: { city: 'Taipei' }, settlement: receipt,
  network: 'eip155:84532', ...override
} as ABuyerResult);

test('A Buyer paid with receipt becomes a paid Customer result', () => {
  const normalized = normalizeBuyerResult(paid());
  assert.equal(normalized.kind, 'allowed');
  if (normalized.kind === 'allowed') {
    assert.equal(normalized.result.settlement?.amountAtomic, 10_000n);
  }
});
test('A Buyer paid without receipt is never accepted as successful payment', () => {
  const result = normalizeBuyerResult(paid({ settlement: undefined }));
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.match(result.reason, /without a settlement/);
});
test('A Buyer failure (status 0) is not a settled payment', () => {
  const result = normalizeBuyerResult({
    blocked: false, outcome: 'failed', status: 0,
    body: null, error: 'facilitator timeout', network: 'eip155:84532'
  });
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') {
    assert.equal(result.result?.settlement, undefined);
    assert.match(result.reason, /facilitator timeout/);
  }
});
test('A failed result with receipt retains charge for manual reconciliation', () => {
  const result = normalizeBuyerResult({
    blocked: false, outcome: 'failed', status: 200,
    body: null, error: 'response lost', network: 'eip155:84532',
    settlement: receipt
  });
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.equal(result.result?.settlement?.amountAtomic, 10_000n);
});
test('A Guard blocked result carries its specific block source', () => {
  const result = normalizeGuardResult({
    allowed: false, reason: 'risky merchant',
    result: { blocked: true, outcome: 'blocked', blockedBy: 'guard', reason: 'risky merchant' }
  });
  assert.deepEqual(result, { kind: 'blocked', blockedBy: 'guard', reason: 'risky merchant' });
});
test('A spend-cap refusal is distinguished from Guard risk blocking', () => {
  const result = normalizeGuardResult({
    allowed: false, reason: 'cap',
    result: { blocked: true, outcome: 'blocked', blockedBy: 'spend_cap', reason: 'cap' }
  });
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.equal(result.blockedBy, 'spend_cap');
});
test('A Guard allowed:true with failed Buyer never becomes paid', () => {
  const result = normalizeGuardResult({
    allowed: true,
    result: { blocked: false, outcome: 'failed', status: 402, body: {},
      network: 'eip155:84532', error: 'facilitator rejected' }
  });
  assert.equal(result.kind, 'failed');
});
test('A Guard claiming blocked after settlement remains an unverified paid receipt', () => {
  const result = normalizeGuardResult({
    allowed: false,
    result: paid()
  });
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.equal(result.result?.settlement?.amountAtomic, 10_000n);
});
test('Unexpected free 200 on paid merchant endpoint is not a paid result', () => {
  const result = normalizeBuyerResult({
    blocked: false, outcome: 'free', status: 200, body: {},
    network: 'eip155:84532'
  });
  assert.equal(result.kind, 'failed');
});
test('Invalid network and settlement amount are rejected', () => {
  assert.throws(() => normalizeBuyerResult(paid({ network: 'eip155:1' })), /Base Sepolia/);
  assert.throws(() => normalizeBuyerResult(paid({
    settlement: { ...receipt, amountAtomic: -1n }
  })), /invalid settlement/);
});
test('B3 port types accept decimal-string caps and atomic bigint quotes', async () => {
  const caps: string[] = [];
  const factory: BuyerFactoryPort = opts => {
    caps.push(opts.maxPriceUsdc);
    return { payAndFetch: async () => paid() };
  };
  const buyer = factory({ privateKey: '0x' + '1'.repeat(64), maxPriceUsdc: '0.10' });
  await buyer.payAndFetch('https://merchant.test', 'request-1');
  assert.deepEqual(caps, ['0.10']);
  const quotes: bigint[] = [];
  const guarded: GuardedFetchPort = async (_url, opts) => {
    quotes.push(opts.quotedAtomic);
    return { allowed: false, result: { blocked: true, outcome: 'blocked',
      blockedBy: 'guard', reason: 'price changed' } };
  };
  await guarded('https://merchant.test', {
    privateKey: '0x' + '1'.repeat(64), requestId: 'request-1',
    feedUrl: 'https://feed.test', minScore: 0.6, maxPriceUsdc: '0.10',
    quotedAtomic: 10_000n, failClosed: true
  });
  assert.deepEqual(quotes, [10_000n]);
});
