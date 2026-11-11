/**
 * Decoy run: a SCRIPTED test buyer with a capped testnet wallet.
 * Buys from every merchant, records what actually happened on-chain, runs the rules, publishes evidence.
 *   pnpm decoy
 */
import { loadEnv } from "../lib/env.js";
import { atomicToUsdc, explorerTxUrl, sumAtomic, usdcToAtomic } from "../lib/money.js";
import { createBuyer, type PayAndFetchResult } from "../lib/x402buyer.js";
import { detect, type Finding } from "../detector/rules.js";
import { emit, postJson } from "../lib/feedPost.js";
import type { EvidencePostRequest, Merchant, MerchantQuote, PaymentSettlement, TransactionEvidence } from "../lib/contracts.js";

const env = loadEnv("decoy");
const FEED = env.FEED_URL;
const actor = "decoy";

/** Optional advisory LLM judge (part B: src/detector/judge.ts). Never removes or scores flags. */
type Judge = (tx: TransactionEvidence, description: string) => Promise<{ delivered: boolean; injection: boolean; reason: string } | null>;
async function loadJudge(): Promise<Judge | null> {
  const path = "../detector/judge.js"; // variable specifier: compiles even before judge.ts exists
  try {
    const mod = (await import(path)) as { judge?: Judge };
    return mod.judge ?? null;
  } catch {
    return null;
  }
}

function toSettlement(r: PayAndFetchResult): PaymentSettlement | null {
  if (r.blocked || !r.settlement) return null;
  return {
    txHash: r.settlement.txHash,
    amountAtomic: r.settlement.amountAtomic.toString(),
    simulated: r.settlement.simulated,
    network: r.network,
  };
}

async function main() {
  const runId = `decoy-${Date.now()}`;
  const buyer = createBuyer({ privateKey: env.DECOY_PRIVATE_KEY!, maxPriceUsdc: env.MAX_PRICE_PER_CALL_USDC });
  const judge = await loadJudge();
  console.log(`Decoy ${buyer.address} | run ${runId} | judge ${judge ? "on" : "off"}\n`);
  await emit(FEED, { actor, type: "run_started", payload: { runId, wallet: buyer.address } });

  const merchants = (await (await fetch(`${env.MERCHANT_URL}/merchants`)).json()) as Merchant[];
  const summary: Array<{ merchant: string; charged: string; flags: string; tx: string }> = [];

  for (const m of merchants) {
    const quote = (await (await fetch(m.quoteUrl)).json()) as MerchantQuote;
    const quotedAtomic = quote.priceAtomic ? BigInt(quote.priceAtomic) : usdcToAtomic(quote.priceUsdc);
    await emit(FEED, { actor, type: "quote", payload: { runId, merchantId: m.id, quotedAtomic: quotedAtomic.toString() } });

    const requestId = `${runId}:${m.id}`;
    const results: PayAndFetchResult[] = [];

    const r1 = await buyer.payAndFetch(m.dataUrl, requestId);
    results.push(r1);
    // Merchant says "retry" → call again with the SAME requestId (reproduces a double charge deterministically).
    if (r1.outcome === "paid" && (r1.body as { retry?: unknown } | null)?.retry === true) {
      results.push(await buyer.payAndFetch(m.dataUrl, requestId));
    }

    const settlements = results.map(toSettlement).filter((s): s is PaymentSettlement => s !== null);
    for (const s of settlements) {
      const link = explorerTxUrl(s.txHash);
      console.log(`  ${m.id}: settled ${atomicToUsdc(s.amountAtomic)} USDC  ${link ?? s.txHash + " (simulated)"}`);
      await emit(FEED, {
        actor,
        type: "payment_settled",
        payload: { runId, merchantId: m.id, txHash: s.txHash, amountAtomic: s.amountAtomic, simulated: s.simulated, explorerUrl: link },
      });
    }
    for (const r of results) {
      if (r.blocked) console.warn(`  ${m.id}: blocked — ${r.reason}`);
      else if (r.outcome === "failed") console.warn(`  ${m.id}: failed — ${r.error}`);
    }

    const last = results[results.length - 1]!;
    const tx: TransactionEvidence = {
      runId,
      merchantId: m.id,
      url: m.dataUrl,
      requestId,
      quotedAtomic: quotedAtomic.toString(),
      requiredAtomic: r1.requiredAtomic?.toString(),
      settlements,
      status: last.blocked ? 0 : last.status,
      finalBody: last.blocked ? null : last.body,
    };

    // Payment never happened (facilitator down, wallet empty…) → no evidence, it would be misleading.
    if (settlements.length === 0) {
      console.warn(`  ${m.id}: no settlement, skipping evidence`);
      summary.push({ merchant: m.id, charged: "0", flags: "(not tested)", tx: "-" });
      continue;
    }

    const flags: Finding[] = detect(tx);
    const chargedAtomic = sumAtomic(settlements.map((s) => s.amountAtomic)).toString();

    if (judge) {
      const verdict = await Promise.race([
        judge(tx, quote.description).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
      ]);
      if (verdict) {
        await emit(FEED, { actor, type: "judge_note", payload: { runId, merchantId: m.id, ...verdict } });
        const has = new Set(flags.map((f) => f.flag));
        const lastTx = settlements[settlements.length - 1]!.txHash;
        const mk = (flag: Finding["flag"]): Finding => ({ flag, by: "judge", detail: `AI judge: ${verdict.reason}`, txHash: lastTx, quotedAtomic: tx.quotedAtomic, chargedAtomic });
        if (!verdict.delivered && !has.has("NON_DELIVERY")) flags.push(mk("NON_DELIVERY"));
        if (verdict.injection && !has.has("PROMPT_INJECTION")) flags.push(mk("PROMPT_INJECTION"));
        for (const f of flags) if (f.by === "rule") f.detail += ` | judge: ${verdict.reason}`;
      }
    }

    const evidence: EvidencePostRequest = { transaction: tx, flags };
    await postJson(FEED, "/evidence", evidence);
    for (const f of flags) {
      await emit(FEED, {
        actor,
        type: "flag_raised",
        payload: { runId, merchantId: m.id, flag: f.flag, by: f.by, detail: f.detail, txHash: f.txHash ?? undefined, explorerUrl: f.txHash ? explorerTxUrl(f.txHash) : null },
      });
    }

    summary.push({
      merchant: m.id,
      charged: atomicToUsdc(chargedAtomic),
      flags: flags.map((f) => (f.by === "judge" ? `${f.flag}(judge)` : f.flag)).join(", ") || "-",
      tx: settlements.map((s) => s.txHash.slice(0, 12) + "…").join(" "),
    });
  }

  console.log();
  console.table(summary);
  await emit(FEED, { actor, type: "run_finished", payload: { runId, merchants: summary.length } });
}

main().catch((err) => {
  console.error("decoy failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
