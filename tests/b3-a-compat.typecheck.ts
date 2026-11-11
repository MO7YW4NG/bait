/**
 * B3/A compile-only integration contract.
 * Excluded from B3's regular tsconfig; CI temporarily merges A before checking.
 * If A changes its argument or result types, this must fail compilation.
 */
import { createBuyer, type PayAndFetchResult } from '../src/lib/x402buyer.js';
import { guardedFetch, type GuardOptions } from '../src/guard/guardedFetch.js';
import type {
  ABuyerResult, BuyerFactoryPort, GuardedFetchPort
} from '../src/agents/customerPayment.js';

const actualBuyer: BuyerFactoryPort = createBuyer;
const actualGuard: GuardedFetchPort = guardedFetch;
declare const actualPayment: PayAndFetchResult;
const normalizedInput: ABuyerResult = actualPayment;

const guardOpts: GuardOptions = {
  feedUrl: 'http://localhost:4030',
  minScore: 0.6,
  quotedAtomic: 10_000n
};
void [actualBuyer, actualGuard, normalizedInput, guardOpts];
