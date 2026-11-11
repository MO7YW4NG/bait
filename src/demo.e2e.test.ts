/**
 * Real Mock E2E: actual A x402 buyers/signatures, Merchant, Decoy, B1 SQLite,
 * B3 Customer OFF/ON, B2 Dashboard and SSE. Mock facilitator settles locally.
 * No real on-chain transaction or funded wallet is used.
 * Run: pnpm exec tsx --test src/demo.e2e.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";
import { issuesInFeed } from "./demo.js";

type FeedStats = {
  off: { spent: string; wasted: string; injections: number };
  on: { spent: string; wasted: string; blocked: number };
};
type Evidence = { txHash: string | null; explorerUrl: string | null; by: string };
type Merchant = { id: string; verdict: string; evidence: Evidence[] };
const root = resolve(import.meta.dirname, "..");

async function readSse(url: string): Promise<Array<Record<string, unknown>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  const events: Array<Record<string, unknown>> = [];
  try {
    const response = await fetch(url + "/events", {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        text += decoder.decode(result.value, { stream: true });
        const frames = text.split(/\r?\n\r?\n/);
        text = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split(/\r?\n/).find(line => line.startsWith("data:"));
          if (!data) continue;
          const event = JSON.parse(data.slice(5).trim()) as Record<string, unknown>;
          events.push(event);
        }
        if (events.filter(item => item.type === "guard_blocked").length >= 4 &&
            events.some(item => item.type === "run_finished" &&
              (item.payload as { guard?: string } | null)?.guard === "on")) {
          break;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("SSE replay verification exceeded 8 seconds; observed " + events.length + " events");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

test("pnpm demo entrypoint performs actual offline mock x402 E2E and preserves a live isolated dashboard",
  { timeout: 150_000 }, async () => {
    // Use Node's own executable on Windows and Linux. The package script uses
    // the exact same tsx src/demo.ts entrypoint; pnpm demo --once runs separately in CI.
    const child: ChildProcess = spawn(process.execPath,
      ["--import", "tsx", "src/demo.ts"], {
        cwd: root,
        env: {
          ...process.env,
          FEED_URL: "http://127.0.0.1:4030",
          MERCHANT_URL: "http://127.0.0.1:4021",
          GMI_API_KEY: "",
          JUDGE_MODEL: "",
          CUSTOMER_MODEL: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    let output = "";
    let dashboard = "";
    let done = false;
    let exitStatus: number | null = null;
    let exitSignal: string | null = null;
    let error: Error | undefined;
    const append = (data: Buffer) => {
      output += data.toString("utf8");
      if (output.length > 45_000) output = output.slice(-45_000);
      const match = /Dashboard(?: loading at|:)\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) dashboard = match[1]!;
      if (output.includes("DEMO_COMPLETE:")) done = true;
    };
    child.stdout!.on("data", append);
    child.stderr!.on("data", append);
    child.once("error", e => { error = e; });
    child.once("exit", (code, signal) => { exitStatus = code; exitSignal = signal; });

    try {
      const deadline = Date.now() + 120_000;
      while (!done && exitStatus === null && !exitSignal && !error && Date.now() < deadline) {
        await sleep(250);
      }
      assert.equal(error, undefined, String(error));
      assert.equal(exitStatus, null,
        "Demo exited before success (" + exitStatus + "):\n" + output.slice(-14_000));
      assert.equal(exitSignal, null, "Demo terminated: " + String(exitSignal));
      assert.ok(done, "Mock demo did not finish within 120s:\n" + output.slice(-14_000));
      assert.ok(dashboard, "No dashboard URL in measured mock output:\n" + output);
      assert.match(output, /SIMULATED MOCK FACILITATOR/);
      assert.match(output, /0\.060000 USDC/);
      assert.match(output, /0\.000000 USDC/);
      assert.match(output, /blocked 4/);

      const owner = await (await fetch(dashboard + "/__demo/owner")).json() as {
        session: string; isolated: boolean;
      };
      assert.equal(owner.isolated, true);
      assert.match(owner.session, /^[0-9a-f-]{36}$/i);
      const stats = await (await fetch(dashboard + "/stats")).json() as FeedStats;
      assert.deepEqual(stats, {
        off: { spent: "100000", wasted: "60000", injections: 1 },
        on: { spent: "10000", wasted: "0", blocked: 4 },
      });
      const merchants = await (await fetch(dashboard + "/merchants")).json() as Merchant[];
      assert.deepEqual(issuesInFeed(merchants), []);
      for (const merchant of merchants) {
        assert.ok(merchant.evidence.length || merchant.id === "honest");
        for (const evidence of merchant.evidence) {
          assert.equal(evidence.explorerUrl, null, "Mock receipts may NOT link to explorer");
          if (evidence.txHash) assert.match(evidence.txHash, /^0xmock/i);
        }
      }
      const html = await (await fetch(dashboard)).text();
      assert.match(html, /id="wasted-off"/);
      assert.match(html, /id="merchant-rows"/);
      assert.equal((await fetch(dashboard + "/app.js")).status, 200);
      assert.equal((await fetch(dashboard + "/app.css")).status, 200);
      const events = await readSse(dashboard);
      assert.equal(events.filter(e => e.type === "guard_blocked").length, 4);
      const settled = events.filter(e => e.type === "payment_settled");
      assert.ok(settled.length >= 5, "Expected payment-settled events from the actual mock decoy/customer run");
      for (const event of settled) {
        const payload = event.payload as Record<string, unknown>;
        assert.equal(payload.simulated, true);
        assert.equal(payload.explorerUrl ?? null, null);
        assert.match(String(payload.txHash), /^0xmock/i);
      }
    } finally {
      // Never kill unrelated services. Only the spawned B4 parent handles its owned children.
      if (exitStatus === null) child.kill("SIGTERM");
      const until = Date.now() + 8_000;
      while (exitStatus === null && Date.now() < until) await sleep(120);
      if (exitStatus === null) child.kill("SIGKILL");
    }
    assert.match(output, /DEMO_COMPLETE:/);
  });
