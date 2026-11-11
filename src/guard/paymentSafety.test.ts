/**
 * A Payment Core safety regression suite for GitHub issue #13.
 * Uses synthetic 402 challenges and a fixture-only private key.
 * It never reaches a real RPC, facilitator, chain or wallet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_SEPOLIA_USDC } from "../lib/contracts.js";
import { paymentTermsRejection, createBuyer, type BeforeSignContext } from "../lib/x402buyer.js";
import { checkBeforeSign, baitHook } from "./guardedFetch.js";

const NETWORK = "eip155:84532";
const MAINNET = "eip155:8453";
const WRONG_ASSET = "0x0000000000000000000000000000000000000001";
const URL = "http://127.0.0.1:4021/m/honest/data";
const TERMS: BeforeSignContext = {
  url: URL,
  amountAtomic: 10_000n,
  payTo: "0x000000000000000000000000000000000000dEaD",
  asset: BASE_SEPOLIA_USDC,
  network: NETWORK,
};
const OPTIONS = { feedUrl: "http://127.0.0.1:4030", minScore: 0.6, quotedAtomic: 10_000n };
const GOOD_RISK = { merchantId: "honest", score: 6/7, verdict: "ok", flags: [], evidence: [] };
const RISKY = { merchantId: "ghost", score: 1/7, verdict: "risky",
  flags: ["NON_DELIVERY"], evidence: [] };

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); }
  finally { globalThis.fetch = original; }
}

function mockRisk(value: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(value), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
}

test("policy: exact Base Sepolia + case-insensitive canonical USDC asset allowed", () => {
  assert.equal(paymentTermsRejection(TERMS), null);
  assert.equal(paymentTermsRejection({ ...TERMS, asset: BASE_SEPOLIA_USDC.toUpperCase() }), null);
  assert.match(paymentTermsRejection({ ...TERMS, network: MAINNET }) ?? "", /network/i);
  assert.match(paymentTermsRejection({ ...TERMS, asset: WRONG_ASSET }) ?? "", /asset/i);
  assert.match(paymentTermsRejection({ ...TERMS, asset: "" }) ?? "", /asset/i);
});

test("guard: unsupported networks must be blocked BEFORE any Feed lookup", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; throw new Error("Feed should not be contacted"); }) as typeof fetch;
  await withFetch(fetcher, async () => {
    assert.match(await checkBeforeSign({ ...TERMS, network: MAINNET }, OPTIONS) ?? "", /network/i);
    assert.match(await checkBeforeSign({ ...TERMS, network: "eip155:1" }, { ...OPTIONS, failClosed: false }) ?? "", /network/i);
  });
  assert.equal(calls, 0);
});

test("guard: wrong asset must be blocked BEFORE any Feed lookup", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; throw new Error("Feed should not be contacted"); }) as typeof fetch;
  await withFetch(fetcher, async () => {
    assert.match(await checkBeforeSign({ ...TERMS, asset: WRONG_ASSET }, OPTIONS) ?? "", /asset/i);
    assert.match(await checkBeforeSign({ ...TERMS, asset: WRONG_ASSET }, { ...OPTIONS, failClosed: false }) ?? "", /asset/i);
  });
  assert.equal(calls, 0);
});

test("guard: accepted terms still honor deterministic risk and benign score", async () => {
  await withFetch(mockRisk(GOOD_RISK), async () => {
    assert.equal(await checkBeforeSign(TERMS, OPTIONS), null);
    assert.match(await checkBeforeSign({ ...TERMS, amountAtomic: 50_000n }, OPTIONS) ?? "", /PRICE_CHANGE/);
  });
  await withFetch(mockRisk(RISKY), async () => {
    assert.match(await checkBeforeSign(TERMS, OPTIONS) ?? "", /risk score/i);
  });
  await withFetch((async () => { throw new Error("offline"); }) as typeof fetch, async () => {
    assert.match(await checkBeforeSign(TERMS, OPTIONS) ?? "", /risk feed unavailable/i);
  });
});

test("baitHook: unsupported network and asset abort payment before signing", async () => {
  const hook = baitHook(OPTIONS);
  const create = (network: string, asset: string) => ({
    paymentRequired: { resource: { url: URL } },
    selectedRequirements: { amount: "10000", payTo: TERMS.payTo, scheme: "exact", network, asset },
  });
  await withFetch((async () => { throw new Error("must not fetch"); }) as typeof fetch, async () => {
    assert.deepEqual((await hook(create(MAINNET, BASE_SEPOLIA_USDC)))?.abort, true);
    assert.deepEqual((await hook(create(NETWORK, WRONG_ASSET)))?.abort, true);
  });
});

type Challenge = { network: string; asset: string; scheme?: string; amount?: string };
function challengeResponse(entries: Challenge[]): Response {
  const accepts = entries.map(entry => ({
    scheme: entry.scheme ?? "exact",
    network: entry.network,
    asset: entry.asset,
    amount: entry.amount ?? "10000",
    payTo: TERMS.payTo,
    maxTimeoutSeconds: 60,
    extra: {},
  }));
  const data = {
    x402Version: 2, error: "Payment required",
    resource: { url: URL, description: "Synthetic payment challenge", mimeType: "application/json" },
    accepts,
  };
  return new Response(JSON.stringify({ error: "payment required" }), {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(data), "utf8").toString("base64"),
      "content-type": "application/json",
    },
  });
}

async function assertBuyerRejects(entries: Challenge[], expectedReason: RegExp): Promise<void> {
  let fetchCount = 0;
  let signedRequests = 0;
  let hookCalls = 0;
  const fakeNetwork = (async (_resource: unknown, init?: RequestInit) => {
    fetchCount++;
    const header = new Headers(init?.headers);
    if (header.has("PAYMENT-SIGNATURE")) signedRequests++;
    return challengeResponse(entries);
  }) as typeof fetch;
  await withFetch(fakeNetwork, async () => {
    // Synthetic key is only used to construct an account, never to sign.
    const buyer = createBuyer({
      privateKey: "0x" + "11".repeat(32),
      maxPriceUsdc: "0.10",
      beforeSign: async () => { hookCalls++; },
    });
    const result = await buyer.payAndFetch(URL, "b5-a-issue13-fixture");
    assert.equal(result.blocked, true, "invalid challenge must be an explicit block, not a payment");
    if (!result.blocked) return;
    assert.equal(result.blockedBy, "guard");
    assert.match(result.reason, expectedReason);
    assert.equal("settlement" in result, false, "blocked payment must have no settlement");
  });
  assert.equal(fetchCount, 1, "rejected challenge must stop after the unpaid 402");
  assert.equal(hookCalls, 0, "unsafe requirements must not reach consumer beforeSign");
  assert.equal(signedRequests, 0, "unsafe requirements must never create a signature");
}

test("buyer: block a Base mainnet 402 even when guard callback is provided", async () => {
  await assertBuyerRejects([{ network: MAINNET, asset: BASE_SEPOLIA_USDC }], /network/i);
});

test("buyer: block a wrong-token 402 even with otherwise valid network", async () => {
  await assertBuyerRejects([{ network: NETWORK, asset: WRONG_ASSET }], /asset/i);
});

test("buyer: refuse mixed valid+unsafe advertised payment alternatives", async () => {
  await assertBuyerRejects([
    { network: NETWORK, asset: BASE_SEPOLIA_USDC },
    { network: MAINNET, asset: BASE_SEPOLIA_USDC },
  ], /network/i);
});

test("buyer: invalid scheme or malformed amounts never reach a signer", async () => {
  await assertBuyerRejects([{ network: NETWORK, asset: BASE_SEPOLIA_USDC, scheme: "not-exact" }], /scheme/i);
  await assertBuyerRejects([{ network: NETWORK, asset: BASE_SEPOLIA_USDC, amount: "0.010" }], /atomic amount/i);
});

test("buyer: still blocks wrong-token 402 if no optional Guard is configured", async () => {
  let calls = 0;
  await withFetch((async () => {
    calls++;
    return challengeResponse([{ network: NETWORK, asset: WRONG_ASSET }]);
  }) as typeof fetch, async () => {
    const buyer = createBuyer({ privateKey: "0x" + "22".repeat(32), maxPriceUsdc: "0.10" });
    const result = await buyer.payAndFetch(URL, "standalone-buyer-issue13");
    assert.equal(result.blocked, true);
    if (result.blocked) assert.match(result.reason, /asset/i);
  });
  assert.equal(calls, 1);
});
