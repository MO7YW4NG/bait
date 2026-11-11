import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORK, asHex, isSimulatedTx, usdcToAtomic } from "./money.js";
import { BASE_SEPOLIA_USDC, type BuyerResult } from "./contracts.js";

export type Settlement = { txHash: string; amountAtomic: bigint; simulated: boolean };

export type BeforeSignContext = {
  url: string;
  amountAtomic: bigint;
  payTo: string;
  asset: string;
  network: string;
};

/** Return `{ abort: true, reason }` to refuse BEFORE the payment is signed. */
export type BeforeSign = (ctx: BeforeSignContext) => Promise<{ abort: true; reason: string } | void>;

/** Mandatory even for the unguarded Buyer and any custom pre-sign callback.
 * Never allow another chain or a substitute token to reach wallet signing.
 */
export function paymentTermsRejection(
  terms: Pick<BeforeSignContext, "network" | "asset">,
): string | null {
  if (terms.network !== NETWORK) return "unsupported payment network: Base Sepolia only";
  if (typeof terms.asset !== "string" ||
      terms.asset.toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase()) {
    return "unsupported payment asset: Base Sepolia USDC only";
  }
  return null;
}

type Common = { url: string; requestId: string; requiredAtomic?: bigint };

/**
 * Assignable to contracts.ts `BuyerResult`, plus `outcome` for convenience:
 *   paid    — payment settled, `settlement` is set
 *   free    — the endpoint did not ask for payment
 *   failed  — transport/verify/settle error; `error` explains
 *   blocked — refused BEFORE signing (`blockedBy` says who); nothing was signed
 */
export type PayAndFetchResult =
  | (Common & {
      blocked: true;
      outcome: "blocked";
      blockedBy: "guard" | "spend_cap";
      reason: string;
      status?: number;
    })
  | (Common & {
      blocked: false;
      outcome: "paid" | "free" | "failed";
      status: number; // HTTP status of the final response (0 if none)
      body: unknown;
      settlement?: Settlement;
      error?: string;
      network: typeof NETWORK;
    });

// Compile-time check that we honor the frozen contract.
const _contract: (r: PayAndFetchResult) => BuyerResult = (r) => r;
void _contract;

export type Buyer = {
  address: `0x${string}`;
  payAndFetch(url: string, requestId: string): Promise<PayAndFetchResult>;
};

