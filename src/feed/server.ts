import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  BASE_SEPOLIA_NETWORK, FEED_EVENT_TYPES, RISK_FLAGS,
  type EvidencePostRequest, type FeedEvent, type FeedEventInput,
} from "../lib/contracts.js";
import { loadEnv } from "../lib/env.js";
import { RiskDatabase, normalizeMerchantUrl } from "../lib/db.js";

const atomic = z.string().regex(/^(0|[1-9][0-9]*)$/, "Expected a nonnegative atomic-unit string");
const hash = z.string().regex(/^0x(mock)?[0-9a-f]+$/i, "Malformed transaction hash (format only; NOT verified on-chain)");
const merchantId = z.string().min(1).max(256);
const settlement = z.object({
  txHash: hash,
  amountAtomic: atomic,
  simulated: z.boolean(),
  network: z.literal(BASE_SEPOLIA_NETWORK).optional(),
}).refine((receipt) => receipt.simulated === /^0xmock/i.test(receipt.txHash), {
  message: "Mock hashes must be marked simulated; real hashes must not be marked simulated",
});
const transactionSchema = z.object({
  merchantId,
  requestId: z.string().min(1).max(512),
  quotedAtomic: atomic,
  requiredAtomic: atomic.optional(),
  settlements: z.array(settlement).min(1, "A decoy outcome needs a recorded settlement"),
  finalBody: z.unknown(),
  status: z.number().int().min(100).max(599),
  runId: z.string().optional(),
  url: z.string().url().optional(),
});
const flagSchema = z.union([
  z.enum(RISK_FLAGS),
  z.object({
    flag: z.enum(RISK_FLAGS), by: z.enum(["rule", "judge"]),
    detail: z.string().optional(),
  }),
]);
const evidenceSchema = z.object({
  transaction: transactionSchema,
  flags: z.array(flagSchema),
});
const reportSchema = z.object({
  url: z.string().url(), outcome: z.enum(["good", "bad"]), txHash: hash,
});
const spendSchema = z.object({
  run: z.string().min(1), guard: z.enum(["on", "off"]),
  merchantId, spentAtomic: atomic, wastedAtomic: atomic,
  blocked: z.boolean(), injection: z.boolean(), ts: z.number().int().optional(),
});
const eventSchema = z.object({
  actor: z.string().min(1), type: z.enum(FEED_EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()), ts: z.number().int().optional(),
});

export interface FeedServerOptions {
  dbPath?: string;
  merchantUrl?: string;
  minScore?: number;
  webRoot?: string;
}

