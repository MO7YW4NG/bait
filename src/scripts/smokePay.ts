/** M1 acceptance: pay one merchant and print the tx. Usage: pnpm smoke:pay [merchantId=honest] */
import { loadEnv } from "../lib/env.js";
import { atomicToUsdc, explorerTxUrl } from "../lib/money.js";
import { createBuyer } from "../lib/x402buyer.js";

const env = loadEnv("decoy");
const id = process.argv[2] ?? "honest";
const buyer = createBuyer({ privateKey: env.DECOY_PRIVATE_KEY!, maxPriceUsdc: env.MAX_PRICE_PER_CALL_USDC });
const url = `${env.MERCHANT_URL}/m/${id}/data`;
console.log(`Paying ${url} from ${buyer.address}…`);

const t0 = Date.now();
const r = await buyer.payAndFetch(url, `smoke-${Date.now()}`);
const required = r.requiredAtomic !== undefined ? atomicToUsdc(r.requiredAtomic) : "?";
console.log(`outcome=${r.outcome} required=${required} USDC (${Date.now() - t0} ms)`);
if (r.blocked) {
  console.log("blocked:", r.reason);
  process.exit(1);
}
console.log("body:", JSON.stringify(r.body));
if (!r.settlement) {
  console.log("error:", r.error);
  process.exit(1);
}
console.log(`tx: ${r.settlement.txHash}`);
console.log(explorerTxUrl(r.settlement.txHash) ?? "(simulated settlement — no explorer link)");
