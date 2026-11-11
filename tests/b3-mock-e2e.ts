/**
 * B3-owned live HTTP integration smoke test, 100% simulated.
 *
 * Starts the REAL A Merchant Zoo (MOCK_FACILITATOR=1), the REAL B1 Feed
 * backed by an isolated SQLite file, and A's Decoy plus B3 CLI as child
 * processes. The JSON-RPC server implements eth_chainId ONLY.
 * Test-only keys are intentionally unfunded; nothing submits to a chain.
 *
 * Run: pnpm exec tsx tests/b3-mock-e2e.ts
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import { createFeedApp } from '../src/feed/server.js';

const cwd = resolve('.');
const ids = ['honest', 'price-switch', 'ghost', 'double', 'injector'] as const;
const flags: Record<string, string[]> = {
  honest: [],
  'price-switch': ['PRICE_CHANGE'],
  ghost: ['NON_DELIVERY'],
  double: ['DOUBLE_CHARGE'],
  injector: ['PROMPT_INJECTION']
};
type Run = {
  runId: string;
  guard: 'on' | 'off';
  spent: string; wasted: string; unverified: string;
  blocked: number; injections: number;
  merchants: Array<{
    merchantId: string; attempts: number; spent: string; wasted: string;
    blocked: boolean; delivered: boolean; injection: boolean;
  }>;
  errors: string[]; telemetryErrors: string[];
};

async function unusedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveDone, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolveDone));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('No TCP port');
  const port = address.port;
  await new Promise<void>((resolveDone, reject) =>
    server.close(error => error ? reject(error) : resolveDone()));
  return port;
}
async function waitHttp(url: string, child?: ChildProcessWithoutNullStreams): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (child && child.exitCode !== null) throw new Error('Merchant process exited before readiness');
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return;
    } catch { /* waiting for service to bind */ }
    await delay(100);
  }
  throw new Error('Timed out waiting for HTTP service at ' + url);
}
function childEnv(rpcUrl: string, feedUrl: string, merchantUrl: string) {
  // Force simulated mode regardless of runner or developer shell settings.
  // These deterministic test-only keys must not come from any wallet secret.
  return {
    ...process.env,
    MOCK_FACILITATOR: '1',
    RPC_URL: rpcUrl, FEED_URL: feedUrl, MERCHANT_URL: merchantUrl,
    CUSTOMER_PRIVATE_KEY: '0x' + '2'.repeat(64),
    DECOY_PRIVATE_KEY: '0x' + '1'.repeat(64),
    MERCHANT_PAYTO: '0x' + '3'.repeat(40),
    MAX_PRICE_PER_CALL_USDC: '0.10',
    GUARD_MIN_SCORE: '0.6',
    GMI_API_KEY: '', CUSTOMER_MODEL: '', JUDGE_MODEL: '',
    FORCE_COLOR: '0'
  };
}
function launch(file: string, args: string[], env: NodeJS.ProcessEnv) {
  const proc = spawn('pnpm', ['exec', 'tsx', file, ...args], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => { stdout += chunk; });
  proc.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return { proc, read: () => ({ stdout, stderr }) };
}
async function execute(file: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = launch(file, args, env);
  const result = await Promise.race([
    new Promise<number>((resolveDone, reject) => {
      child.proc.once('error', reject);
      child.proc.once('close', code => resolveDone(code ?? -1));
    }),
    delay(90_000).then(() => { throw new Error('Child process timed out: ' + file); })
  ]).catch(error => { child.proc.kill('SIGKILL'); throw error; });
  const logs = child.read();
  if (result !== 0) {
    throw new Error(file + ' exited ' + result + '\n' +
      logs.stdout.slice(-5500) + '\n' + logs.stderr.slice(-3500));
  }
  return logs.stdout;
}
async function stop(server: Server) {
  await new Promise<void>(resolveDone => server.close(() => resolveDone()));
}
async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200, url + ' must return 200');
  return response.json();
}
function parseCustomerStdout(output: string): Run {
  const start = output.indexOf('{\n  "runId":');
  assert.ok(start >= 0, 'Customer must print structured run JSON: ' + output.slice(-2500));
  const run = JSON.parse(output.slice(start)) as Run;
  assert.deepEqual(run.errors, [], 'Customer reported errors');
  assert.deepEqual(run.telemetryErrors, [], 'Customer failed telemetry writes');
  assert.equal(run.unverified, '0.000000', 'No mock settlement may remain unverified');
  assert.equal(run.merchants.length, 5);
  return run;
}
async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'bait-b3-mock-'));
  const dbPath = join(tmp, 'risk.sqlite');
  const [merchantPort, feedPort] = await Promise.all([unusedPort(), unusedPort()]);
  const merchantUrl = 'http://127.0.0.1:' + merchantPort;
  const feedUrl = 'http://127.0.0.1:' + feedPort;
  const rpc = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let json: { id?: number; method?: string };
    try { json = JSON.parse(body); }
    catch { res.writeHead(400).end(); return; }
    if (json.method !== 'eth_chainId') {
      res.writeHead(400, { 'content-type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', id: json.id, error: { code: -32601, message: 'mock RPC only implements chain ID' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ jsonrpc: '2.0', id: json.id, result: '0x14a34' }));
  });
  await new Promise<void>((done, reject) =>
    rpc.once('error', reject).listen(0, '127.0.0.1', done));
  const rpcPort = (rpc.address() as {port:number}).port;
  const env = childEnv('http://127.0.0.1:' + rpcPort, feedUrl, merchantUrl);
  const { app, db } = createFeedApp({ dbPath, merchantUrl, minScore: 0.6, webRoot: join(tmp, 'no-dashboard') });
  const feed = serve({ fetch: app.fetch, port: feedPort, hostname: '127.0.0.1' });
  const merchant = launch('src/merchants/server.ts', [], env);
  try {
    await waitHttp(feedUrl + '/health');
    await waitHttp(merchantUrl + '/health', merchant.proc);
    const listing = await fetchJson(merchantUrl + '/merchants');
    assert.deepEqual(listing.map((m: {id:string}) => m.id), ids);
    for (const id of ids) {
      const challenge = await fetch(merchantUrl + '/m/' + id + '/data');
      assert.equal(challenge.status, 402, id + ' must require x402');
      assert.ok(challenge.headers.get('PAYMENT-REQUIRED'), id + ' missing x402 requirements');
    }
    const reset = await fetch(feedUrl + '/reset', { method: 'POST' });
    assert.equal(reset.status, 200);

    await execute('src/agents/decoy.ts', [], env);
    const decoyRisks: Array<{ id: string; verdict: string; flags: string[]; evidence: any[] }> = [];
    for (const id of ids) {
      const risk = await fetchJson(feedUrl + '/risk?url=' +
        encodeURIComponent(merchantUrl + '/m/' + id + '/data'));
      assert.equal(risk.merchantId, id);
      assert.equal(risk.verdict, id === 'honest' ? 'ok' : 'risky',
        'Decoy evidence should classify ' + id);
      assert.deepEqual([...risk.flags].sort(), [...flags[id]].sort(), 'Unexpected risk flags for ' + id);
      if (id !== 'honest') {
        assert.ok(risk.evidence.length >= 1, id + ' missing evidence');
        for (const item of risk.evidence) {
          assert.equal(item.explorerUrl, null, 'Mock receipt cannot receive a real explorer link');
          assert.match(item.txHash, /^0xmock/i);
        }
      }
      decoyRisks.push({ id, verdict: risk.verdict, flags: risk.flags, evidence: risk.evidence });
    }
    const reportedMerchants = await fetchJson(feedUrl + '/merchants');
    assert.equal(reportedMerchants.length, 5);

    const off = parseCustomerStdout(await execute('src/agents/customer.ts',
      ['--guard', 'off', '--scripted'], env));
    assert.equal(off.guard, 'off');
    assert.equal(off.spent, '0.100000');
    assert.equal(off.wasted, '0.060000');
    assert.equal(off.blocked, 0);
    assert.equal(off.injections, 1);
    assert.equal(off.merchants.find(m => m.merchantId === 'double')?.attempts, 2);
    assert.equal(off.merchants.find(m => m.merchantId === 'price-switch')?.spent, '0.050000');
    assert.equal(off.merchants.find(m => m.merchantId === 'ghost')?.delivered, false);

    const on = parseCustomerStdout(await execute('src/agents/customer.ts',
      ['--guard', 'on', '--scripted'], env));
    assert.equal(on.guard, 'on');
    assert.equal(on.spent, '0.010000');
    assert.equal(on.wasted, '0.000000');
    assert.equal(on.blocked, 4);
    assert.equal(on.injections, 0);
    assert.deepEqual(on.merchants.filter(m => m.blocked).map(m => m.merchantId).sort(),
      ['price-switch','ghost','double','injector'].sort());
    for (const m of on.merchants.filter(m => m.blocked)) {
      assert.equal(m.spent, '0.000000', 'Blocked transactions must never charge');
      assert.equal(m.attempts, 0, 'Blocked transactions must never contain settlements');
    }

    const stats = await fetchJson(feedUrl + '/stats');
    assert.deepEqual(stats, {
      off: { spent: '100000', wasted: '60000', injections: 1 },
      on: { spent: '10000', wasted: '0', blocked: 4 }
    });
    const persisted = new DatabaseSync(dbPath);
    try {
      const rows = persisted.prepare('SELECT run, guard, merchant_id, spent_atomic, wasted_atomic, blocked, injection FROM spend ORDER BY id').all() as Array<{run:string;guard:string;merchant_id:string;spent_atomic:string;wasted_atomic:string;blocked:number;injection:number}>;
      assert.equal(rows.length, 10, 'B1 SQLite must persist one /spend row per merchant per run');
      assert.equal(new Set(rows.filter(r => r.guard === 'off').map(r => r.run)).size, 1);
      assert.equal(new Set(rows.filter(r => r.guard === 'on').map(r => r.run)).size, 1);
      assert.ok(rows.every(r => r.blocked === 0 || r.spent_atomic === '0'));
      assert.equal(rows.filter(r => r.guard === 'on' && r.blocked === 1).length, 4);
    } finally { persisted.close(); }

    const events = db.eventsAfter(0, 1000);
    assert.ok(events.some(e => e.actor === 'decoy' && e.type === 'flag_raised'));
    assert.equal(events.filter(e => e.actor === 'customer' && e.type === 'payment_settled' &&
      e.payload.runId === off.runId).length, 6);
    assert.equal(events.filter(e => e.actor === 'customer' && e.type === 'payment_settled' &&
      e.payload.runId === on.runId).length, 1);
    assert.equal(events.filter(e => e.actor === 'customer' && e.type === 'guard_blocked' &&
      e.payload.runId === on.runId).length, 4);
    assert.ok(events.filter(e => e.type === 'payment_settled').every(e =>
      e.payload.simulated === true && typeof e.payload.txHash === 'string' &&
      /^0xmock/i.test(e.payload.txHash)));
    assert.ok(events.some(e => e.actor === 'customer' && e.type === 'run_finished' &&
      e.payload.runId === on.runId));

    const abort = new AbortController();
    try {
      const sse = await fetch(feedUrl + '/events?lastEventId=1', { signal: abort.signal });
      assert.equal(sse.status, 200);
      assert.match(sse.headers.get('content-type') ?? '', /text\/event-stream/);
      const chunk = await sse.body!.getReader().read();
      assert.ok(chunk.value && new TextDecoder().decode(chunk.value).includes('data:'),
        'SSE should replay a persisted event');
    } finally { abort.abort(); }

    console.log('B3_MOCK_E2E_RESULT=' + JSON.stringify({
      mode: 'MOCK_ONLY_NO_CHAIN_TRANSACTIONS', merchantCount: listing.length,
      decoy: decoyRisks.map(r => ({ id: r.id, verdict: r.verdict, flags: r.flags })),
      off: { spent: off.spent, wasted: off.wasted, blocked: off.blocked,
        injections: off.injections, doubleAttempts: 2 },
      on: { spent: on.spent, wasted: on.wasted, blocked: on.blocked },
      sqliteSpendRows: 10, persistedEvents: events.length, stats, sse: true
    }));
  } catch (error) {
    console.error('B3 Mock HTTP end-to-end failed:', error);
    const logs = merchant.read();
    console.error('Merchant stdout tail:', logs.stdout.slice(-2000));
    console.error('Merchant stderr tail:', logs.stderr.slice(-2000));
    throw error;
  } finally {
    merchant.proc.kill('SIGTERM');
    await stop(feed);
    await stop(rpc);
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