export function createBuyer(opts: {
  privateKey: string;
  maxPriceUsdc: string; // decimal string, e.g. "0.10" (MAX_PRICE_PER_CALL_USDC)
  beforeSign?: BeforeSign;
  timeoutMs?: number;
  maxAttempts?: number; // retries only on facilitator settlement failures (default 3 attempts)
}): Buyer {
  const account = privateKeyToAccount(asHex(opts.privateKey));
  const capAtomic = usdcToAtomic(opts.maxPriceUsdc);
  const timeoutMs = opts.timeoutMs ?? 30_000;

  /**
   * The public testnet facilitator intermittently returns `invalid_exact_evm_transaction_failed`
   * (its on-chain transferWithAuthorization reverted / was not mined). Verified on-chain: no USDC
   * moves in that case, so retrying with a FRESH signature (new EIP-3009 nonce) cannot double-pay.
   */
  async function payAndFetch(url: string, requestId: string): Promise<PayAndFetchResult> {
    const maxAttempts = opts.maxAttempts ?? 3;
    let result = await attempt(url, requestId);
    for (let i = 1; i < maxAttempts && isRetryableSettleFailure(result); i++) {
      await new Promise((r) => setTimeout(r, 1_000 * i));
      result = await attempt(url, requestId);
    }
    return result;
  }

  async function attempt(url: string, requestId: string): Promise<PayAndFetchResult> {
    // Per-call state (a fresh client per call keeps hooks request-scoped).
    const state: { required?: bigint; guardReason?: string; settle?: SettleResponse } = {};

    const client = x402Client
      .fromConfig({
        schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
        spendControls: { maxAmountPerPayment: `$${opts.maxPriceUsdc}` },
      })
      .onBeforePaymentCreation(async (ctx) => {
        const req = ctx.selectedRequirements;
        state.required = BigInt(req.amount);
        const rejection = paymentTermsRejection(req);
        if (rejection) {
          state.guardReason = rejection;
          return { abort: true as const, reason: rejection };
        }
        if (!opts.beforeSign) return;
        const verdict = await opts.beforeSign({
          url: ctx.paymentRequired.resource?.url ?? url,
          amountAtomic: BigInt(req.amount),
          payTo: req.payTo,
          asset: req.asset,
          network: req.network,
        });
        if (verdict?.abort) state.guardReason = verdict.reason;
        return verdict;
      })
      .onPaymentResponse(async (ctx) => {
        if (ctx.settleResponse) state.settle = ctx.settleResponse;
      });

    // Inner fetch: timeout + read the 402 amount even if spend controls reject before hooks run.
    const innerFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      // A post-sign 402 is a settlement failure response, not a new unsigned
      // payment challenge. Preserve PAYMENT-RESPONSE for the retry mechanism.
      // Still validate EVERY 402 alternative before any wallet signature.
      const alreadySigned = new Headers(init?.headers).has("PAYMENT-SIGNATURE");
      if (res.status === 402 && !alreadySigned) {
        // Validate EVERY advertised 402 requirement before x402 can select a
        // scheme or produce a signature. This also protects Guard OFF callers.
        const reject = (reason: string): never => {
          state.guardReason = reason;
          throw new Error(reason);
        };
        const h = res.headers.get("PAYMENT-REQUIRED");
        if (!h) return reject("missing x402 PAYMENT-REQUIRED challenge");
        let challenge: ReturnType<typeof decodePaymentRequiredHeader>;
        try {
          challenge = decodePaymentRequiredHeader(h);
        } catch {
          return reject("invalid x402 PAYMENT-REQUIRED challenge");
        }
        if (!Array.isArray(challenge.accepts) || challenge.accepts.length === 0) {
          reject("x402 challenge has no accepted payment requirements");
        }
        for (const requirement of challenge.accepts) {
          if (requirement.scheme !== "exact") reject("unsupported x402 payment scheme");
          const reason = paymentTermsRejection(requirement);
          if (reason) reject(reason);
          if (typeof requirement.amount !== "string" ||
              !/^(0|[1-9][0-9]*)$/.test(requirement.amount)) {
            reject("invalid USDC atomic amount in payment requirement");
          }
        }
        state.required ??= BigInt(challenge.accepts[0]!.amount);
      }
      return res;
    };

    const fetchWithPayment = wrapFetchWithPayment(innerFetch, client);
    const common = { url, requestId };

    let res: Response;
    try {
      res = await fetchWithPayment(url, { headers: { "X-Request-Id": requestId } });
    } catch (err) {
      const requiredAtomic = state.required;
      if (state.guardReason) {
        return { ...common, blocked: true, outcome: "blocked", blockedBy: "guard", reason: state.guardReason, requiredAtomic };
      }
      if (requiredAtomic !== undefined && requiredAtomic > capAtomic) {
        return { ...common, blocked: true, outcome: "blocked", blockedBy: "spend_cap", reason: `payment requires ${requiredAtomic} atomic, above the per-call cap ${capAtomic}`, requiredAtomic };
      }
      return { ...common, blocked: false, outcome: "failed", status: 0, body: null, error: (err as Error).message, requiredAtomic, network: NETWORK };
    }

    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }

    if (!state.settle) {
      const h = res.headers.get("PAYMENT-RESPONSE");
      if (h) {
        try {
          state.settle = decodePaymentResponseHeader(h);
        } catch {
          /* ignore */
        }
      }
    }

    const base = { ...common, blocked: false as const, status: res.status, body, requiredAtomic: state.required, network: NETWORK };

    if (state.settle?.success && state.settle.transaction) {
      const txHash = state.settle.transaction;
      return {
        ...base,
        outcome: "paid",
        settlement: { txHash, amountAtomic: BigInt(state.settle.amount ?? state.required ?? 0n), simulated: isSimulatedTx(txHash) },
      };
    }
    if (state.required === undefined && res.status < 400) return { ...base, outcome: "free" };
    return {
      ...base,
      outcome: "failed",
      error: state.settle?.errorReason ?? state.settle?.errorMessage ?? `HTTP ${res.status} without settlement`,
    };
  }

  return { address: account.address, payAndFetch };
}

function isRetryableSettleFailure(r: PayAndFetchResult): boolean {
  return !r.blocked && r.outcome === "failed" && !r.settlement && /transaction_failed/.test(r.error ?? "");
}

/** Read the price a paid endpoint will ask for, without paying. */
export async function getRequiredAmount(url: string): Promise<bigint | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (res.status !== 402) return null;
  const h = res.headers.get("PAYMENT-REQUIRED");
  if (!h) return null;
  const amount = decodePaymentRequiredHeader(h).accepts[0]?.amount;
  return amount ? BigInt(amount) : null;
}
