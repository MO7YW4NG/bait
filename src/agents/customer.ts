/**
 * B3 Customer Agent CLI. No x402 implementation lives here.
 *
 * Real payments: A's src/lib/x402buyer.ts and src/guard/guardedFetch.ts
 * are imported directly and checked at compile time (no mock fallback).
 * Scripted agent: pnpm customer --guard off|on --scripted
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { BASE_SEPOLIA_USDC } from '../lib/contracts.js';
import { createBuyer } from '../lib/x402buyer.js';
import { guardedFetch } from '../guard/guardedFetch.js';
import {
  formatUsdc, makeRunId, parseUsdc, runScriptedCustomer,
  type CustomerPorts, type GuardMode, type Merchant,
  type Quote, type RiskVerdict, type SpendRecord, type CustomerEvent
} from './customerCore.js';
import {
  normalizeBuyerResult, normalizeGuardResult,
  type BuyerFactoryPort, type GuardedFetchPort
} from './customerPayment.js';

type Configuration = {
  merchantUrl: URL; feedUrl: URL; rpcUrl: URL;
  privateKey: `0x${string}`; maxPriceUsdc: string; maxPriceAtomic: bigint; minScore: number;
};

const BASE_SEPOLIA_CHAIN_ID = '0x14a34'; // 84532
const EXPECTED_MERCHANTS = new Set(['honest', 'price-switch', 'ghost', 'double', 'injector']);
const EXPECTED_NETWORK = 'eip155:84532';

function requiredURL(env: string | undefined, fallback: string, name: string): URL {
  let url: URL;
  try { url = new URL(env ?? fallback); }
  catch { throw new Error('Invalid ' + name + ' URL'); }
  if (url.username || url.password || url.search || url.hash) throw new Error(name + ' URL cannot have credentials or query');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(name + ' URL must be HTTP(S)');
  return url;
}
function readConfiguration(env: NodeJS.ProcessEnv = process.env): Configuration {
  const privateKey = env.CUSTOMER_PRIVATE_KEY;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('CUSTOMER_PRIVATE_KEY must be a 32-byte hex wallet key (never print it)');
  }
  const maxAtomic = parseUsdc(env.MAX_PRICE_PER_CALL_USDC ?? '0.10');
  if (maxAtomic <= 0n || maxAtomic > 100_000n) {
    throw new Error('MAX_PRICE_PER_CALL_USDC must be > 0 and <= 0.10 (testnet cap)');
  }
  const minScore = Number(env.GUARD_MIN_SCORE ?? '0.6');
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    throw new Error('GUARD_MIN_SCORE must be a number between 0 and 1');
  }
  const merchantUrl = requiredURL(env.MERCHANT_URL, 'http://localhost:4021', 'MERCHANT_URL');
  const feedUrl = requiredURL(env.FEED_URL, 'http://localhost:4030', 'FEED_URL');
  for (const [name, value] of [['MERCHANT_URL', merchantUrl], ['FEED_URL', feedUrl]] as const) {
    if (value.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(value.hostname)) {
      throw new Error(name + ' must use HTTPS outside localhost');
    }
  }
  const rpcUrl = requiredURL(env.RPC_URL, 'https://sepolia.base.org', 'RPC_URL');
  if (rpcUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(rpcUrl.hostname)) {
    throw new Error('RPC_URL must use HTTPS outside localhost');
  }
  return {
    merchantUrl, feedUrl, rpcUrl,
    privateKey: privateKey as `0x${string}`,
    maxPriceUsdc: env.MAX_PRICE_PER_CALL_USDC ?? '0.10', maxPriceAtomic: maxAtomic, minScore
  };
}

async function jsonRequest(url: URL, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, {
    ...init, signal: init.signal ?? AbortSignal.timeout(12_000),
    headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers }
  });
  if (!response.ok) throw new Error(url.pathname + ' HTTP ' + response.status);
  return response.status === 204 ? null : response.json();
}
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Unexpected server response shape');
  }
  return value as Record<string, unknown>;
}
function merchantResource(urlText: string, config: Configuration, id: string, kind: 'quote' | 'data'): URL {
  const url = new URL(urlText, config.merchantUrl);
  if (url.origin !== config.merchantUrl.origin || url.pathname !== '/m/' + id + '/' + kind ||
    url.search || url.hash || url.username || url.password) {
    throw new Error('Merchant resource URL rejected: expected local ' + kind + ' endpoint for ' + id);
  }
  return url;
}
/**
 * Validate the first unauthenticated 402 using the official x402 decoder.
 * This is a network/scheme allowlist, NOT a buyer or a signing implementation.
 * A must independently enforce the same network inside the signing hook.
 */
