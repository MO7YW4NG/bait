/**
 * Bait demo orchestrator.
 * Run through the scaffold-owned package script: pnpm demo
 * Node 24, ESM, cross-platform (no shell). Only this process's children are killed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;
type Service = { name: string; url: URL; path: string; port: string };
type Mode = "off" | "on";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REQUIRED_FILES = [
  "package.json",
  "src/lib/contracts.ts",
  "src/merchants/server.ts",
  "src/feed/server.ts",
  "src/agents/decoy.ts",
  "src/agents/customer.ts",
  "web/index.html",
  "web/app.css",
  "web/app.js",
] as const;
const EXPECTED_FLAGS: Record<string, string[]> = {
  honest: [],
  "price-switch": ["PRICE_CHANGE"],
  ghost: ["NON_DELIVERY"],
  double: ["DOUBLE_CHARGE"],
  injector: ["PROMPT_INJECTION"],
};
const EXPECTED_IDS = Object.keys(EXPECTED_FLAGS);
const START_TIMEOUT_MS = 20_000;
const FEED_TIMEOUT_MS = 40_000;
const REQUEST_TIMEOUT_MS = 2_500;
const AGENT_TIMEOUT_MS = 120_000;
const owned = new Set<ChildProcess>();
let activeAgent: ChildProcess | undefined;
let stopping = false;
let stopWaiter: (() => void) | undefined;

function log(message: string): void {
  process.stdout.write("[bait:demo] " + message + "\n");
}
function fail(message: string): never {
  throw new Error(message);
}
function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}
function stringField(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "n/a";
}
function flagsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((flag): flag is string => typeof flag === "string") : [];
}
function parseArgs(): { check: boolean; pause: number; help: boolean } {
  const args = process.argv.slice(2);
  let check = false;
  let help = false;
  let pause = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") check = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--pause" || arg.startsWith("--pause=")) {
      const raw = arg === "--pause" ? args[++index] : arg.slice("--pause=".length);
      const seconds = Number(raw);
      if (!raw || !Number.isInteger(seconds) || seconds < 0 || seconds > 30) {
        fail("--pause must be an integer between 0 and 30 seconds.");
      }
      pause = seconds;
    } else fail("Unknown argument: " + arg + ". Supported: --check, --pause <0..30>, --help.");
  }
  return { check, pause, help };
}
function loadEnv(): void {
  const path = join(ROOT, ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}
function serviceUrl(_name: string, envName: string, fallback: string, port: string): URL {
  let url: URL;
  try {
    url = new URL(process.env[envName] || fallback);
  } catch {
    return fail(envName + " must be an HTTP URL.");
  }
  if (url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.port !== port || url.pathname !== "/" || url.search || url.hash ||
      url.username || url.password) {
    fail(envName + " must point to an uncredentialed local HTTP service on port " + port +
      " (no path/query). Refusing to reset or probe a remote host.");
  }
  return url;
}
function validateConfig(): { merchant: Service; feed: Service } {
  const missing = REQUIRED_FILES.filter(path => !existsSync(join(ROOT, path)));
  if (missing.length) {
    fail("Missing integration files:\n  - " + missing.join("\n  - ") +
      "\nB0 / A / B1 / B3 may not yet be merged. No payments or reset were attempted.");
  }
  if (Number(process.versions.node.split(".")[0]) < 24) {
    fail("Node.js 24 or later is required (current " + process.version + ").");
  }
  let scripts: JsonObject | undefined;
  try {
    const pkg = asObject(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")));
    scripts = asObject(pkg?.scripts);
  } catch {
    fail("Unable to read package.json. B0 must provide the shared scaffold.");
  }
  if (scripts?.demo !== "tsx src/demo.ts") {
    fail("package.json needs B0's script: \"demo\": \"tsx src/demo.ts\". " +
      "B4 does not modify shared package.json.");
  }
  // tsx is resolved by Node's --import mechanism in the spawned processes.
  try {
    import.meta.resolve("tsx");
  } catch {
    fail("tsx is not installed. Run pnpm install after B0 has merged.");
  }
  const keys = ["DECOY_PRIVATE_KEY", "CUSTOMER_PRIVATE_KEY"] as const;
  for (const key of keys) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(process.env[key] || "")) {
      fail(key + " is missing or not a 32-byte hex private key. Set it in .env (Base Sepolia only).");
    }
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(process.env.MERCHANT_PAYTO || "")) {
    fail("MERCHANT_PAYTO must be a valid 0x-prefixed 20-byte address.");
  }
  if (process.env.MOCK_FACILITATOR && !["0", "1"].includes(process.env.MOCK_FACILITATOR)) {
    fail("MOCK_FACILITATOR must be 0 or 1.");
  }
  return {
    merchant: {
      name: "Merchant",
      url: serviceUrl("Merchant", "MERCHANT_URL", "http://localhost:4021", "4021"),
      path: "src/merchants/server.ts",
      port: "4021",
    },
    feed: {
      name: "Risk Feed",
      url: serviceUrl("Risk Feed", "FEED_URL", "http://localhost:4030", "4030"),
      path: "src/feed/server.ts",
      port: "4030",
    },
  };
}
async function verifyRpcChain(): Promise<void> {
  // Mock mode is deliberately offline-capable. Actual settlements must use Base Sepolia.
  if (process.env.MOCK_FACILITATOR === "1") return;
  let rpc: URL;
  try {
    rpc = new URL(process.env.RPC_URL || "https://sepolia.base.org");
  } catch {
    fail("RPC_URL is not a valid URL.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname);
  if (rpc.protocol !== "https:" && !(local && rpc.protocol === "http:")) {
    fail("RPC_URL must use HTTPS, except for a local RPC server.");
  }
  if (rpc.username || rpc.password) fail("RPC_URL must not contain inline credentials.");
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(7_000),
    });
    if (!response.ok) fail("RPC_URL returned HTTP " + response.status + " for eth_chainId.");
    const payload = asObject(await response.json());
    if (payload?.result !== "0x14a34") {
      fail("RPC_URL does not report Base Sepolia (required chainId 84532). Refusing payments.");
    }
    log("RPC network verified: Base Sepolia (chainId 84532).");
  } catch (error) {
    fail("Unable to verify Base Sepolia RPC network: " +
      (error instanceof Error ? error.message : String(error)));
  }
}

async function request(url: URL, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}
async function isHealthy(service: Service): Promise<boolean> {
  try {
    const response = await request(new URL("/health", service.url));
    return response.ok;
  } catch {
    return false;
  }
}
async function getJson(url: URL): Promise<unknown> {
  let response: Response;
  try {
    response = await request(url, { headers: { accept: "application/json" } });
  } catch (error) {
    fail("Request to " + url.origin + url.pathname + " failed: " + String(error));
  }
  if (!response.ok) fail("GET " + url.pathname + " returned HTTP " + response.status + ".");
  try {
    return await response.json();
  } catch {
    fail("GET " + url.pathname + " did not return valid JSON.");
  }
}
async function verifyIdentity(service: Service): Promise<void> {
  if (service.name === "Merchant") {
    const items = await getJson(new URL("/merchants", service.url));
    if (!Array.isArray(items) || !EXPECTED_IDS.every(id =>
      items.some(item => asObject(item)?.id === id))) {
      fail("Port " + service.port + " is responding, but it is not the expected five-merchant Bait service.");
    }
  } else {
    const stats = asObject(await getJson(new URL("/stats", service.url)));
    const merchants = await getJson(new URL("/merchants", service.url));
    if (!stats || !asObject(stats.off) || !asObject(stats.on) || !Array.isArray(merchants)) {
      fail("Port " + service.port + " is responding, but it is not a compatible Bait Risk Feed.");
    }
    const current = asObject(stats.off);
    const guarded = asObject(stats.on);
    if (!current || !guarded ||
        !/^(0|[1-9][0-9]*)$/.test(String(current.spent)) ||
        !/^(0|[1-9][0-9]*)$/.test(String(current.wasted)) ||
        !/^(0|[1-9][0-9]*)$/.test(String(guarded.spent)) ||
        !/^(0|[1-9][0-9]*)$/.test(String(guarded.wasted))) {
      fail("Risk Feed /stats does not provide B1/B0 atomic-unit string counters.");
    }
    // B2 ships inside the feed server. Verify the page and its JS/CSS are served,
    // not just the B1 health endpoint (which also works without the dashboard).
    const index = await request(new URL("/", service.url));
    if (!index.ok || !index.headers.get("content-type")?.includes("text/html")) {
      fail("Risk Feed is healthy but the B2 Dashboard HTML is unavailable.");
    }
    const html = await index.text();
    if (!html.includes('id="wasted-off"') ||
        !html.includes('id="merchant-rows"') ||
        !html.includes('/app.js')) {
      fail("Risk Feed is serving an outdated or incompatible B2 Dashboard.");
    }
    for (const path of ["/app.js", "/app.css"]) {
      const asset = await request(new URL(path, service.url));
      if (!asset.ok) fail("B2 Dashboard asset unavailable: " + path);
      await asset.body?.cancel();
    }
  }
}
function spawnNode(path: string, args: string[] = []): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, path), ...args], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  child.on("error", error => log("Child process error (" + path + "): " + error.message));
  return child;
}
async function startService(service: Service): Promise<void> {
  if (await isHealthy(service)) {
    await verifyIdentity(service);
    log(service.name + " already running and verified on :" + service.port + " (reusing, never stopping it).");
    return;
  }
  log("Starting " + service.name + " on :" + service.port + "...");
  const child = spawnNode(service.path);
  owned.add(child);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline && !stopping) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(service.name + " exited during startup (" + String(child.exitCode ?? child.signalCode) + ").");
    }
    if (await isHealthy(service)) {
      await verifyIdentity(service);
      log(service.name + " ready.");
      return;
    }
    await sleep(400);
  }
  fail(service.name + " did not pass /health and identity checks within " +
    START_TIMEOUT_MS / 1000 + " s. Check port " + service.port + " and server logs.");
}
async function resetFeed(feed: Service): Promise<void> {
  log("Resetting Bait demo feed (POST /reset removes existing feed data on this instance)...");
  let response: Response;
  try {
    response = await request(new URL("/reset", feed.url), { method: "POST" });
  } catch (error) {
    fail("POST /reset failed: " + String(error));
  }
  if (!response.ok) fail("POST /reset failed (HTTP " + response.status + ").");
}
/** B1 MerchantRiskSummary contract: only rule-backed findings affect scenario scoring. */
export function issuesInFeed(value: unknown): string[] {
  if (!Array.isArray(value)) return ["GET /merchants did not return an array."];
  const issues: string[] = [];
  if (value.length !== EXPECTED_IDS.length) {
    issues.push("Expected exactly five demo merchants, found " + value.length + ".");
  }
  for (const id of EXPECTED_IDS) {
    const matches = value.map(asObject).filter(item => item?.id === id);
    if (matches.length !== 1) {
      issues.push(id + ": expected exactly one merchant record, found " + matches.length);
      continue;
    }
    const merchant = matches[0]!;
    const wanted = EXPECTED_FLAGS[id] || [];
    const evidence = Array.isArray(merchant.evidence) ? merchant.evidence.map(asObject) : null;
    if (!evidence) {
      issues.push(id + ": missing B1 evidence[] array");
      continue;
    }
    const actual = [...new Set(evidence.filter(item => item?.by === "rule")
      .map(item => item?.flag).filter((flag): flag is string => typeof flag === "string"))].sort();
    const expected = [...wanted].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      issues.push(id + ": rule flags [" + actual.join(", ") + "], expected [" +
        expected.join(", ") + "]");
    }
    const verdict = merchant.verdict;
    const expectedVerdict = id === "honest" ? "ok" : "risky";
    if (verdict !== expectedVerdict) {
      issues.push(id + ": verdict " + stringField(verdict) + ", expected " + expectedVerdict);
    }
    const score = merchant.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      issues.push(id + ": B1 score must be a finite 0..1 number");
    }
  }
  return issues;
}
async function waitForEvidence(feed: Service): Promise<JsonObject[]> {
  log("Waiting for five merchant risk records...");
  const deadline = Date.now() + FEED_TIMEOUT_MS;
  let issues: string[] = [];
  while (Date.now() < deadline && !stopping) {
    try {
      const result = await getJson(new URL("/merchants", feed.url));
      issues = issuesInFeed(result);
      if (!issues.length) return result as JsonObject[];
    } catch (error) {
      issues = [String(error)];
    }
    await sleep(500);
  }
  fail("Decoy evidence did not meet the required five-merchant contract after " +
    FEED_TIMEOUT_MS / 1000 + " s:\n  - " + issues.join("\n  - ") +
    "\nThe run was not marked successful.");
}
async function runAgent(path: string, args: string[], label: string): Promise<void> {
  if (stopping) fail("Demo interrupted.");
  log("Running " + label + "...");
  const child = spawnNode(path, args);
  activeAgent = child;
  const exit = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(label + " terminated by " + signal + "."));
      else resolve(code ?? 1);
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      exit,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new Error(label + " exceeded " + AGENT_TIMEOUT_MS / 1000 + " s."));
        }, AGENT_TIMEOUT_MS);
      }),
    ]);
    if (code !== 0) fail(label + " exited with status " + code + ". Check the agent logs.");
    log(label + " completed (exit 0).");
  } finally {
    if (timer) clearTimeout(timer);
    if (activeAgent === child) activeAgent = undefined;
  }
}
async function statsFrom(feed: Service): Promise<{ off: JsonObject; on: JsonObject }> {
  const value = asObject(await getJson(new URL("/stats", feed.url)));
  const off = asObject(value?.off);
  const on = asObject(value?.on);
  if (!off || !on ||
      !["spent", "wasted", "injections"].every(key => key in off) ||
      !["spent", "wasted", "blocked"].every(key => key in on)) {
    fail("GET /stats is missing required guard OFF/ON counters; refusing to fabricate results.");
  }
  return { off, on };
}
function parseStatsAtomic(value: unknown, field: string): bigint {
  // B0's DemoStats contract uses atomic-unit *integer strings*, never decimal USDC.
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    fail("Invalid USDC atomic-unit string in GET /stats (" + field + ").");
  }
  return BigInt(value);
}
export function formatStatsUsdc(value: unknown, field: string): string {
  const atomic = parseStatsAtomic(value, field);
  return (atomic / 1_000_000n).toString() + "." +
    (atomic % 1_000_000n).toString().padStart(6, "0");
}
export function assertAcceptance(stats: { off: JsonObject; on: JsonObject }): void {
  const mismatches: string[] = [];
  const expectations: Array<[string, unknown, bigint]> = [
    ["OFF spent", stats.off.spent, 100_000n],
    ["OFF wasted", stats.off.wasted, 60_000n],
    ["ON spent", stats.on.spent, 10_000n],
    ["ON wasted", stats.on.wasted, 0n],
  ];
  for (const [label, value, expected] of expectations) {
    if (parseStatsAtomic(value, label) !== expected) {
      mismatches.push(label + ": expected " + expected + " atomic units");
    }
  }
  if (stats.off.injections !== 1) mismatches.push("OFF injections expected 1");
  if (stats.on.blocked !== 4) mismatches.push("ON blocked expected 4");
  if (mismatches.length) {
    fail("Observed feed metrics do not match scripted acceptance targets:\n  - " +
      mismatches.join("\n  - ") + "\nActual counters above were not altered. Demo failed.");
  }
  log("Scripted scenario counters match acceptance targets (not proof of on-chain receipts).");
}

