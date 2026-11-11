/**
 * B4-only ephemeral chain-id stub for a fully offline MOCK E2E demo.
 * It cannot submit transactions, query balances, or represent a live chain.
 * Base Sepolia chainId is returned only to satisfy B3's pre-sign network check.
 */
import http from "node:http";
import process from "node:process";
const session = process.env.BAIT_DEMO_SESSION;
const target = process.env.RPC_URL;
if (!session || !target) throw new Error("B4 mock RPC requires a demo session and RPC_URL.");
const url = new URL(target);
if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
    !url.port || url.username || url.password || url.search || url.hash) {
  throw new Error("B4 mock RPC must be loopback-only.");
}
const rpc = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url === "/__demo/owner") {
    res.end(JSON.stringify({ session, simulated: true, chainIdOnly: true }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/") {
    res.writeHead(404); res.end(JSON.stringify({ error: "not_found" })); return;
  }
  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
      if (body.length > 2_000) throw new Error("request too large");
    }
    const msg = JSON.parse(body) as { jsonrpc?: string; id?: unknown; method?: string };
    if (msg.jsonrpc !== "2.0" || msg.method !== "eth_chainId") {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null,
        error: { code: -32601, message: "B4 demo stub only implements eth_chainId" } }));
      return;
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result: "0x14a34" }));
  } catch {
    res.writeHead(400); res.end(JSON.stringify({ error: "invalid_rpc_request" }));
  }
});
rpc.listen(Number(url.port), "127.0.0.1", () => {
  console.log("[bait:demo-rpc] SIMULATED CHAIN-ID-ONLY RPC; no balances or chain transactions");
});
process.on("SIGINT", () => rpc.close(() => process.exit(0)));
process.on("SIGTERM", () => rpc.close(() => process.exit(0)));
