import assert from "node:assert/strict";
import { once } from "node:events";
import { after, test } from "node:test";
import { serve } from "@hono/node-server";
import { createFeedApp } from "./server.js";
import { createFeedClient } from "../lib/feedClient.js";
import type { EvidencePostRequest, FeedEvent, FeedEventInput } from "../lib/contracts.js";

const { app, db } = createFeedApp({ dbPath: ":memory:", webRoot: "/does-not-exist/bait-web",
  merchantUrl: "http://127.0.0.1:4021" });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await once(server, "listening");
const address = server.address();
assert(address && typeof address !== "string");
const base = "http://127.0.0.1:" + address.port;
const api = createFeedClient(base);
after(async () => {
  await new Promise<void>((done, reject) =>
    server.close((error) => error ? reject(error) : done()));
  db.close();
});
const merchantUrl = (id: string, query = "") =>
  "http://127.0.0.1:4021/m/" + id + "/data" + query;

function receipt(suffix: string, amountAtomic = "10000") {
  return { txHash: "0xmock" + suffix, amountAtomic, simulated: true as const,
    network: "eip155:84532" as const };
}
function sample(id: string, flags: EvidencePostRequest["flags"] = [],
  requestId = "decoy:" + id): EvidencePostRequest {
  return {
    transaction: {
      merchantId: id, requestId, runId: "decoy-synthetic",
      url: merchantUrl(id, "?buyer=decoy"),
      quotedAtomic: "10000", requiredAtomic: "10000",
      settlements: [receipt("abcdef" + id.length.toString(16))],
      finalBody: { city: "Taipei", tempC: 25, condition: "Clear", humidity: 60,
        observedAt: "2026-11-11T12:00:00Z" },
      status: 200,
    },
    flags,
  };
}
async function rawPost(path: string, body: unknown) {
  return fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function assertApprox(value: number, expected: number) {
  assert.ok(Math.abs(value - expected) < 1e-10, String(value) + " != " + expected);
}

test("B1: live HTTP health, static absence and unknown risk", async () => {
  assert.equal(await api.health(), true);
  const index = await fetch(base + "/");
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Dashboard is not installed yet/);
  const response = await api.risk(merchantUrl("unknown", "?different=query"));
  assert.equal(response.verdict, "unknown");
  assert.equal(response.merchantId, null);
  assert.equal(response.score, 0.5);
  assert.equal((await fetch(base + "/risk?url=not-a-url")).status, 400);
});

test("B1: scores 6/7 and 1/7, rule vs judge, URL normalization, idempotent evidence", async () => {
  const good = sample("honest");
  const bad = sample("ghost", [{ flag: "NON_DELIVERY", by: "rule", detail: "Empty response" }]);
  assert.equal((await api.evidence(good)).ok, true);
  assert.equal((await api.evidence(bad)).ok, true);
  let honest = await api.risk(merchantUrl("honest", "?changed=param"));
  let ghost = await api.risk(merchantUrl("ghost"));
  assertApprox(honest.score, 6 / 7);
  assertApprox(ghost.score, 1 / 7);
  assert.equal(honest.verdict, "ok");
  assert.equal(ghost.verdict, "risky");
  assert.deepEqual(ghost.flags, ["NON_DELIVERY"]);
  assert.equal(ghost.evidence[0]?.explorerUrl, null);
  await api.evidence(good);
  await api.evidence(bad);
  honest = await api.risk(merchantUrl("honest"));
  ghost = await api.risk(merchantUrl("ghost"));
  assertApprox(honest.score, 6 / 7);
  assertApprox(ghost.score, 1 / 7);
  assert.equal(ghost.evidence.length, 1);

  await api.evidence(sample("judge-only", [{
    flag: "PROMPT_INJECTION", by: "judge", detail: "AI advisory note only",
  }]));
  const judge = await api.risk(merchantUrl("judge-only"));
  assert.equal(judge.verdict, "ok");
  assertApprox(judge.score, 6 / 7);
  assert.equal(judge.evidence[0]?.by, "judge");
  const merchants = await api.merchants();
  assert.equal(merchants.length, 3);
  assert.equal(merchants.find((row) => row.id === "ghost")?.url, merchantUrl("ghost"));
});

test("B1: report validates syntax but never claims chain verification; replay dedupe", async () => {
  const invalid = await rawPost("/report", { url: merchantUrl("honest"),
    outcome: "bad", txHash: "definitely-not-a-hash" });
  assert.equal(invalid.status, 400);
  const report = { url: merchantUrl("honest", "?q=1"), outcome: "bad" as const,
    txHash: "0xmockffee" };
  const first = await rawPost("/report", report);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("X-Chain-Verified"), "false");
  assert.equal(first.headers.get("X-Payment-Proof"), "format-only");
  assert.equal((await first.json()).ok, true);
  const withReport = await api.risk(merchantUrl("honest"));
  assertApprox(withReport.score, 6 / 8);
  await api.report(report);
  const afterReplay = await api.risk(merchantUrl("honest"));
  assertApprox(afterReplay.score, 6 / 8);
});

test("B1: report-first URLs promote to decoy identity and retain both outcomes", async () => {
  const url = merchantUrl("report-first");
  const report = { url: url + "?tracking=1", outcome: "bad" as const,
    txHash: "0xmockface0123" };
  assert.equal((await rawPost("/report", report)).status, 200);
  const placeholder = await api.risk(url);
  assert.equal(placeholder.merchantId, "report:" + url);
  assertApprox(placeholder.score, 1 / 3);

  const observation = sample("report-first", [
    { flag: "PROMPT_INJECTION", by: "judge", detail: "Advisory, not a rule failure" },
  ]);
  assert.equal((await api.evidence(observation)).ok, true);
  const promoted = await api.risk(url);
  assert.equal(promoted.merchantId, "report-first");
  assertApprox(promoted.score, 6 / 8);
  assert.equal(promoted.evidence[0]?.by, "judge");
  assert.equal((await api.merchants()).filter((m) => m.url === url).length, 1);
  assert.equal((await api.merchants()).some((m) => m.id === "report:" + url), false);
  await api.report(report);
  assertApprox((await api.risk(url)).score, 6 / 8);
});

