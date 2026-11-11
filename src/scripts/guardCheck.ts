/**
 * Part A acceptance for the guard: after `pnpm decoy`, buying from every merchant through
 * guardedFetch must sign NOTHING for the 4 flagged merchants and still buy from `honest`.
 * Usage: pnpm guard:check   (uses CUSTOMER_PRIVATE_KEY)
 */
import { loadEnv } from "../lib/env.js";
import { atomicToUsdc, usdcToAtomic } from "../lib/money.js";
import { guardedFetch } from "../guard/guardedFetch.js";
import type { Merchant, MerchantQuote } from "../lib/contracts.js";

const env = loadEnv("customer-scripted");
const runId = `guardcheck-${Date.now()}`;
const merchants = (await (await fetch(`${env.MERCHANT_URL}/merchants`)).json()) as Merchant[];
let blocked = 0;
let settled = 0;

for (const m of merchants) {
  const quote = (await (await fetch(m.quoteUrl)).json()) as MerchantQuote;
  const r = await guardedFetch(m.dataUrl, {
    privateKey: env.CUSTOMER_PRIVATE_KEY!,
    requestId: `${runId}:${m.id}`,
    quotedAtomic: quote.priceAtomic ? BigInt(quote.priceAtomic) : usdcToAtomic(quote.priceUsdc),
    feedUrl: env.FEED_URL,
    minScore: env.GUARD_MIN_SCORE,
    maxPriceUsdc: env.MAX_PRICE_PER_CALL_USDC,
    actor: "customer:on",
  });
  const s = r.result.blocked ? undefined : r.result.settlement;
  if (!r.allowed) blocked++;
  if (s) settled++;
  const paid = s ? `paid ${atomicToUsdc(s.amountAtomic)} tx ${s.txHash.slice(0, 14)}…` : "nothing signed";
  console.log(`${r.allowed ? "ALLOW" : "BLOCK"} ${m.id.padEnd(13)} ${paid}${r.reason ? `  — ${r.reason}` : ""}`);
}

const pass = blocked === 4 && settled === 1;
console.log(`\nblocked=${blocked} settled=${settled} -> ${pass ? "PASS" : "FAIL (expected blocked=4 settled=1; run pnpm decoy first)"}`);
process.exit(pass ? 0 : 1);
