/**
 * B4 integration-contract tests against the ACTUAL merged B1 server and B2 files.
 * All recorded observations below are artificial, in isolated in-memory SQLite.
 * They are API fixtures only: NO wallets, signatures, x402 settlement or E2E success.
 *
 * Run: pnpm exec tsx --test src/demo.contract.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeedApp } from "./feed/server.js";
import { assertAcceptance, formatStatsUsdc, issuesInFeed } from "./demo.js";

const IDS = ["honest", "price-switch", "ghost", "double", "injector"] as const;
const FLAGS: Record<string, string[]> = {
  honest: [],
  "price-switch": ["PRICE_CHANGE"],
  ghost: ["NON_DELIVERY"],
  double: ["DOUBLE_CHARGE"],
  injector: ["PROMPT_INJECTION"],
};

async function json(response: Response): Promise<unknown> {
  assert.equal(response.status, 200, await response.text().catch(() => "HTTP failure"));
  return response.json();
}

test("B1 /health, /stats, /merchants and POST /reset use the declared wire contracts", async () => {
  const { app, db } = createFeedApp({ dbPath: ":memory:" });
  try {
    assert.equal((await app.request("/health")).status, 200);
    assert.deepEqual(await json(await app.request("/merchants")), []);
    const stats = await json(await app.request("/stats")) as {
      off: { spent: string; wasted: string; injections: number };
      on: { spent: string; wasted: string; blocked: number };
    };
    assert.deepEqual(stats, {
      off: { spent: "0", wasted: "0", injections: 0 },
      on: { spent: "0", wasted: "0", blocked: 0 },
    });
    assert.equal(formatStatsUsdc(stats.off.spent, "off.spent"), "0.000000");
    assert.throws(() => formatStatsUsdc("0.06", "off.wasted"), /atomic-unit/);
    const reset = await app.request("/reset", { method: "POST" });
    assert.deepEqual(await json(reset), { ok: true });
    assert.deepEqual(await json(await app.request("/merchants")), []);
  } finally {
    db.close();
  }
});

test("B1 risk evidence, latest-run atomic stats, and B4 acceptance agree on synthetic fixtures only", async () => {
  const { app, db } = createFeedApp({ dbPath: ":memory:" });
  const post = async (endpoint: string, body: unknown) => {
    const response = await app.request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, endpoint + ": " + await response.text());
  };
  try {
    for (const [index, id] of IDS.entries()) {
      await post("/evidence", {
        transaction: {
          merchantId: id,
          requestId: "contract-fixture-" + id,
          quotedAtomic: "10000",
          requiredAtomic: id === "price-switch" ? "50000" : "10000",
          settlements: [{
            txHash: "0xmock" + (index + 1).toString(16) + "abc",
            amountAtomic: id === "price-switch" ? "50000" : "10000",
            simulated: true,
            network: "eip155:84532",
          }],
          finalBody: { city: "Taipei", tempC: 24, condition: "cloudy", humidity: 50, observedAt: "synthetic" },
          status: 200,
          url: "http://localhost:4021/m/" + id + "/data",
        },
        flags: id === "honest"
          ? [{ flag: "PROMPT_INJECTION", by: "judge", detail: "Synthetic advisory-only test" }]
          : FLAGS[id],
      });
    }
    const merchants = await json(await app.request("/merchants"));
    assert.deepEqual(issuesInFeed(merchants), []);
    const list = merchants as Array<{ id: string; flags: string[]; evidence: Array<{ by: string }> }>;
    assert.ok(list.find(item => item.id === "honest")?.evidence.some(item => item.by === "judge"));
    // A judge-only flag is NOT an independently verified rule and must not affect the score.
    const corrupted = structuredClone(list);
    const ghost = corrupted.find(item => item.id === "ghost")!;
    ghost.evidence.push({ by: "rule", flag: "DOUBLE_CHARGE" } as (typeof ghost.evidence)[number]);
    assert.match(issuesInFeed(corrupted).join(" "), /ghost: rule flags/);

    await post("/spend", {
      run: "contract-off", guard: "off", merchantId: "honest",
      spentAtomic: "100000", wastedAtomic: "60000", blocked: false, injection: true,
    });
    await post("/spend", {
      run: "contract-on", guard: "on", merchantId: "honest",
      spentAtomic: "10000", wastedAtomic: "0", blocked: false, injection: false,
    });
    for (const id of IDS.slice(1)) {
      await post("/spend", {
        run: "contract-on", guard: "on", merchantId: id,
        spentAtomic: "0", wastedAtomic: "0", blocked: true, injection: false,
      });
    }
    const stats = await json(await app.request("/stats")) as {
      off: Record<string, unknown>; on: Record<string, unknown>;
    };
    assert.equal(formatStatsUsdc(stats.off.wasted, "off.wasted"), "0.060000");
    assert.equal(formatStatsUsdc(stats.on.spent, "on.spent"), "0.010000");
    assert.doesNotThrow(() => assertAcceptance(stats));
    assert.throws(() => assertAcceptance({
      off: stats.off,
      on: { ...stats.on, blocked: 3 },
    }), /acceptance targets/);
    await post("/reset", {});
    assert.deepEqual(await json(await app.request("/merchants")), []);
    assert.equal(formatStatsUsdc(
      (await json(await app.request("/stats")) as { off: { spent: string } }).off.spent,
      "off.spent",
    ), "0.000000");
  } finally {
    db.close();
  }
});

test("B1 serves the actual B2 dashboard HTML and assets, rather than an API-only fallback", async () => {
  const { app, db } = createFeedApp({ dbPath: ":memory:" });
  try {
    const page = await app.request("/");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="wasted-off"/);
    assert.match(html, /id="merchant-rows"/);
    assert.match(html, /\/app\.js/);
    const script = await app.request("/app.js");
    const style = await app.request("/app.css");
    assert.equal(script.status, 200);
    assert.equal(style.status, 200);
    assert.match(await script.text(), /\/stats/);
    assert.match(await style.text(), /dashboard|merchant|panel/i);
  } finally {
    db.close();
  }
});