/** Each app owns exactly one SQLite connection and its SSE subscribers. */
export function createFeedApp(options: FeedServerOptions = {}) {
  const db = new RiskDatabase(options.dbPath ?? "data/bait.db");
  const minScore = options.minScore ?? 0.6;
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    db.close();
    throw new RangeError("minScore must be between 0 and 1");
  }
  const merchantUrl = options.merchantUrl ?? "http://localhost:4021";
  const webRoot = options.webRoot ?? resolve("web");
  const listeners = new Set<(event: FeedEvent) => void>();
  const publish = (event: FeedEvent) => {
    for (const listener of listeners) listener(event);
  };
  const app = new Hono();

  app.onError((error, c) => {
    console.error("[feed] request error:", error instanceof Error ? error.message : String(error));
    return c.json({ error: "internal_server_error" }, 500);
  });

  app.get("/health", (c) => c.text("ok"));

  app.get("/risk", (c) => {
    const url = c.req.query("url");
    if (!url) return c.json({ error: "url query parameter is required" }, 400);
    try {
      return c.json(db.riskForUrl(url, minScore));
    } catch {
      return c.json({ error: "Invalid merchant URL" }, 400);
    }
  });

  app.post("/evidence", async (c) => {
    const parsed = evidenceSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid evidence", issues: parsed.error.issues }, 400);
    const { transaction, flags } = parsed.data;
    const url = transaction.url ??
      new URL("/m/" + encodeURIComponent(transaction.merchantId) + "/data", merchantUrl).toString();
    try {
      normalizeMerchantUrl(url);
      const id = db.recordDecoy(
        transaction as EvidencePostRequest["transaction"],
        flags as EvidencePostRequest["flags"], url);
      return c.json({ ok: true as const, id });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid evidence URL" }, 400);
    }
  });

  app.post("/report", async (c) => {
    const parsed = reportSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid report", issues: parsed.error.issues }, 400);
    try {
      const id = db.recordReport(parsed.data.url, parsed.data.outcome, parsed.data.txHash);
      // Syntax validation is NOT receipt verification or proof of settlement.
      c.header("X-Chain-Verified", "false");
      c.header("X-Payment-Proof", "format-only");
      return c.json({ ok: true as const, id });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid report URL" }, 400);
    }
  });

  app.post("/spend", async (c) => {
    const parsed = spendSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid spend record", issues: parsed.error.issues }, 400);
    if (parsed.data.blocked && parsed.data.spentAtomic !== "0") {
      return c.json({ error: "A blocked payment cannot contain settled spend" }, 400);
    }
    const id = db.recordSpend(parsed.data);
    return c.json({ ok: true as const, id });
  });

  app.post("/events", async (c) => {
    const parsed = eventSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid event", issues: parsed.error.issues }, 400);
    const event = db.recordEvent(parsed.data as FeedEventInput);
    publish(event);
    return c.json({ ok: true as const, id: event.id });
  });

  app.get("/events", (c) => {
    const rawCursor = c.req.header("Last-Event-ID") ?? c.req.query("lastEventId");
    const lastEventId = rawCursor && /^[1-9][0-9]*$/.test(rawCursor) ? Number(rawCursor) : 0;
    return streamSSE(c, async (stream) => {
      let sentId = lastEventId;
      let pipeline = Promise.resolve();
      const send = (event: FeedEvent) => {
        if (event.id <= sentId) return;
        sentId = event.id;
        pipeline = pipeline.then(async () => {
          await stream.writeSSE({ id: String(event.id), data: JSON.stringify(event) });
        }).catch(() => { /* the client may have disconnected */ });
      };
      // Subscription and backlog capture are synchronous: no gap for lost events.
      const history = lastEventId > 0 ? db.eventsAfter(lastEventId) : db.recentEvents(50);
      for (const event of history) send(event);
      listeners.add(send);
      const keepalive = setInterval(() => {
        pipeline = pipeline.then(async () => { await stream.write(": keepalive\n\n"); }).catch(() => {});
      }, 15_000);
      keepalive.unref?.();
      try {
        await new Promise<void>((done) => stream.onAbort(done));
      } finally {
        clearInterval(keepalive);
        listeners.delete(send);
      }
    });
  });

  app.get("/merchants", (c) => c.json(db.merchants(minScore)));
  app.get("/stats", (c) => c.json(db.stats()));
  app.post("/reset", (c) => {
    db.reset();
    const event = db.recordEvent({ actor: "feed", type: "reset", payload: {} });
    publish(event);
    return c.json({ ok: true as const });
  });

  // Dashboard is optional at the B1 integration stage.
  if (existsSync(webRoot)) {
    app.use("/*", serveStatic({ root: webRoot }));
  }
  app.get("/", (c) => c.html(
    "<!doctype html><html><head><meta charset='utf-8'><title>Bait Risk Feed</title></head>" +
    "<body><h1>Bait Risk Feed API</h1><p>Dashboard is not installed yet.</p></body></html>"
  ));
  return { app, db };
}

const isDirectEntry = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectEntry) {
  const env = loadEnv("feed");
  const port = Number(new URL(env.FEED_URL).port || "4030");
  const { app, db } = createFeedApp({
    minScore: env.GUARD_MIN_SCORE,
    merchantUrl: process.env.MERCHANT_URL ?? "http://localhost:4021",
  });
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
    console.log("[feed] listening at http://127.0.0.1:" + info.port);
  });
  server.on("close", () => db.close());
}
