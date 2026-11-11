/**
 * Guard check for sellers with NO history (run right after POST /reset).
 *  - honest 0.01 with quote      → allowed (under the 0.02 unknown limit)
 *  - price-switch with quote     → blocked by the live price check
 *  - price-switch WITHOUT quote  → blocked by the unknown-seller limit (0.05 > 0.02)
 * Usage: pnpm unknown:check
 */
import { loadEnv } from "../lib/env.js";
import { guardedFetch } from "../guard/guardedFetch.js";

const env = loadEnv("customer-scripted");
const base = { privateKey: env.CUSTOMER_PRIVATE_KEY!, feedUrl: env.FEED_URL, minScore: env.GUARD_MIN_SCORE, maxPriceUsdc: env.MAX_PRICE_PER_CALL_USDC };
const run = `unknowncheck-${Date.now()}`;

const cases = [
  { name: "honest, quoted 0.01", id: "honest", quotedAtomic: 10_000n as bigint | undefined, expectAllowed: true, expectReason: "" },
  { name: "price-switch, quoted 0.01", id: "price-switch", quotedAtomic: 10_000n as bigint | undefined, expectAllowed: false, expectReason: "PRICE_CHANGE" },
  { name: "price-switch, no quote", id: "price-switch", quotedAtomic: undefined as bigint | undefined, expectAllowed: false, expectReason: "unknown seller" },
];

let failed = 0;
for (const c of cases) {
  const r = await guardedFetch(`${env.MERCHANT_URL}/m/${c.id}/data`, { ...base, requestId: `${run}:${c.name}`, quotedAtomic: c.quotedAtomic });
  const ok = r.allowed === c.expectAllowed && (c.expectReason === "" || (r.reason ?? "").includes(c.expectReason));
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.name.padEnd(26)} allowed=${r.allowed}${r.reason ? `  — ${r.reason}` : ""}`);
}
process.exit(failed ? 1 : 0);