function summary(stats: { off: JsonObject; on: JsonObject }, merchants: JsonObject[]): void {
  const n = merchants.filter(m => m.verdict === "risky").length;
  const unit = process.env.MOCK_FACILITATOR === "1" ? "SIMULATED facilitator" : "Base Sepolia configured; verify actual receipts";
  log("=== MEASURED DEMO SUMMARY (from GET /stats and /merchants) ===");
  log("Payment mode: " + unit);
  log("Decoy: " + merchants.length + " observed merchant records; " + n + " flagged risky.");
  log("Guard OFF: spent " + formatStatsUsdc(stats.off.spent, "OFF spent") +
    " USDC; wasted " + formatStatsUsdc(stats.off.wasted, "OFF wasted") +
    " USDC; injections " + stringField(stats.off.injections) + ".");
  log("Guard ON:  spent " + formatStatsUsdc(stats.on.spent, "ON spent") +
    " USDC; wasted " + formatStatsUsdc(stats.on.wasted, "ON wasted") +
    " USDC; blocked " + stringField(stats.on.blocked) + ".");
  log("Numbers are sourced from the running Risk Feed, not hardcoded targets.");
}
async function maybePause(seconds: number): Promise<void> {
  if (seconds) {
    log("Pausing " + seconds + " s for screen capture...");
    await sleep(seconds * 1000);
  }
}
async function cleanup(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (activeAgent && activeAgent.exitCode === null) activeAgent.kill();
  const children = [...owned];
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await Promise.race([
      new Promise<void>(resolve => child.once("exit", () => resolve())),
      sleep(3_000),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }));
  owned.clear();
  stopWaiter?.();
}
async function main(): Promise<void> {
  process.once("SIGINT", () => { process.exitCode = 130; void cleanup(); });
  process.once("SIGTERM", () => { process.exitCode = 143; void cleanup(); });
  try {
    const args = parseArgs();
    if (args.help) {
      log("Usage: pnpm demo [--check] [--pause 0..30]");
      log("--check validates integration files/config only; no network calls, reset, or payments.");
      return;
    }
    loadEnv();
    const { merchant, feed } = validateConfig();
    if (args.check) {
      log("Preflight OK: Node, files, tsx, package script, wallet formats, local service URLs.");
      log("This does NOT confirm balances, live services or payment settlement. Run pnpm preflight for network checks.");
      return;
    }
    log("Scripted deterministic demonstration; facilitator: " +
      (process.env.MOCK_FACILITATOR === "1" ? "SIMULATED" : "Base Sepolia testnet"));
    await verifyRpcChain();
    await startService(merchant);
    await startService(feed);
    await resetFeed(feed);
    await maybePause(args.pause);
    await runAgent("src/agents/decoy.ts", [], "Decoy Agent");
    const merchantRows = await waitForEvidence(feed);
    log("Risk Feed verified: honest = ok; four risky merchants flagged.");
    await maybePause(args.pause);
    await runAgent("src/agents/customer.ts", ["--guard", "off", "--scripted"], "Customer Guard OFF");
    await maybePause(args.pause);
    await runAgent("src/agents/customer.ts", ["--guard", "on", "--scripted"], "Customer Guard ON");
    const measured = await statsFrom(feed);
    summary(measured, merchantRows);
    assertAcceptance(measured);
    log("Dashboard: " + feed.url.href);
    if (owned.size) {
      log("Dashboard stays online. Press Ctrl+C to stop ONLY services started by this demo.");
      await new Promise<void>(resolve => {
        stopWaiter = resolve;
        for (const child of owned) child.once("exit", () => {
          if (!stopping) {
            log("A demo-managed server exited unexpectedly; closing owned children.");
            process.exitCode = 1;
            void cleanup();
          }
        });
        if (stopping) resolve();
      });
    } else {
      log("Both services were already running; they remain untouched.");
    }
  } catch (error) {
    process.exitCode = process.exitCode || 1;
    log("FAILED: " + (error instanceof Error ? error.message : String(error)));
  } finally {
    await cleanup();
  }
}
// Allow B4 contract tests to import the pure validators without launching services.
const isDirectEntry = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectEntry) void main();
