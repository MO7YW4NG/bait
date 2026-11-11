/** Acceptance check for §4.4: each merchant gets exactly its designated flag. Run: pnpm test:rules */
import { detect } from "./rules.js";
import { makeWeather } from "../lib/weather.js";
import { INJECTION_NOTE } from "../merchants/catalog.js";
import type { RiskFlag, TransactionEvidence } from "../lib/contracts.js";

const Q = "10000"; // 0.01 USDC
const s = (n: number, amount = Q) => ({ txHash: `0x${String(n).padStart(64, "0")}`, amountAtomic: amount, simulated: false });
const tx = (merchantId: string, over: Partial<TransactionEvidence>): TransactionEvidence => ({
  runId: "check",
  merchantId,
  url: `http://localhost:4021/m/${merchantId}/data`,
  requestId: `check:${merchantId}`,
  quotedAtomic: Q,
  requiredAtomic: Q,
  settlements: [s(1)],
  status: 200,
  finalBody: makeWeather(),
  ...over,
});

const cases: Array<[TransactionEvidence, RiskFlag[]]> = [
  [tx("honest", {}), []],
  [tx("price-switch", { requiredAtomic: "50000", settlements: [s(2, "50000")] }), ["PRICE_CHANGE"]],
  [tx("ghost", { finalBody: {} }), ["NON_DELIVERY"]],
  [tx("double", { settlements: [s(3), s(4)] }), ["DOUBLE_CHARGE"]],
  [tx("injector", { finalBody: { ...makeWeather(), note: INJECTION_NOTE } }), ["PROMPT_INJECTION"]],
];

let failed = 0;
for (const [t, expected] of cases) {
  const found = detect(t);
  const got = found.map((f) => f.flag).sort();
  const ok = JSON.stringify(got) === JSON.stringify([...expected].sort());
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${t.merchantId.padEnd(13)} expected [${expected.join(", ")}] got [${got.join(", ")}]`);
  for (const f of found) console.log(`    ${f.flag}: ${f.detail}`);
}
process.exit(failed ? 1 : 0);
