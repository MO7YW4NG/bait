/**
 * B3 Customer Agent CLI. No x402 implementation lives here.
 *
 * Real payments: A's src/lib/x402buyer.ts and src/guard/guardedFetch.ts
 * are loaded at runtime. Missing A modules FAIL CLOSED (no mock fallback).
 * Scripted agent: pnpm customer --guard off|on --scripted
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  formatUsdc, makeRunId, parseUsdc, runScriptedCustomer,
  type CustomerPorts, type GuardMode, type Merchant, type PaymentOutcome,
  type PaymentResult, type Quote, type RiskVerdict, type SpendRecord,
  type CustomerEvent
} from './customerCore.js';

type Buyer = { payAndFetch(url: string, requestId: string): Promise<unknown> };
type BuyerFactory = (options: {
  privateKey: `0x${string}`; maxPriceUsdc: number;
  beforeSign?: (ctx: { url: string; amountAtomic: bigint; payTo: string }) =>
    Promise<{ abort: true; reason: string } | void>;
}) => Buyer;
type GuardFunction = (url: string, opts: {
  privateKey: `0x${string}`; requestId: string; quotedUsdc: number;
  feedUrl: string; minScore: number; maxPriceUsdc: number;
}) => Promise<unknown>;
type Configuration = {
  merchantUrl: URL; feedUrl: URL; rpcUrl: URL;
  privateKey: `0x${string}`; maxPriceUsdc: number; minScore: number;
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
    maxPriceUsdc: Number(maxAtomic) / 1_000_000, minScore
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
function parsePaymentResult(raw: unknown): PaymentResult {
  const data = asRecord(raw);
  if (typeof data.status !== 'number' || !Number.isInteger(data.status) ||
    data.status < 100 || data.status > 599) {
    throw new Error('Buyer returned invalid HTTP status');
  }
  if (data.network !== undefined && data.network !== EXPECTED_NETWORK) {
    throw new Error('Buyer returned non-Base-Sepolia network');
  }
  const settlement = data.settlement === undefined ? undefined : (() => {
    const s = asRecord(data.settlement);
    if (typeof s.txHash !== 'string' || !/^0x(?:mock)?[0-9a-f]+$/i.test(s.txHash) ||
      (typeof s.amountAtomic !== 'string' && typeof s.amountAtomic !== 'bigint')) {
      throw new Error('Buyer returned invalid settlement');
    }
    const amountAtomic = BigInt(s.amountAtomic);
    if (amountAtomic < 0n) {
      throw new Error('Buyer returned a negative settlement');
    }
    // Keep every observed charge in the ledger even if A's pre-sign cap
    // unexpectedly failed. Rejecting the receipt here would hide paid money.
    return { txHash: s.txHash, amountAtomic, simulated: s.simulated === true || s.txHash.startsWith('0xmock') };
  })();
  return {
    status: data.status, body: data.body,
    ...(data.network ? { network: EXPECTED_NETWORK } : {}),
    ...(settlement ? { settlement } : {})
  };
}

function normalizeBuyer(raw: unknown): PaymentOutcome {
  const r = asRecord(raw);
  if (r.blocked === true) {
    if (r.settlement) throw new Error('Blocked buyer operation includes settlement');
    return { kind: 'blocked', reason: typeof r.reason === 'string' ? r.reason : 'buyer spend control rejected payment' };
  }
  return { kind: 'allowed', result: parsePaymentResult(r) };
}
function normalizeGuard(raw: unknown): PaymentOutcome {
  const r = asRecord(raw);
  if (r.allowed === false) {
    if (r.result && asRecord(r.result).settlement) {
      throw new Error('Guard reported blocked AFTER settlement; manual reconciliation required');
    }
    return { kind: 'blocked', reason: typeof r.reason === 'string' ? r.reason : 'guard denied payment' };
  }
  if (r.allowed !== true || !r.result) throw new Error('Guard returned unexpected result (fail closed)');
  return { kind: 'allowed', result: parsePaymentResult(r.result) };
}
async function realPaymentPorts(config: Configuration): Promise<
  Pick<CustomerPorts, 'pay'>
> {
  // Dynamic paths are intentional: B3 compiles independently before A modules merge.
  // There is NO synthetic fallback: runtime refuses to pay if the integration is missing.
  const buyerPath: string = '../lib/x402buyer.ts';
  const guardPath: string = '../guard/guardedFetch.ts';
  let factory: BuyerFactory;
  let guardedFetch: GuardFunction;
  try {
    const buyerModule = await import(buyerPath) as { createBuyer?: BuyerFactory };
    const guardModule = await import(guardPath) as { guardedFetch?: GuardFunction };
    if (typeof buyerModule.createBuyer !== 'function' || typeof guardModule.guardedFetch !== 'function') {
      throw new Error('Missing createBuyer/guardedFetch exports');
    }
    factory = buyerModule.createBuyer;
    guardedFetch = guardModule.guardedFetch;
  } catch {
    throw new Error('A payment integration is not merged: src/lib/x402buyer.ts and src/guard/guardedFetch.ts are required. No payment was attempted.');
  }
  const buyer = factory({ privateKey: config.privateKey, maxPriceUsdc: config.maxPriceUsdc });
  return {
    pay: async (mode, merchant, quote, requestId) => {
      if (mode === 'off') {
        return normalizeBuyer(await buyer.payAndFetch(merchant.dataUrl, requestId));
      }
      return normalizeGuard(await guardedFetch(merchant.dataUrl, {
        privateKey: config.privateKey, requestId, quotedUsdc: Number(quote.priceUsdc),
        feedUrl: config.feedUrl.toString().replace(/\/$/, ''),
        minScore: config.minScore, maxPriceUsdc: config.maxPriceUsdc
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
export async function createCustomerPorts(config: Configuration): Promise<CustomerPorts> {
  await verifyRpcChain(config); // Must pass BEFORE calling the real wallet.
  const payment = await realPaymentPorts(config);
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
        (typeof raw.priceUsdc !== 'number' && typeof raw.priceUsdc !== 'string') ||
        typeof raw.product !== 'string') throw new Error('Invalid quote');
      parseUsdc(raw.priceUsdc);
      return {
        merchantId: merchant.id, product: raw.product, priceUsdc: raw.priceUsdc,
        ...(typeof raw.description === 'string' ? { description: raw.description } : {})
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
    const ports = await createCustomerPorts(config);
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
