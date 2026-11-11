/**
 * B4-only CLI smoke tests.
 * Run with: node --experimental-strip-types --test src/demo.test.ts
 * These test configuration safety, NOT payments or complete E2E behavior.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const original = fileURLToPath(new URL("./demo.ts", import.meta.url));
const fixtures: string[] = [];

function fixture(scaffold: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "bait-demo-test-"));
  fixtures.push(root);
  const demo = join(root, "src", "demo.ts");
  mkdirSync(dirname(demo), { recursive: true });
  cpSync(original, demo);
  if (scaffold) {
    for (const path of [
      "src/lib/contracts.ts",
      "src/merchants/server.ts",
      "src/feed/server.ts",
      "src/agents/decoy.ts",
      "src/agents/customer.ts",
      "src/demoFeed.ts",
      "src/demoRpc.ts",
      "web/index.html",
      "web/app.css",
      "web/app.js",
      "node_modules/tsx/index.js",
    ]) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, "// test fixture; never used to simulate payments\n");
    }
    writeFileSync(join(root, "node_modules/tsx/package.json"),
      JSON.stringify({ name: "tsx", type: "module", exports: "./index.js" }));
    writeFileSync(join(root, "package.json"),
      JSON.stringify({ type: "module", scripts: { demo: "tsx src/demo.ts" } }));
  }
  return root;
}
afterEach(() => {
  while (fixtures.length) rmSync(fixtures.pop() as string, { force: true, recursive: true });
});
function run(root: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath,
    ["--experimental-strip-types", join(root, "src", "demo.ts"), ...args], {
      cwd: root,
      env: {
        ...process.env,
        DECOY_PRIVATE_KEY: "0x" + "a".repeat(64),
        CUSTOMER_PRIVATE_KEY: "0x" + "b".repeat(64),
        MERCHANT_PAYTO: "0x" + "c".repeat(40),
        MOCK_FACILITATOR: "1",
        MERCHANT_URL: "http://localhost:4021",
        FEED_URL: "http://localhost:4030",
        ...extraEnv,
      },
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
  assert.equal(result.error, undefined, "spawn should not time out or fail");
  return { status: result.status, output: result.stdout + result.stderr };
}
test("help does not require scaffold, environment, servers, or payments", () => {
  const result = run(fixture(false), ["--help"]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Usage: pnpm demo/);
});
test("missing B0 or agent dependencies fail before touching feed or running payments", () => {
  const result = run(fixture(false), ["--check"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Missing integration files/);
  assert.match(result.output, /No payments or reset were attempted/);
});
test("unknown option fails with a readable message", () => {
  const result = run(fixture(false), ["--wrong-option"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Unknown argument/);
});
test("local --check accepts a complete fixture without calling any network service",
  { skip: Number(process.versions.node.split(".")[0]) < 24 }, () => {
    const root = fixture(true);
    const result = run(root, ["--check"]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Preflight OK/);
    assert.match(result.output, /No network, RPC, balance, reset or payment was attempted/);
    assert.equal(existsSync(join(root, "data", "bait.db")), false);
  });
test("rejects a remote Risk Feed before destructive reset",
  { skip: Number(process.versions.node.split(".")[0]) < 24 }, () => {
    const result = run(fixture(true), ["--check"], { FEED_URL: "https://example.com:4030" });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Refusing to reset or probe a remote host/);
  });
test("refuses a missing demo package script owned by B0",
  { skip: Number(process.versions.node.split(".")[0]) < 24 }, () => {
    const root = fixture(true);
    const path = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { scripts: Record<string, string> };
    delete pkg.scripts.demo;
    writeFileSync(path, JSON.stringify(pkg));
    const result = run(root, ["--check"]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /package\.json needs B0/);
  });
test("mock mode overrides a supplied invalid (or funded) wallet with disposable keys without logging it",
  { skip: Number(process.versions.node.split(".")[0]) < 24 }, () => {
    const result = run(fixture(true), ["--check"], { DECOY_PRIVATE_KEY: "not-a-private-key" });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Preflight OK/);
    assert.doesNotMatch(result.output, /not-a-private-key/);
  });
test("explicit --live refuses malformed wallet keys without leaking them",
  { skip: Number(process.versions.node.split(".")[0]) < 24 }, () => {
    const result = run(fixture(true), ["--check", "--live"], { DECOY_PRIVATE_KEY: "not-a-private-key" });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /DECOY_PRIVATE_KEY is missing/);
    assert.doesNotMatch(result.output, /not-a-private-key/);
  });
