/**
 * Shopping session behind the Pi agent tools (src/pi/baitShop.ts).
 * Reuses B3's customer ports, so every purchase is reported to the feed exactly like
 * `pnpm customer` (events + /spend), and the dashboard updates live.
 *
 * Guard on/off comes ONLY from the BAIT_GUARD env var set by the launcher.
 * It is never a tool parameter, so the LLM cannot switch the guard off.
 */
import { randomUUID } from "node:crypto";
import { createCustomerPorts, readConfiguration } from "../agents/customer.js";
import {
  analyzePurchase,
  formatUsdc,
  makeRunId,
  parseUsdc,
  wantsRetry,
  type CustomerEvent,
  type CustomerPorts,
  type GuardMode,
  type Merchant,
  type MerchantResult,
  type Settlement,
} from "../agents/customerCore.js";

export type BuyOutcome = {
  merchantId: string;
  merchantName: string;
  kind: "blocked" | "paid" | "failed";
  /** Short, model-facing reason when blocked or failed. */
  reason?: string;
  quotedUsdc: string;
  spentUsdc: string;
  wastedUsdc: string;
  payments: number;
  delivered: boolean;
  injection: boolean;
  data?: unknown;
  txHashes: string[];
  simulated: boolean;
};

export type ShopTotals = {
  runId: string;
  guard: GuardMode;
  spentUsdc: string;
  wastedUsdc: string;
  blocked: number;
  injections: number;
  purchases: number;
};

export function guardFromEnv(env: NodeJS.ProcessEnv = process.env): GuardMode {
  const v = env.BAIT_GUARD;
  if (v !== "on" && v !== "off") throw new Error("BAIT_GUARD must be on or off (set by pnpm shop)");
  return v;
}