export async function assertSepoliaTerms(urlText: string, requestId: string, cap: bigint): Promise<void> {
  const response = await fetch(urlText, {
    headers: { 'X-Request-Id': requestId },
    signal: AbortSignal.timeout(10_000)
  });
  if (response.status !== 402) {
    throw new Error('Paid merchant endpoint did not issue an x402 challenge');
  }
  const header = response.headers.get('PAYMENT-REQUIRED');
  if (!header) throw new Error('Missing x402 PAYMENT-REQUIRED header');
  const paymentRequired = decodePaymentRequiredHeader(header);
  if (!Array.isArray(paymentRequired.accepts) || paymentRequired.accepts.length === 0) {
    throw new Error('x402 challenge has no payment requirements');
  }
  for (const item of paymentRequired.accepts) {
    if (item.network !== EXPECTED_NETWORK || item.scheme !== 'exact') {
      throw new Error('Non-Base-Sepolia or non-exact x402 payment requirement rejected');
    }
    if (typeof item.asset !== 'string' ||
      item.asset.toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase()) {
      throw new Error('Non-Base-Sepolia-USDC x402 payment asset rejected');
    }
    if (!/^(0|[1-9][0-9]*)$/.test(item.amount) || BigInt(item.amount) > cap) {
      throw new Error('x402 challenge exceeds capped Base Sepolia USDC payment');
    }
  }
}
async function realPaymentPorts(
  config: Configuration, runGuard: GuardMode
): Promise<Pick<CustomerPorts, 'pay'>> {
  // A is now merged into main. Import its actual exports statically, so
  // pnpm check verifies SDK signatures instead of trusting dynamic casts.
  const buyerFactory: BuyerFactoryPort = createBuyer;
  const guardSdk: GuardedFetchPort = guardedFetch;
  const buyer = runGuard === 'off'
    ? buyerFactory({ privateKey: config.privateKey, maxPriceUsdc: config.maxPriceUsdc })
    : undefined;
  const capAtomic = config.maxPriceAtomic;
  return {
    pay: async (mode, merchant, quote, requestId) => {
      if (mode !== runGuard) throw new Error('Payment mode changed during the run');
      await assertSepoliaTerms(merchant.dataUrl, requestId, capAtomic);
      if (mode === 'off') {
        if (!buyer) throw new Error('Buyer unavailable');
        return normalizeBuyerResult(await buyer.payAndFetch(merchant.dataUrl, requestId));
      }
      return normalizeGuardResult(await guardSdk(merchant.dataUrl, {
        privateKey: config.privateKey, requestId, quotedAtomic: parseUsdc(quote.priceUsdc),
        feedUrl: config.feedUrl.toString().replace(/\/$/, ''),
        minScore: config.minScore, maxPriceUsdc: config.maxPriceUsdc, failClosed: true
      }));
    }
  };
}
async function verifyRpcChain(config: Configuration): Promise<void> {
  const result = asRecord(await jsonRequest(config.rpcUrl, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })
  }));
  if (result.result !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error('RPC chain ID is not Base Sepolia (84532). Refusing payments.');
  }
}
export async function createCustomerPorts(config: Configuration, guard: GuardMode): Promise<CustomerPorts> {
  await verifyRpcChain(config); // Must pass BEFORE calling the real wallet.
  const payment = await realPaymentPorts(config, guard);
  return {
    ...payment,
    async listMerchants(): Promise<Merchant[]> {
      const raw = await jsonRequest(new URL('/merchants', config.merchantUrl));
      if (!Array.isArray(raw) || raw.length !== EXPECTED_MERCHANTS.size) {
        throw new Error('Expected exactly five scripted demo merchants');
      }
      return raw.map(item => {
        const row = asRecord(item);
        if (typeof row.id !== 'string' || !EXPECTED_MERCHANTS.has(row.id) ||
          typeof row.name !== 'string' || typeof row.quoteUrl !== 'string' ||
          typeof row.dataUrl !== 'string') {
          throw new Error('Unexpected merchant listing (demo merchants only)');
        }
        const quoteUrl = merchantResource(row.quoteUrl, config, row.id, 'quote').toString();
        const dataUrl = merchantResource(row.dataUrl, config, row.id, 'data').toString();
        return { id: row.id, name: row.name, quoteUrl, dataUrl };
      });
    },
    async quote(merchant: Merchant): Promise<Quote> {
      const raw = asRecord(await jsonRequest(merchantResource(merchant.quoteUrl, config, merchant.id, 'quote')));
      if (raw.merchantId !== merchant.id ||
        typeof raw.priceUsdc !== 'string' ||
        typeof raw.product !== 'string' || typeof raw.description !== 'string') throw new Error('Invalid quote');
      const quotedAtomic = parseUsdc(raw.priceUsdc);
      if (raw.priceAtomic !== undefined &&
        (typeof raw.priceAtomic !== 'string' ||
         !/^(0|[1-9][0-9]*)$/.test(raw.priceAtomic) ||
         BigInt(raw.priceAtomic) !== quotedAtomic)) {
        throw new Error('Quote priceAtomic conflicts with displayed priceUsdc');
      }
      return {
        merchantId: merchant.id, product: raw.product,
        priceUsdc: raw.priceUsdc, description: raw.description,
        ...(typeof raw.priceAtomic === 'string' ? { priceAtomic: raw.priceAtomic } : {})
      };
    },
    async risk(merchant: Merchant): Promise<RiskVerdict> {
      const url = new URL('/risk', config.feedUrl);
      url.searchParams.set('url', merchant.dataUrl);
      const result = asRecord(await jsonRequest(url));
      if (result.verdict !== 'ok' && result.verdict !== 'risky' && result.verdict !== 'unknown') {
        throw new Error('Invalid risk feed verdict');
      }
      return result.verdict;
    },
    async postSpend(spend: SpendRecord): Promise<void> {
      await jsonRequest(new URL('/spend', config.feedUrl), {
        method: 'POST', body: JSON.stringify(spend)
      });
    },
    async postEvent(event: CustomerEvent): Promise<void> {
      await jsonRequest(new URL('/events', config.feedUrl), {
        method: 'POST', body: JSON.stringify(event)
      });
    }
  };
}
export function parseCli(args: string[]): { guard: GuardMode; scripted: true } {
  let guard: GuardMode | undefined;
  let scripted = false;
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--guard') {
      const value = args[++i];
      if (guard || (value !== 'on' && value !== 'off')) {
        throw new Error('--guard requires exactly one value: on or off');
      }
      guard = value;
    } else if (argument === '--scripted') {
      if (scripted) throw new Error('--scripted specified twice');
      scripted = true;
    } else {
      throw new Error('Unknown argument: ' + argument);
    }
  }
  if (!guard || !scripted) {
    throw new Error('Usage: pnpm customer --guard on|off --scripted (LLM mode is not implemented)');
  }
  return { guard, scripted: true };
}
export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const { guard } = parseCli(args);
    try { process.loadEnvFile?.('.env'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const config = readConfiguration();
    const ports = await createCustomerPorts(config, guard);
    const runId = makeRunId(guard, Date.now().toString() + '-' + randomUUID());
    const result = await runScriptedCustomer(ports, guard, runId);
    console.log(JSON.stringify({
      runId, guard,
      spent: formatUsdc(result.spentAtomic),
      wasted: formatUsdc(result.wastedAtomic),
      unverified: formatUsdc(result.unverifiedAtomic),
      blocked: result.blocked, injections: result.injections,
      merchants: result.merchants.map(item => ({
        merchantId: item.merchantId, attempts: item.settlements.length,
        spent: formatUsdc(item.spentAtomic), wasted: formatUsdc(item.wastedAtomic),
        extraPrice: formatUsdc(item.extraPriceAtomic),
        duplicate: formatUsdc(item.duplicateAtomic),
        undelivered: formatUsdc(item.undeliveredAtomic),
        unverified: formatUsdc(item.unverifiedAtomic),
        blocked: item.blocked, injection: item.injection, delivered: item.delivered,
        ...(item.error ? { error: item.error } : {})
      })),
      errors: result.errors, telemetryErrors: result.telemetryErrors
    }, null, 2));
    return result.errors.length || result.telemetryErrors.length || result.unverifiedAtomic > 0n ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Customer Agent: ' + message);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(code => { process.exitCode = code; });
}
