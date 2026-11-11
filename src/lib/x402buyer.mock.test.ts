/**
 * Isolated A Buyer positive-path regression: a local mock facilitator only.
 * The fixture wallet is generated from a dummy key. It signs only a synthetic
 * x402 request to a loopback service; no RPC, ETH or USDC moves.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { createBuyer } from "./x402buyer.js";

async function unusedLoopbackPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => probe.close(e => e ? reject(e) : resolve()));
  return address.port;
}

test("Buyer accepts canonical Base Sepolia USDC only on isolated MOCK facilitator", { timeout: 50_000 }, async () => {
  const port = await unusedLoopbackPort();
  const base = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, ["--import", "tsx", "src/merchants/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env, MERCHANT_URL: base, MOCK_FACILITATOR: "1",
      MERCHANT_PAYTO: "0x000000000000000000000000000000000000dEaD",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let logs = "";
  child.stdout?.on("data", part => { logs = (logs + part.toString()).slice(-6_000); });
  child.stderr?.on("data", part => { logs = (logs + part.toString()).slice(-6_000); });
  try {
    let ready = false;
    for (let i = 0; i < 55; i++) {
      if (child.exitCode !== null) throw new Error("Mock merchant exited early: " + logs);
      try {
        const health = await fetch(base + "/health", { signal: AbortSignal.timeout(1_000) });
        if (health.ok) { ready = true; break; }
      } catch { /* local service still starting */ }
      await sleep(200);
    }
    assert.ok(ready, "Mock merchant startup failed: " + logs);
    const dataUrl = base + "/m/honest/data";
    const unpaid = await fetch(dataUrl);
    assert.equal(unpaid.status, 402, "merchant must challenge unpaid requests");
    const buyer = createBuyer({
      privateKey: "0x" + "33".repeat(32), // fixture only; not an imported user key
      maxPriceUsdc: "0.10",
      timeoutMs: 10_000,
    });
    const response = await buyer.payAndFetch(dataUrl, "a-issue13-mock-happy");
    assert.equal(response.blocked, false, "canonical Base Sepolia challenge must not be blocked");
    if (response.blocked) return;
    assert.equal(response.outcome, "paid", "Expected simulated settlement; got " + (response.error ?? response.outcome));
    assert.equal(response.status, 200);
    assert.ok(response.settlement);
    assert.equal(response.settlement?.simulated, true);
    assert.match(response.settlement?.txHash ?? "", /^0xmock[0-9a-f]+$/i);
    assert.equal(response.settlement?.amountAtomic, 10_000n);
    assert.equal(response.network, "eip155:84532");
  } finally {
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) {
      await Promise.race([once(child, "exit").catch(() => {}), sleep(3_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
});


test("settlement retry regression: signed 402 failures trigger fresh signatures", { timeout: 60_000 }, async () => {
  const port = await unusedLoopbackPort();
  const base = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, ["--import", "tsx", "src/merchants/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MERCHANT_URL: base,
      MOCK_FACILITATOR: "1",
      MOCK_SETTLE_FAIL_RATE: "1", // deterministic: all settlement attempts fail, no funds move
      MERCHANT_PAYTO: "0x000000000000000000000000000000000000dEaD",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let logs = "";
  child.stdout?.on("data", part => { logs = (logs + part.toString()).slice(-6_000); });
  child.stderr?.on("data", part => { logs = (logs + part.toString()).slice(-6_000); });
  const originalFetch = globalThis.fetch;
  const signatures = new Set<string>();
  let signedRequests = 0;
  try {
    let ready = false;
    for (let i = 0; i < 55; i++) {
      if (child.exitCode !== null) throw new Error("Mock merchant exited early: " + logs);
      try {
        const health = await originalFetch(base + "/health", { signal: AbortSignal.timeout(1_000) });
        if (health.ok) { ready = true; break; }
      } catch { /* local service still starting */ }
      await sleep(200);
    }
    assert.ok(ready, "Mock merchant startup failed: " + logs);
    globalThis.fetch = (async (input, init) => {
      const signature = new Headers(init?.headers).get("PAYMENT-SIGNATURE")
        ?? (input instanceof Request ? input.headers.get("PAYMENT-SIGNATURE") : null);
      if (signature) {
        signedRequests++;
        signatures.add(signature);
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const buyer = createBuyer({
      privateKey: "0x" + "44".repeat(32),
      maxPriceUsdc: "0.10",
      timeoutMs: 10_000,
      maxAttempts: 3,
    });
    const result = await buyer.payAndFetch(base + "/m/honest/data", "a-issue13-retry-fixture");
    assert.equal(result.blocked, false, "signed settlement failure must not be mislabeled a Guard block");
    if (!result.blocked) {
      assert.equal(result.outcome, "failed", "100% injected failure must exhaust retries");
      assert.match(result.error ?? "", /transaction_failed/);
      assert.equal(result.settlement, undefined, "no mock settlement was successful");
    }
    assert.equal(signedRequests, 3, "two retries must follow the first failed signed settlement");
    assert.equal(signatures.size, 3, "each retry must use a fresh EIP-3009 authorization");
  } finally {
    globalThis.fetch = originalFetch;
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) {
      await Promise.race([once(child, "exit").catch(() => {}), sleep(3_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
});