test("B1: spend uses latest run per mode and bigint atomic sums", async () => {
  await api.spend({ run: "off-old", guard: "off", merchantId: "honest",
    spentAtomic: "99999", wastedAtomic: "99999", blocked: false, injection: true });
  await api.spend({ run: "on-old", guard: "on", merchantId: "honest",
    spentAtomic: "99999", wastedAtomic: "0", blocked: false, injection: false });
  await api.spend({ run: "off-latest", guard: "off", merchantId: "ghost",
    spentAtomic: "100000000000000000000", wastedAtomic: "10000",
    blocked: false, injection: true });
  await api.spend({ run: "off-latest", guard: "off", merchantId: "honest",
    spentAtomic: "10000", wastedAtomic: "0", blocked: false, injection: false });
  await api.spend({ run: "on-latest", guard: "on", merchantId: "ghost",
    spentAtomic: "0", wastedAtomic: "0", blocked: true, injection: false });
  await api.spend({ run: "on-latest", guard: "on", merchantId: "honest",
    spentAtomic: "10000", wastedAtomic: "0", blocked: false, injection: false });
  const stats = await api.stats();
  assert.deepEqual(stats.off, {
    spent: "100000000000000010000", wasted: "10000", injections: 1,
  });
  assert.deepEqual(stats.on, { spent: "10000", wasted: "0", blocked: 1 });
});

async function readSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { value: string }, timeoutMs = 4_000): Promise<FeedEvent> {
  const decode = new TextDecoder();
  for (;;) {
    const cut = state.value.indexOf("\n\n");
    if (cut !== -1) {
      const frame = state.value.slice(0, cut);
      state.value = state.value.slice(cut + 2);
      const line = frame.split("\n").find((part) => part.startsWith("data:"));
      if (line) return JSON.parse(line.slice(5).trim()) as FeedEvent;
      continue;
    }
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SSE read timeout")), timeoutMs)),
    ]);
    if (next.done) throw new Error("SSE ended before an event arrived");
    state.value += decode.decode(next.value, { stream: true }).replace(/\r\n/g, "\n");
  }
}

test("B1: SSE replays last 50, live events, reconnect cursor, reset broadcast", async () => {
  for (let i = 0; i < 55; i++) {
    const event: FeedEventInput = { actor: "test", type: "quote",
      payload: { merchantId: "honest", sequence: i } };
    const result = await api.event(event);
    assert.equal(result.ok, true);
  }
  const sse = await fetch(base + "/events", { headers: { Accept: "text/event-stream" } });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/);
  assert(sse.body);
  const reader = sse.body.getReader();
  const state = { value: "" };
  const replay: FeedEvent[] = [];
  for (let i = 0; i < 50; i++) replay.push(await readSseEvent(reader, state));
  assert.equal(replay[0]?.payload.sequence, 5);
  assert.equal(replay[49]?.payload.sequence, 54);
  const nextEvent = await api.event({ actor: "test", type: "guard_blocked",
    payload: { merchantId: "ghost", runId: "live" } });
  const live = await readSseEvent(reader, state);
  assert.equal(live.id, nextEvent.id);
  assert.equal(live.type, "guard_blocked");
  await reader.cancel();

  const resumed = await fetch(base + "/events", {
    headers: { "Last-Event-ID": String(replay[49].id) },
  });
  assert(resumed.body);
  const r2 = resumed.body.getReader();
  const replayed = await readSseEvent(r2, { value: "" });
  assert.equal(replayed.id, nextEvent.id);
  await api.reset();
  const reset = await readSseEvent(r2, { value: "" });
  assert.equal(reset.type, "reset");
  await r2.cancel();

  assert.deepEqual(await api.merchants(), []);
  assert.deepEqual(await api.stats(), {
    off: { spent: "0", wasted: "0", injections: 0 },
    on: { spent: "0", wasted: "0", blocked: 0 },
  });
  assert.equal((await api.risk(merchantUrl("ghost"))).verdict, "unknown");
  const afterReset = await fetch(base + "/events");
  assert(afterReset.body);
  const r3 = afterReset.body.getReader();
  assert.equal((await readSseEvent(r3, { value: "" })).type, "reset");
  await r3.cancel();
});

test("B1: reject malformed evidence/spend and accept duplicate events safely", async () => {
  const invalidEvidence = sample("ghost");
  invalidEvidence.transaction.settlements = [];
  assert.equal((await rawPost("/evidence", invalidEvidence)).status, 400);
  assert.equal((await rawPost("/spend", { run: "x", guard: "on",
    merchantId: "ghost", spentAtomic: "10.5", wastedAtomic: "0",
    blocked: true, injection: false })).status, 400);
  const duplicate: FeedEventInput = { actor: "test", type: "run_finished", payload: { runId: "same" } };
  await api.event(duplicate);
  await api.event(duplicate);
  const after = await fetch(base + "/events");
  assert(after.body);
  const reader = after.body.getReader();
  const state = { value: "" };
  const first = await readSseEvent(reader, state);
  const second = await readSseEvent(reader, state);
  assert.notEqual(first.id, second.id);
  await reader.cancel();
});
