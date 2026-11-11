/**
 * B5 integration acceptance gate. No network calls or writes by default.
 *
 * pnpm exec tsx scripts/verify-integration.ts
 * pnpm exec tsx scripts/verify-integration.ts --live
 * pnpm exec tsx scripts/verify-integration.ts --isolated --allow-write
 * pnpm exec tsx scripts/verify-integration.ts --live --expect-demo
 *
 * --isolated spins up B1 with an IN-MEMORY SQLite DB and a random loopback
 * port. It never uses data/bait.db, a deployed Feed, real wallets or testnet.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { fixtureCases, makeEvidence, demoSpendFixtures, EXPECTED_IDS,
  EXPECTED_FLAGS, syntheticEvent } from '../tests/integration/fixtures.js';
import { assertDemoTargets, atomic, normalizeUrl, object, validateEvent,
  validateMerchant, validateQuote, validateRisk, validateStats,
  validateWriteAck } from '../tests/integration/validators.js';

type Status = 'PASS' | 'FAIL' | 'SKIP';
type Result = { name: string; status: Status; reason?: string };
const results: Result[] = [];
const ROOT = resolve(import.meta.dirname ?? '.', '..');
const A_FILES = ['src/merchants/server.ts', 'src/lib/x402buyer.ts',
  'src/guard/guardedFetch.ts', 'src/agents/decoy.ts', 'src/detector/rules.ts'];

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/(?:0x)?[0-9a-f]{64}/gi, '[REDACTED_HEX]');
}
function skip(name: string, reason: string): void { results.push({ name, status: 'SKIP', reason }); }
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, status: 'PASS' }); }
  catch (error) { results.push({ name, status: 'FAIL', reason: reasonOf(error) }); }
}
function parseArgs(args: string[]) {
  const flags = new Set(args);
  const supported = new Set(['--live', '--isolated', '--allow-write', '--expect-demo', '--help']);
  for (const flag of flags) if (!supported.has(flag)) throw new Error(`Unknown flag ${flag}`);
  if (flags.has('--allow-write') !== flags.has('--isolated')) {
    throw new Error('Writes require BOTH --isolated and --allow-write (in-memory B1 instance only)');
  }
  if (flags.has('--expect-demo') && !flags.has('--live')) throw new Error('--expect-demo requires --live');
  return { live: flags.has('--live'), isolated: flags.has('--isolated'),
    expectDemo: flags.has('--expect-demo'), help: flags.has('--help') };
}
function serviceUrl(value: string, fallback: string): URL {
  const url = new URL(value || fallback);
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (!loopback || url.protocol !== 'http:' || url.username || url.password || url.search || url.hash) {
    throw new Error('B5 live checks are restricted to unauthenticated HTTP loopback endpoints');
  }
  return url;
}
async function request(url: URL | string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(5_000),
    headers: { accept: 'application/json', ...init.headers } });
}
async function getJson(base: URL, path: string): Promise<unknown> {
  const res = await request(new URL(path, base));
  assert.equal(res.status, 200, `${path} expected HTTP 200, got ${res.status}`);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/i);
  return res.json();
}
async function post(base: URL, path: string, payload?: unknown): Promise<Response> {
  return request(new URL(path, base), { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload) });
}
async function postOk(base: URL, path: string, payload?: unknown): Promise<void> {
  const response = await post(base, path, payload);
  assert.ok([200, 201].includes(response.status), `${path} returned HTTP ${response.status}`);
  validateWriteAck(await response.json());
}
async function expect400(base: URL, path: string, payload: unknown): Promise<void> {
  const response = await post(base, path, payload);
  assert.equal(response.status, 400, `${path} must reject malformed data with HTTP 400`);
}
function closeEnough(actual: unknown, expected: number): void {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-8,
    `score ${String(actual)} != expected ${expected}`);
}

/** SSE client reads real HTTP EventSource frames and closes the connection. */
async function sseClient(base: URL, cursor?: number) {
  const abort = new AbortController();
  const url = new URL('/events', base);
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (cursor !== undefined) headers['Last-Event-ID'] = String(cursor);
  let response: Response;
  try { response = await request(url, { headers, signal: abort.signal }); }
  catch (error) { abort.abort(); throw error; }
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/i);
  assert.ok(response.body, 'SSE body missing');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pending: string[] = [];
  const next = async (): Promise<{ id: number; event: Record<string, unknown> }> => {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      let frame: string | undefined = pending.shift();
      if (!frame) {
        const remaining = Math.max(1, deadline - Date.now());
        const timed = AbortSignal.timeout(remaining);
        const read = reader.read();
        const chunk = await Promise.race([read, new Promise<never>((_, reject) =>
          timed.addEventListener('abort', () => reject(new Error('SSE frame timed out')), { once: true }))]);
        if (chunk.done) throw new Error('SSE stream closed unexpectedly');
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        pending.push(...frames);
        frame = pending.shift();
      }
      if (!frame) continue;
      const lines = frame.split('\n').filter(line => !line.startsWith(':'));
      const idLine = lines.find(line => line.startsWith('id:'));
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!idLine || !data) continue;
      const event = validateEvent(JSON.parse(data));
      const id = Number(idLine.slice(3).trim());
      assert.equal(id, event.id, 'SSE frame ID must match JSON event ID');
      return { id, event };
    }
    throw new Error('No matching SSE event received before deadline');
  };
  return { next, close: () => { abort.abort(); void reader.cancel().catch(() => {}); } };
}

