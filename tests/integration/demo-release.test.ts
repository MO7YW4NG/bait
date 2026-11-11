/**
 * B5 independent release test for unmodified B4 interactive mock demo.
 * Requires B4 modules in checkout. No real payments or shared database resets.
 * Simultaneously occupies both default ports with B5-owned HTTP sentinels.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { resolve } from 'node:path';

type DemoStats = {
  off: { spent: string; wasted: string; injections: number };
  on: { spent: string; wasted: string; blocked: number };
};

test('B5 release: interactive Mock Demo preserves external 4021/4030, observed Feed stats, Ctrl+C and cleanup',
  { timeout: 180_000 }, async () => {
  const sentinels: http.Server[] = [];
  const writes: Record<number, number> = { 4021: 0, 4030: 0 };
  let child: ReturnType<typeof spawn> | undefined;
  let output = '';
  let exited: number | null = null;
  let signal: NodeJS.Signals | null = null;
  const existingTemp = new Set(readdirSync(tmpdir()).filter(x => x.startsWith('bait-demo-')));
  async function listen(port: number): Promise<void> {
    const sentinel = http.createServer((req, res) => {
      if (req.method !== 'GET') writes[port]++;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('external-b5-sentinel-' + port);
    });
    await new Promise<void>((ok, bad) => {
      sentinel.once('error', bad);
      sentinel.listen(port, '127.0.0.1', ok);
    });
    sentinels.push(sentinel);
  }
  try {
    await listen(4021);
    await listen(4030);
    // Actual B4 entrypoint. Mock by default even when CI contains real env keys.
    child = spawn(process.execPath, ['--import', 'tsx', 'src/demo.ts'], {
      cwd: resolve('.'), shell: false, windowsHide: true,
      env: { ...process.env,
        MERCHANT_URL: 'http://127.0.0.1:4021',
        FEED_URL: 'http://127.0.0.1:4030',
        GMI_API_KEY: '', JUDGE_MODEL: '', CUSTOMER_MODEL: '',
        MOCK_SETTLE_FAIL_RATE: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', part => { output = (output + part.toString()).slice(-80_000); });
    child.stderr!.on('data', part => { output = (output + part.toString()).slice(-80_000); });
    child.once('exit', (code, sig) => { exited = code; signal = sig; });
    const limit = Date.now() + 125_000;
    while (!output.includes('DEMO_COMPLETE:') && exited === null && signal === null && Date.now() < limit) {
      await sleep(250);
    }
    assert.ok(output.includes('DEMO_COMPLETE:'), 'Interactive demo never completed: ' + output.slice(-12_000));
    assert.equal(exited, null, 'Interactive demo should retain dashboard until SIGINT');
    assert.match(output, /SIMULATED MOCK FACILITATOR/);
    assert.match(output, /Numbers are sourced from the running Risk Feed/);
    assert.match(output, /Port conflict/);
    assert.doesNotMatch(output, /REAL BASE SEPOLIA TESTNET ONLY/);
    const dashboard = /Dashboard:\s+(http:\/\/127\.0\.0\.1:(\d+))/.exec(output);
    assert.ok(dashboard, 'Demo did not print a dashboard URL');
    const merchant = /Starting Merchant on :(\d+)/.exec(output);
    assert.ok(merchant, 'Demo did not identify merchant port');
    assert.notEqual(merchant[1], '4021');
    assert.notEqual(dashboard[2], '4030');

    const url = dashboard[1]!;
    const statsResponse = await fetch(url + '/stats');
    assert.equal(statsResponse.status, 200);
    const stats = await statsResponse.json() as DemoStats;
    // These assertions query the ACTUALLY RUNNING isolated Feed, not fixtures.
    assert.deepEqual(stats, {
      off: { spent: '100000', wasted: '60000', injections: 1 },
      on: { spent: '10000', wasted: '0', blocked: 4 },
    });
    const merchants = await (await fetch(url + '/merchants')).json() as Array<{
      id: string; score: number; verdict: string;
      evidence: Array<{ txHash: string | null; explorerUrl: string | null; by: string; flag: string }>;
    }>;
    assert.equal(merchants.length, 5);
    for (const merchant of merchants) {
      assert.equal(merchant.verdict, merchant.id === 'honest' ? 'ok' : 'risky');
      // Honest gains one good weight-1 /report after Guard ON settles;
      // decoy initially supplied good weight-5 => (1+6)/(2+6) = 7/8.
      // Four blocked sellers receive no additional settlement/report:
      // each remains one bad weight-5 decoy outcome => 1/7.
      const expectedScore = merchant.id === 'honest' ? 7 / 8 : 1 / 7;
      assert.ok(Math.abs(merchant.score - expectedScore) < 1e-8,
        merchant.id + ': observed post-customer score ' + merchant.score + ' != ' + expectedScore);
      for (const e of merchant.evidence) {
        assert.equal(e.explorerUrl, null);
        if (e.txHash) assert.match(e.txHash, /^0xmock/);
      }
    }
    assert.equal((await fetch(url)).status, 200, 'dashboard must be reachable while demo is paused');
    assert.equal((await fetch(url + '/app.js')).status, 200);
    assert.equal((await fetch(url + '/app.css')).status, 200);

    // 4021/4030 belong to other processes; they must never be touched or reset.
    for (const port of [4021, 4030]) {
      assert.equal(writes[port], 0, 'Demo wrote to an external listener at port ' + port);
      assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(),
        'external-b5-sentinel-' + port);
    }

    // Simulate the requested Ctrl+C signal (POSIX Node child).
    assert.ok(child.kill('SIGINT'), 'Could not deliver Ctrl+C');
    const exitDeadline = Date.now() + 10_000;
    while (exited === null && signal === null && Date.now() < exitDeadline) await sleep(100);
    assert.equal(exited, 130, 'Ctrl+C should terminate the demo with exit code 130, got ' +
      String(exited) + '/' + String(signal));
    await sleep(350);
    // No demo-owned HTTP services should survive.
    for (const port of [Number(merchant[1]), Number(dashboard[2])]) {
      let alive = false;
      try { await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(800) }); alive = true; }
      catch { /* expected: child closed */ }
      assert.equal(alive, false, 'Owned child still listening after Ctrl+C on ' + port);
    }
    const leaked = readdirSync(tmpdir()).filter(name =>
      name.startsWith('bait-demo-') && !existingTemp.has(name));
    assert.deepEqual(leaked, [], 'Demo left temp SQLite directories after Ctrl+C');
    assert.deepEqual(writes, { 4021: 0, 4030: 0 });
    console.log('B5_INTERACTIVE_MOCK_GATE PASS ' + JSON.stringify({
      observedStats: stats, merchantPort: Number(merchant[1]), feedPort: Number(dashboard[2]),
      externalWriteCount: writes, cleanExit: exited, leakedTempDirectories: leaked.length,
    }));
  } finally {
    if (child && exited === null) {
      child.kill('SIGINT');
      await sleep(1000);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    for (const server of sentinels) {
      await new Promise<void>(done => server.close(() => done()));
    }
  }
});
