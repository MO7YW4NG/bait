/**
 * Bait guard — checks the risk feed BEFORE an agent signs an x402 payment.
 *
 * It runs inside x402's `onBeforePaymentCreation` hook: after the seller's 402 arrives,
 * before any signature exists. If it aborts, nothing is signed and nothing settles.
 */
import { atomicToUsdc } from "../lib/money.js";
import { createBuyer, type BeforeSignContext, type PayAndFetchResult } from "../lib/x402buyer.js";
import { isDelivered } from "../lib/weather.js";
import { emit, postJson } from "../lib/feedPost.js";
import type { ReportPostRequest, RiskResponse } from "../lib/contracts.js";

export type GuardOptions = {
  feedUrl: string;
  minScore: number;
  quotedAtomic?: bigint; // what the agent was promised; enables the live price check
  failClosed?: boolean; // block if the feed is unreachable (default true)
  actor?: string;
};

/** The core decision. Returns a reason to block, or null to allow. */
export async function checkBeforeSign(ctx: BeforeSignContext, opts: GuardOptions): Promise<string | null> {
  // 1. Risk feed: has a decoy (or paying crowd) already caught this seller?
  let risk: RiskResponse;
  try {
    const res = await fetch(`${opts.feedUrl}/risk?url=${encodeURIComponent(ctx.url)}`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    risk = (await res.json()) as RiskResponse;
  } catch (err) {
    return opts.failClosed === false ? null : `risk feed unavailable (${(err as Error).message})`;
  }
  if (risk.verdict === "risky" || (risk.verdict === "ok" && risk.score < opts.minScore)) {
    const e = risk.evidence.find((x) => x.by === "rule") ?? risk.evidence[0];
    const proof = e
      ? `${e.flag}: quoted ${atomicToUsdc(e.quoted)}, charged ${atomicToUsdc(e.charged)}${e.txHash ? `, tx ${e.txHash.slice(0, 10)}…` : ""}`
      : risk.flags.join(", ");
    return `risk score ${risk.score.toFixed(2)} (${proof})`;
  }

  // 2. Live price check: the 402 asks for more than we were quoted (works for never-seen sellers too).
  if (opts.quotedAtomic !== undefined && ctx.amountAtomic > opts.quotedAtomic) {
    return `PRICE_CHANGE: quoted ${atomicToUsdc(opts.quotedAtomic)}, payment requires ${atomicToUsdc(ctx.amountAtomic)}`;
  }
  // 3. The per-call price cap is enforced by x402 spendControls before this hook runs.
  return null;
}

/** Drop-in hook for ANY x402Client: `client.onBeforePaymentCreation(baitHook({ feedUrl, minScore }))`. */
export function baitHook(opts: GuardOptions) {
  return async (ctx: {
    paymentRequired: { resource?: { url: string } };
    selectedRequirements: { amount: string; payTo: string; asset: string; network: string };
  }) => {
    const r = ctx.selectedRequirements;
    const url = ctx.paymentRequired.resource?.url ?? "";
    const reason = await checkBeforeSign({ url, amountAtomic: BigInt(r.amount), payTo: r.payTo, asset: r.asset, network: r.network }, opts);
    return reason ? { abort: true as const, reason } : undefined;
  };
}

/** Pay for `url` only if the guard allows it; report the outcome back to the feed (crowd loop). */
export async function guardedFetch(
  url: string,
  opts: GuardOptions & { privateKey: string; requestId: string; maxPriceUsdc: string },
): Promise<{ allowed: boolean; reason?: string; result: PayAndFetchResult }> {
  const actor = opts.actor ?? "guard";
  const buyer = createBuyer({
    privateKey: opts.privateKey,
    maxPriceUsdc: opts.maxPriceUsdc,
    beforeSign: async (ctx) => {
      const reason = await checkBeforeSign(ctx, opts);
      return reason ? { abort: true, reason } : undefined;
    },
  });

  const result = await buyer.payAndFetch(url, opts.requestId);

  if (result.blocked) {
    await emit(opts.feedUrl, { actor, type: "guard_blocked", payload: { url, requestId: opts.requestId, reason: result.reason, by: result.blockedBy } });
    return { allowed: false, reason: result.reason, result };
  }

  await emit(opts.feedUrl, { actor, type: "guard_allowed", payload: { url, requestId: opts.requestId, outcome: result.outcome } });

  if (result.settlement) {
    const overcharged = opts.quotedAtomic !== undefined && result.settlement.amountAtomic > opts.quotedAtomic;
    const report: ReportPostRequest = {
      url,
      outcome: isDelivered(result.body) && !overcharged ? "good" : "bad",
      txHash: result.settlement.txHash,
    };
    await postJson(opts.feedUrl, "/report", report);
  }
  return { allowed: true, result };
}