async function ephemeralChecks(): Promise<void> {
  const feedFile = resolve(ROOT, 'src/feed/server.ts');
  if (!existsSync(feedFile) || !existsSync(resolve(ROOT, 'src/lib/db.ts'))) {
    skip('isolated B1 API/risk/accounting/SSE integration', 'B1 Feed/SQLite is not present in this checkout; merge B1 first');
    return;
  }
  let server: Server | undefined;
  let database: { close(): void } | undefined;
  try {
    // Runtime import avoids forcing B1 dependencies in the default fixture-only mode.
    const modulePath: string = '../src/feed/server.js';
    const { createFeedApp } = await import(modulePath) as {
      createFeedApp: (opts: { dbPath: string; merchantUrl: string }) =>
        { app: { fetch: (req: Request, env?: unknown, ctx?: unknown) => Response | Promise<Response> }, db: { close(): void } };
    };
    const nodeServer = await import('@hono/node-server');
    const instance = createFeedApp({ dbPath: ':memory:', merchantUrl: 'http://127.0.0.1:4021' });
    database = instance.db;
    server = nodeServer.serve({ fetch: instance.app.fetch, port: 0, hostname: '127.0.0.1' });
    if (!server.listening) await new Promise<void>(resolve => server!.once('listening', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const base = new URL(`http://127.0.0.1:${addr.port}`);

    await check('isolated API: GET /health, /risk unknown, /stats, /merchants', async () => {
      assert.equal((await request(new URL('/health', base))).status, 200);
      const risk = validateRisk(await getJson(base, '/risk?url=' + encodeURIComponent('http://bad.invalid/m/unknown/data')));
      assert.equal(risk.verdict, 'unknown'); assert.equal(risk.merchantId, null);
      validateStats(await getJson(base, '/stats'));
      assert.deepEqual(await getJson(base, '/merchants'), []);
      const bad = await request(new URL('/risk', base)); assert.equal(bad.status, 400);
    });

    await check('isolated API: rejects invalid atomic, tx hash and blocked-spend writes', async () => {
      const sample = makeEvidence('honest', [], 'a1');
      await expect400(base, '/evidence', { ...sample,
        transaction: { ...sample.transaction, quotedAtomic: 0.01 } });
      await expect400(base, '/evidence', { ...sample,
        transaction: { ...sample.transaction, settlements: [{
          txHash: '0xmockaa', amountAtomic: '10000', simulated: false,
          network: 'eip155:84532' }] } });
      await expect400(base, '/report', { url: 'http://127.0.0.1:4021/m/honest/data',
        outcome: 'good', txHash: 'not-a-hash' });
      await expect400(base, '/spend', { ...demoSpendFixtures()[5], spentAtomic: '10000' });
    });

    await check('isolated Risk: 5 decoy fixtures, 6/7 good, 1/7 risky, precise flags', async () => {
      for (const id of EXPECTED_IDS) {
        const flags = [...EXPECTED_FLAGS[id as keyof typeof EXPECTED_FLAGS]];
        await postOk(base, '/evidence', makeEvidence(id, flags, 'b1'));
        const raw = await getJson(base, '/risk?url=' +
          encodeURIComponent(`http://127.0.0.1:4021/m/${id}/data/?tracking=1#ignored`));
        const risk = validateRisk(raw);
        assert.equal(risk.merchantId, id);
        assert.deepEqual([...(risk.flags as string[])].sort(), flags.sort());
        assert.equal(risk.verdict, id === 'honest' ? 'ok' : 'risky');
        closeEnough(risk.score, id === 'honest' ? 6 / 7 : 1 / 7);
        for (const item of risk.evidence as Record<string, unknown>[]) {
          assert.equal(item.explorerUrl, null, 'simulated receipt cannot link to block explorer');
        }
      }
      const merchants = await getJson(base, '/merchants');
      assert.ok(Array.isArray(merchants)); assert.equal(merchants.length, 5);
      for (const m of merchants) { const entry = object(m, 'feed merchant summary');
        normalizeUrl(String(entry.url)); validateRisk(entry); }
    });

    await check('isolated Risk: same requestId dedupes; AI judge flags stay advisory', async () => {
      const evidence = makeEvidence('honest', [], 'b1');
      await postOk(base, '/evidence', evidence); // same requestId; must not add a second outcome
      let risk = validateRisk(await getJson(base, '/risk?url=' +
        encodeURIComponent('http://127.0.0.1:4021/m/honest/data')));
      closeEnough(risk.score, 6 / 7);
      await postOk(base, '/evidence', makeEvidence('advisory', [
        { flag: 'PROMPT_INJECTION', by: 'judge', detail: 'synthetic advisory only' }], 'c1'));
      risk = validateRisk(await getJson(base, '/risk?url=' +
        encodeURIComponent('http://127.0.0.1:4021/m/advisory/data')));
      assert.equal(risk.verdict, 'ok'); closeEnough(risk.score, 6 / 7);
      assert.equal((risk.evidence as Record<string, unknown>[])[0].by, 'judge');
    });

    await check('isolated Customer: persisted OFF/ON accounting equals fixture target', async () => {
      for (const record of demoSpendFixtures()) await postOk(base, '/spend', record);
      assertDemoTargets(await getJson(base, '/stats'));
    });

    await check('isolated SSE: publish, reset, replay cursor and no endless duplicates', async () => {
      const client = await sseClient(base);
      try {
        await postOk(base, '/events', syntheticEvent);
        const first = await client.next();
        assert.equal(first.event.type, 'quote');
        assert.equal(first.event.actor, 'b5-qa');
        await postOk(base, '/reset'); // ONLY ephemeral in-memory database
        const reset = await client.next();
        assert.equal(reset.event.type, 'reset');
        assert.ok(reset.id > first.id);
        const restarted = await sseClient(base, reset.id);
        try {
          await postOk(base, '/events', { ...syntheticEvent, type: 'run_finished' });
          const final = await restarted.next();
          assert.equal(final.event.type, 'run_finished');
          assert.ok(final.id > reset.id, 'reconnect must not replay acknowledged event');
          const health = await getJson(base, '/stats'); validateStats(health);
          // No infinite event feedback loop: reads/reconnects do not create stored events.
          const last = await sseClient(base, final.id);
          try {
            await postOk(base, '/events', { ...syntheticEvent, type: 'guard_allowed' });
            const after = await last.next();
            assert.equal(after.id, final.id + 1, 'read/reconnect must not create duplicate events');
          } finally { last.close(); }
        } finally { restarted.close(); }
      } finally { client.close(); }
    });

    await check('isolated Reset: risk, spend, merchants cleared (reset event remains)', async () => {
      const risk = validateRisk(await getJson(base, '/risk?url=' +
        encodeURIComponent('http://127.0.0.1:4021/m/honest/data')));
      assert.equal(risk.verdict, 'unknown');
      assert.equal(risk.merchantId, null);
      assert.deepEqual(await getJson(base, '/merchants'), []);
      const stats = validateStats(await getJson(base, '/stats'));
      const off = object(stats.off, 'off'); const on = object(stats.on, 'on');
      assert.equal(atomic(off.spent, 'off.spent'), 0n);
      assert.equal(atomic(on.spent, 'on.spent'), 0n);
    });
  } catch (error) {
    results.push({ name: 'isolated B1 harness startup', status: 'FAIL', reason: reasonOf(error) });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(done => server!.close(() => done()));
    }
    database?.close();
  }
}

async function liveChecks(expectDemo: boolean): Promise<void> {
  let feed: URL; let merchant: URL;
  try {
    feed = serviceUrl(process.env.FEED_URL ?? '', 'http://127.0.0.1:4030');
    merchant = serviceUrl(process.env.MERCHANT_URL ?? '', 'http://127.0.0.1:4021');
  } catch (error) {
    results.push({ name: 'live endpoint allowlist', status: 'FAIL', reason: reasonOf(error) });
    return;
  }
  await check('live read-only: Feed /health, /risk unknown, /stats, /merchants', async () => {
    assert.equal((await request(new URL('/health', feed))).status, 200);
    const unknown = validateRisk(await getJson(feed, '/risk?url=' +
      encodeURIComponent(`http://127.0.0.1:65534/unknown-b5-${Date.now()}`)));
    assert.equal(unknown.verdict, 'unknown');
    const merchants = await getJson(feed, '/merchants'); assert.ok(Array.isArray(merchants));
    for (const item of merchants) validateRisk(object(item, 'feed merchant summary'));
    validateStats(await getJson(feed, '/stats'));
  });
  await check('live read-only: Merchant /health, discovery, quote and unpaid HTTP 402', async () => {
    assert.equal((await request(new URL('/health', merchant))).status, 200);
    const listed = await getJson(merchant, '/merchants'); assert.ok(Array.isArray(listed));
    const found = new Map<string, Record<string, unknown>>();
    for (const item of listed) { const m = validateMerchant(item); found.set(m.id as string, m); }
    for (const id of EXPECTED_IDS) {
      const m = found.get(id); assert.ok(m, `merchant ${id} missing`);
      const quote = new URL(m.quoteUrl as string); const data = new URL(m.dataUrl as string);
      assert.equal(quote.origin, merchant.origin, 'discovery must stay on merchant server');
      assert.equal(data.origin, merchant.origin, 'data URL must stay on merchant server');
      validateQuote(await getJson(merchant, quote.pathname), id);
      const response = await request(data, { headers: { 'X-Request-Id': 'b5-unpaid-only' } });
      assert.equal(response.status, 402, `${id} did not challenge unpaid access`);
      const header = response.headers.get('PAYMENT-REQUIRED');
      assert.ok(header, `${id} missing PAYMENT-REQUIRED`);
      const decoded = object(JSON.parse(Buffer.from(header, 'base64').toString('utf8')), '402 challenge');
      assert.ok(Array.isArray(decoded.accepts) && decoded.accepts.length > 0);
      for (const term of decoded.accepts as unknown[]) {
        const challenge = object(term, 'x402 requirement');
        assert.equal(challenge.network, 'eip155:84532', 'mainnet forbidden');
        assert.equal(challenge.scheme, 'exact');
        atomic(challenge.amount, '402 accepts.amount');
      }
    }
  });
  if (expectDemo) await check('live observed GET /stats matches scripted target (not on-chain proof)',
    async () => assertDemoTargets(await getJson(feed, '/stats')));
  else skip('live observed customer accounting', 'Not asserted without --expect-demo; fixture targets are not observed records');
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error('FAIL argument validation: ' + reasonOf(error)); process.exitCode = 2; return; }
  if (args.help) {
    console.log('Usage: pnpm exec tsx scripts/verify-integration.ts [--live] [--expect-demo] [--isolated --allow-write]');
    console.log('Default: fixture and contract checks only. --live reads loopback endpoints. --isolated writes only to :memory: SQLite. No wallet signing or testnet payment.');
    return;
  }
  console.log('Bait B5 Integration QA (fixture values are synthetic; no real settlement is claimed)');
  if (Number(process.versions.node.split('.')[0]) !== 24) {
    skip('runtime Node.js 24 certification', `Node ${process.version} is running; repeat on Node 24 before release`);
  } else results.push({ name: 'runtime Node.js 24', status: 'PASS' });
  for (const [name, fn] of fixtureCases) await check(`fixture ${name}`, fn);
  if (args.isolated) await ephemeralChecks();
  else skip('isolated B1 API/risk/accounting/SSE integration', 'Requires explicit --isolated --allow-write; no writes by default');
  if (args.live) await liveChecks(args.expectDemo);
  else skip('live read-only Feed/Merchant API and x402 HTTP 402', 'Requires --live and running loopback services');
  if (!A_FILES.every(path => existsSync(resolve(ROOT, path)))) {
    skip('A payment core: guard pre-sign / failed-feed fail-closed / settlement',
      'One or more A-owned payment modules are absent; never claim a passing settlement test');
  } else {
    skip('A payment core: guard pre-sign / failed-feed fail-closed / settlement',
      'Requires isolated wallet/facilitator instrumentation and explicit payment opt-in; no payment is attempted by B5');
  }
  skip('real Base Sepolia settlement confirmation', 'No real testnet payment or chain lookup is attempted');
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;
  for (const r of results) console.log(`${r.status.padEnd(4)} ${r.name}${r.reason ? '\\n      Failure Reason: ' + r.reason : ''}`);
  console.log(`Overall Summary: PASS=${pass} FAIL=${fail} SKIP=${skipped} TOTAL=${results.length}`);
  console.log(`Overall: ${fail ? 'FAIL' : skipped ? 'PARTIAL (not release-certified)' : 'PASS'}`);
  if (fail) process.exitCode = 1;
}
void main().catch(error => { console.error('FAIL B5 harness: ' + reasonOf(error)); process.exitCode = 1; });