export function createShop(guard: GuardMode) {
  const runId = makeRunId(guard, `pi-${Date.now()}-${randomUUID().slice(0, 8)}`);
  let ports: CustomerPorts | undefined;
  let merchants: Merchant[] | undefined;
  let started = false;
  let finished = false;
  const results: MerchantResult[] = [];

  const emit = async (type: CustomerEvent["type"], payload: Record<string, unknown> = {}) => {
    try {
      await ports?.postEvent({ actor: "customer", type, payload: { runId, guard, agent: "pi", ...payload } });
    } catch {
      /* telemetry must never break shopping */
    }
  };

  async function init(): Promise<CustomerPorts> {
    if (!ports) ports = await createCustomerPorts(readConfiguration(), guard);
    if (!started) {
      started = true;
      await emit("run_started");
    }
    return ports;
  }

  async function listMerchants(): Promise<Merchant[]> {
    const p = await init();
    merchants ??= await p.listMerchants();
    return merchants;
  }

  async function findMerchant(id: string): Promise<Merchant> {
    const m = (await listMerchants()).find((x) => x.id === id);
    if (!m) throw new Error(`unknown merchant "${id}"`);
    return m;
  }

  async function quote(id: string) {
    const p = await init();
    const m = await findMerchant(id);
    const q = await p.quote(m);
    await emit("quote", { merchantId: m.id, quotedAtomic: parseUsdc(q.priceUsdc).toString() });
    return { merchantId: m.id, merchantName: m.name, product: q.product, priceUsdc: q.priceUsdc, description: q.description };
  }

  /** Same per-merchant flow as runScriptedCustomer: pay, follow one retry request, analyze, report. */
  async function buy(id: string): Promise<BuyOutcome> {
    const p = await init();
    const m = await findMerchant(id);
    const requestId = `${runId}:${m.id}:${results.filter((r) => r.merchantId === m.id).length}`;
    const settlements: Settlement[] = [];
    let status: number | null = null;
    let body: unknown = null;
    let quotedAtomic = 0n;
    let wasBlocked = false;
    let reason: string | undefined;
    let error: string | undefined;

    try {
      const q = await p.quote(m);
      quotedAtomic = parseUsdc(q.priceUsdc);
      for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = await p.pay(guard, m, q, requestId);
        if (outcome.kind === "blocked") {
          reason = outcome.reason.slice(0, 200);
          if (outcome.blockedBy === "guard" && settlements.length === 0) {
            wasBlocked = true;
            await emit("guard_blocked", { merchantId: m.id, reason });
          } else {
            error = `payment refused (${outcome.blockedBy}): ${reason}`;
          }
          break;
        }
        if (outcome.kind === "failed") {
          if (outcome.result?.settlement) settlements.push(outcome.result.settlement);
          status = null;
          body = null;
          error = `payment failed: ${outcome.reason.slice(0, 200)}`;
          break;
        }
        if (guard === "on") await emit("guard_allowed", { merchantId: m.id });
        const r = outcome.result;
        status = r.status;
        body = r.body;
        if (r.settlement) {
          settlements.push(r.settlement);
          await emit("payment_settled", {
            merchantId: m.id,
            txHash: r.settlement.txHash,
            amountAtomic: r.settlement.amountAtomic.toString(),
            simulated: r.settlement.simulated,
          });
        }
        if (!wantsRetry(body) || status < 200 || status >= 300) break;
      }
    } catch (e) {
      error = (e as Error).message;
    }

    const result = analyzePurchase({
      merchantId: m.id, requestId, quotedAtomic, settlements,
      finalBody: body, status, wasBlocked, ...(error ? { error } : {}),
    });
    results.push(result);
    try {
      await p.postSpend({
        run: runId, guard, merchantId: m.id,
        spentAtomic: result.spentAtomic.toString(), wastedAtomic: result.wastedAtomic.toString(),
        blocked: result.blocked, injection: result.injection,
      });
    } catch {
      /* telemetry */
    }
    if (result.wastedAtomic > 0n) await emit("wasted", { merchantId: m.id, amountAtomic: result.wastedAtomic.toString() });
    if (result.injection) await emit("injection_exposed", { merchantId: m.id });

    return {
      merchantId: m.id,
      merchantName: m.name,
      kind: wasBlocked ? "blocked" : error ? "failed" : "paid",
      ...(wasBlocked ? { reason } : error ? { reason: error } : {}),
      quotedUsdc: formatUsdc(quotedAtomic),
      spentUsdc: formatUsdc(result.spentAtomic),
      wastedUsdc: formatUsdc(result.wastedAtomic),
      payments: settlements.length,
      delivered: result.delivered,
      injection: result.injection,
      ...(body !== null && !wasBlocked ? { data: body } : {}),
      txHashes: settlements.map((s) => s.txHash),
      simulated: settlements.some((s) => s.simulated),
    };
  }

  function totals(): ShopTotals {
    const sum = (f: (r: MerchantResult) => bigint) => results.reduce((a, r) => a + f(r), 0n);
    return {
      runId, guard,
      spentUsdc: formatUsdc(sum((r) => r.spentAtomic)),
      wastedUsdc: formatUsdc(sum((r) => r.wastedAtomic)),
      blocked: results.filter((r) => r.blocked).length,
      injections: results.filter((r) => r.injection).length,
      purchases: results.length,
    };
  }

  /** Emits run_finished once (dashboard Guard OFF/ON summary). */
  async function finish(): Promise<ShopTotals> {
    const t = totals();
    if (started && !finished) {
      finished = true;
      const sum = (f: (r: MerchantResult) => bigint) => results.reduce((a, r) => a + f(r), 0n).toString();
      await emit("run_finished", {
        spentAtomic: sum((r) => r.spentAtomic), wastedAtomic: sum((r) => r.wastedAtomic),
        blocked: t.blocked, injections: t.injections,
        unverifiedAtomic: sum((r) => r.unverifiedAtomic), failed: false,
      });
    }
    return t;
  }

  return { runId, guard, listMerchants, quote, buy, totals, finish };
}

export type Shop = ReturnType<typeof createShop>;
