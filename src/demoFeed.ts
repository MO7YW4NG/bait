/**
 * B4 owned risk feed: wraps B1 without modifying B1.
 * This entrypoint REFUSES to open data/bait.db. Only a new, parent-owned
 * temporary SQLite file is allowed. The session endpoint protects reset.
 */
import process from "node:process";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "@hono/node-server";
import { createFeedApp } from "./feed/server.js";

const session = process.env.BAIT_DEMO_SESSION;
const path = process.env.BAIT_DEMO_DB_PATH;
const target = process.env.FEED_URL;
if (!session || !/^[a-f0-9-]{36}$/i.test(session) || !path || !target) {
  throw new Error("B4 demo feed requires a valid session, temporary database and FEED_URL.");
}
const database = resolve(path);
const tempRoot = resolve(tmpdir());
if (database === resolve("data/bait.db") ||
    !(database.startsWith(tempRoot + (process.platform === "win32" ? "\\" : "/"))) ||
    !dirname(database).split(/[\\/]/).some(part => part.startsWith("bait-demo-"))) {
  throw new Error("Refusing to open a non-temporary or shared SQLite database.");
}
const url = new URL(target);
if (url.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !url.port || url.username || url.password || url.search || url.hash) {
  throw new Error("B4 feed must bind a loopback HTTP URL with explicit port.");
}
const score = Number(process.env.GUARD_MIN_SCORE ?? "0.6");
const { app, db } = createFeedApp({
  dbPath: database,
  merchantUrl: process.env.MERCHANT_URL ?? "http://127.0.0.1:4021",
  minScore: score,
});
app.get("/__demo/owner", c => c.json({ session, isolated: true }));
const server = serve({ fetch: app.fetch, port: Number(url.port), hostname: "127.0.0.1" },
  info => console.log("[bait:demo-feed] isolated SQLite feed serving B2 dashboard on :" + info.port));
let closing = false;
function close(): void {
  if (closing) return;
  closing = true;
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 3_000).unref();
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
