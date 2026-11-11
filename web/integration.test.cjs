const assert = require("node:assert/strict");
const { once } = require("node:events");
const { resolve } = require("node:path");
const { test } = require("node:test");

const USDC_NETWORK = "eip155:84532";
const merchantUrl = (id) => "http://127.0.0.1:4021/m/" + id + "/data";

test("B1+B2: isolated real HTTP, SQLite, live SSE and Chromium dashboard", { timeout: 120000 }, async () => {
  // TypeScript import is registered by `pnpm exec tsx --test`; no production DB touched.
  const { createFeedApp } = await import("../src/feed/server.ts");
  const { serve } = await import("@hono/node-server");
  const { chromium } = require(process.env.BAIT_PLAYWRIGHT_MODULE || "playwright");
  const { app, db } = createFeedApp({ dbPath: ":memory:", webRoot: resolve("web") });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  let browser;
  try {
    await once(server, "listening");
    const addr = server.address();
    assert(addr && typeof addr !== "string");
    const base = "http://127.0.0.1:" + addr.port;
    async function get(path) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, "GET " + path + " failed");
      return response;
    }
    async function post(path, data) {
      const response = await fetch(base + path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      assert.equal(response.status, 200, "POST " + path + ": " + await response.text());
      return response;
    }
    function sample(id, flags, requestId) {
      return {
        transaction: {
          merchantId: id, requestId, runId: "e2e-isolated", url: merchantUrl(id),
          quotedAtomic: "10000", requiredAtomic: "10000",
          settlements: [{ txHash: "0xmockabc" + id.length.toString(16),
            amountAtomic: "10000", simulated: true, network: USDC_NETWORK }],
          finalBody: { test: true }, status: 200,
        },
        flags,
      };
    }
    assert.equal(await (await get("/health")).text(), "ok");
    assert.deepEqual(await (await get("/merchants")).json(), []);
    const emptyStats = await (await get("/stats")).json();
    assert.equal(emptyStats.off.wasted, "0");
    assert.equal(emptyStats.on.blocked, 0);
    const html = await (await get("/")).text();
    assert.match(html, /id="merchant-rows"/);
    assert.match(html, /<script src="\/app.js"/);
    assert.match(await (await get("/app.css")).text(), /--bg/);
    assert.match(await (await get("/app.js")).text(), /EventSource/);

    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const navigation = await page.goto(base + "/", { waitUntil: "domcontentloaded" });
    assert.equal(navigation.status(), 200);
    await page.waitForFunction(() => document.getElementById("stream-label").textContent === "STREAM LIVE");
    assert.equal(await page.locator("#fixture-banner").isVisible(), false);
    await page.evaluate(() => { window.__noReloadEvidence = "persisted"; });

    db.upsertMerchant("unknown", merchantUrl("unknown"), "Unobserved Merchant");
    await post("/evidence", sample("honest", [], "e2e-honest"));
    await post("/evidence", sample("ghost", [
      { flag: "NON_DELIVERY", by: "rule", detail: "Paid but no data delivered" }
    ], "e2e-ghost"));
    await post("/evidence", sample("judge-only", [
      { flag: "PROMPT_INJECTION", by: "judge", detail: "AI advisory only" }
    ], "e2e-judge"));
    const honest = await (await get("/risk?url=" + encodeURIComponent(merchantUrl("honest")))).json();
    const ghost = await (await get("/risk?url=" + encodeURIComponent(merchantUrl("ghost")))).json();
    const unknown = await (await get("/risk?url=" + encodeURIComponent(merchantUrl("unknown")))).json();
    assert.equal(honest.score, 6 / 7);
    assert.equal(ghost.score, 1 / 7);
    assert.equal(unknown.verdict, "unknown");
    assert.deepEqual(ghost.flags, ["NON_DELIVERY"]);

    await post("/spend", { run: "off-e2e", guard: "off", merchantId: "ghost",
      spentAtomic: "60000", wastedAtomic: "60000", blocked: false, injection: false });
    for (let n = 0; n < 4; n++) {
      await post("/spend", { run: "on-e2e", guard: "on", merchantId: "ghost",
        spentAtomic: "0", wastedAtomic: "0", blocked: true, injection: false });
    }
    await post("/events", { actor: "guard", type: "guard_blocked",
      payload: { merchantId: "ghost", reason: "Risk score below threshold", runId: "on-e2e" } });

    await page.waitForFunction(() =>
      document.getElementById("wasted-off").textContent === "0.060" &&
      document.getElementById("wasted-on").textContent === "0.000" &&
      document.getElementById("blocked-count").textContent === "4" &&
      document.getElementById("merchant-count").textContent === "4",
      null, { timeout: 10000 });
    await page.waitForFunction(() =>
      document.getElementById("event-list").textContent.includes("BLOCKED before signing"));
    assert.equal(await page.evaluate(() => window.__noReloadEvidence), "persisted");
    assert.equal(await page.locator("#saved-value").textContent(), "0.060");
    const monitorText = await page.locator("#merchant-rows").innerText();
    assert.match(monitorText, /86%/);
    assert.match(monitorText, /14%/);
    assert.match(monitorText, /UNKNOWN/);
    assert.match(monitorText, /NON_DELIVERY/);
    assert.match(monitorText, /PROMPT_INJECTION · AI judge/);
    assert.match(monitorText, /SIMULATED · NO CHAIN TX/);
    assert.equal(await page.locator("#merchant-rows a.tx-link").count(), 0);
    assert.deepEqual(pageErrors, [], "Client-side JS exceptions");

    await post("/reset", {});
    assert.deepEqual(await (await get("/merchants")).json(), []);
    const resetStats = await (await get("/stats")).json();
    assert.equal(resetStats.off.wasted, "0");
    assert.equal(resetStats.on.blocked, 0);
    await page.waitForFunction(() =>
      document.getElementById("merchant-count").textContent === "0" &&
      document.getElementById("wasted-off").textContent === "0.000" &&
      document.getElementById("event-list").textContent.includes("Feed reset") &&
      !document.getElementById("event-list").textContent.includes("BLOCKED before signing"),
      null, { timeout: 10000 });
    assert.equal(await page.locator("#event-list li").count(), 1);
    assert.deepEqual(pageErrors, [], "Client-side errors after reset");
    await page.close();
  } finally {
    if (browser) await browser.close();
    await new Promise((resolveClose, reject) => server.close((error) =>
      error ? reject(error) : resolveClose()));
    db.close();
  }
});
