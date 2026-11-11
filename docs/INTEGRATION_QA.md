# Bait B5 — Integration QA, Stage 2

**Status: NOT RELEASE-CERTIFIED.** Last verified 2026-11-11 (Asia/Taipei). Base checked: `main@64f27a112697ba49b5aeb253f263d61bab6b1fa7` (B0, B1, B2 **and A** merged); B5 integrated this snapshot by merge commit `91cc96749a10a6cf98586e8966bcb6ca8feb715f`. B3 and B4 were not on main when tested.

**Critical: 2 wallet-free pre-sign policy failures in A Guard; see [P0 issue #13](https://github.com/MO7YW4NG/bait/issues/13).** The fail is a rejection-policy decision check, **not** evidence of any signing or on-chain transaction. B5 MUST remain draft until corrected and retested.

## 1. Provenance and isolation

Node.js **v24.22.2**, pnpm **10.32.0**, Ubuntu GitHub Actions; only existing project dependencies. All SQLite mutations, synthetic `POST /evidence`, `POST /spend`, `POST /events` and `POST /reset` executed against `createFeedApp({dbPath: ':memory:'})` on a random loopback port. No deployed Feed or production database was written or reset.

- **Current isolated CI run:** [Actions 43020663590](https://github.com/MO7YW4NG/bait/actions/runs/43020663590), ephemeral **Draft PR #12**, branch `test/b5-stage2-node24-20261111`. It overlays the **unmodified** B3 source/test blobs on B5 + current A/main to typecheck and test compatibility; the temporary workflow is **not part of B5 PR #6** and must never merge.
- **Independent B1 CI:** [Actions 43016414756](https://github.com/MO7YW4NG/bait/actions/runs/43016414756) — Node 24, actual loopback TCP/HTTP, SQLite in-memory, risk scoring, SSE and CLI smoke.
- **Independent B2 CI:** [Actions 43017943985](https://github.com/MO7YW4NG/bait/actions/runs/43017943985) — Node 24, JS regression, real Chromium + B1 API + isolated SQLite. Browser shows `SIMULATED · NO CHAIN TX`, no mock explorer links, and consumes live SSE/stats.
- **Independent B3/A CI:** [Actions 43018155832](https://github.com/MO7YW4NG/bait/actions/runs/43018155832) — Node 24, typecheck against A exports and adapter tests, **no wallet/payment**.

The integrated temporary CI itself reports overall **failure** because the two new Guard security cases correctly expose unsafe decisions. No SKIP is counted as PASS.

## 2. Exact test results: classify by evidence type

| Gate (Node 24 unless stated) | PASS | FAIL | SKIP | Evidence |
| --- | ---: | ---: | ---: | --- |
| `pnpm check` with B1+B2+A+B3 overlay | 1 | 0 | 0 | Stage-2 CI |
| B1 `tsx --test src/feed/server.test.ts` | 8 | 0 | 0 | Real TCP HTTP / `:memory:` SQLite / SSE |
| B2 `node --check` + `node --test web/app.test.cjs` | 2 tests + syntax | 0 | 0 | Browser logic regressions |
| B2 real Chromium/API/SSE E2E from existing CI | 1 | 0 | 0 | Real browser; simulated evidence, no chain payment |
| B5 default `verify-integration.ts` | 8 | 0 | 4 | Contract and **synthetic** fixtures; no writes |
| B5 `--isolated --allow-write` | **16** | **0** | **3** | Actual B1 endpoints, in-memory database, score, SSE |
| B5 `--live` on ephemeral local A Merchant and B1 Feed | **10** | **0** | **4** | Includes 5 unpaid HTTP 402 challenges; no signature |
| A deterministic detector `pnpm test:rules` | 5 | 0 | 0 | Five expected deterministic flags |
| B3 customer/adapter/A compatibility unit tests | 28 | 0 | 0 | Unmodified B3 snapshot, no payments |
| B3 strict typecheck against A | 1 | 0 | 0 | Export signatures |
| B5 wallet-free `guard-safety.test.ts` | **5** | **2** | 0 | **A payment safety blocking issue** |
| Real testnet settlement + Guard OFF/ON payment comparison | 0 | 0 | **SKIP** | No wallet, faucet, settlement or chain verification |

**Important:** per-command PASS/FAIL/SKIP counts are **not additive** because B5 default, isolated and live commands each repeat the same fixture cases. A green local fixture is not evidence of a payment.

### B5 isolated test cases — verified 16 PASS / 0 FAIL / 3 SKIP

1. Node 24 runtime (PASS).
2. Seven fixture tests: atomic amount precision, mock settlement and network contract, risk evidence shape/timestamps/explorer prohibitions, event type/timestamp, URL normalization, Bayesian expectations, and synthetic customer accounting (PASS ×7).
3. Actual in-memory B1 API: `GET /health`, unknown `GET /risk`, empty `GET /merchants`, empty `GET /stats` (PASS).
4. `POST /evidence`, `/report`, `/spend`: rejected malformed atomic / mock receipt / txHash / blocked-spend values with HTTP 400 (PASS).
5. Five synthetic decoy evidence posts: honest `6/7 = 0.857142857...`, flagged 4 merchants `1/7 = 0.142857143...`, exact flag arrays and normalised URLs (PASS).
6. Replaying same request ID is idempotent; a judge-only `PROMPT_INJECTION` advisory does not change `6/7` (PASS).
7. `POST /report` receives `X-Chain-Verified:false` / `X-Payment-Proof:format-only`, weight one, no asserted on-chain verification (PASS).
8. Synthetic Guard OFF stats: spent `100000`, wasted `60000`, injections 1; Guard ON: spent `10000`, wasted `0`, blocked 4 (PASS, **only synthetic persisted data**).
9. Actual SSE: publish, parse IDs, Reset broadcast, Last-Event-ID reconnect, no duplicated events from passive stream consumption (PASS).
10. `POST /reset` cleared merchants, risk outcomes, spend and evidence in **isolated** in-memory storage (PASS).
11. SKIP ×3: live read-only Merchant/Feed, full Guard settlement instrumentation, real Base Sepolia settlement. The read-only live cases were separately executed with `--live` (10 PASS).

### B5 live read-only — verified 10 PASS / 0 FAIL / 4 SKIP

Against throwaway CI loopback services with `MOCK_FACILITATOR=1` and an address-only `MERCHANT_PAYTO`:
- Feed `/health`, `/risk`, `/stats`, `/merchants` contract validation (PASS).
- All five Merchant quotes and **unpaid** `GET /m/:id/data` return **HTTP 402**, exact scheme, `eip155:84532` and Base Sepolia USDC address (PASS).
- No x402 signature was produced, no SDK buyer invoked, no facilitator settlement was requested.
- SKIPs represent **not observed** customer metrics, in-memory B1 mutation mode (separate run), Guard settlement instrumentation, and real chain settlement.

## 3. Confirmed payment-policy FAIL (owner: A)

| Check | Actual | Expected | Severity |
| --- | --- | --- | --- |
| Guard `checkBeforeSign` with `ctx.network = eip155:8453` and good risk | returns `null` (allow) | explicit abort/reason; only `eip155:84532` allowed | **P0 FAIL** |
| Guard `checkBeforeSign` with unexpected `ctx.asset` and good risk | returns `null` (allow) | explicit abort/reason; only Base Sepolia USDC token allowed | **P0 FAIL** |

Reproduce without keys:

```sh
pnpm exec tsx --test tests/integration/guard-safety.test.ts
```

Five other Guard decision cases PASS: known risky merchant blocks, feed failure defaults **fail-closed**, unknown high-price merchant blocks, quote/payment price mismatch blocks, and advisory-only judge flag does not block.

**Required A correction (do not apply from B5):** enforce chain and asset allowlists inside the shared **before-sign** decision and the reusable x402 buyer payment-creation path, even if downstream B3 happens to precheck the Merchant's 402. The buyer currently registers a broad `eip155:*` scheme. Add negative tests for other networks/tokens, then instrument zero signatures and zero settlements on rejected attempts. The observed failures prove a missing policy check, **not** that an unintended transaction took place. [Issue #13](https://github.com/MO7YW4NG/bait/issues/13).

## 4. Module acceptance / merge decision

| Module | Integration-ready? | Actual restriction / next owner |
| --- | --- | --- |
| B0/B1/B2 | **Yes, merged** | B1 and B2 have Node 24 test evidence. Dashboard API/SSE/browser checks passed. |
| A Payment Core | **Merged but P0 security FAIL** | A must fix network and asset checks; no real settlement proof in B5. |
| B3 Customer | **Type/logic integration compatible** | B3 code remains PR #1; 28 tests + A typecheck pass, **no wallet**. B3/A must measure real/simulated OFF/ON outcome before payment E2E is accepted. |
| B4 Demo | **Blocked** | Draft PR #4, no complete orchestrator run or 90s demo payment evidence verified here. |
| B5 QA | **Keep Draft PR #6** | Stage-2 test suite works; 2 security FAILs must not be disguised. No production code modified. |

Highest 90-second demo risks, ordered:
1. **A (P0):** guard could approve unsupported chain/token before signing. Fix and rerun wallet-free tests before any funded demonstration.
2. **B3 + A (P0):** buyer/guard integration has only type/adapter proof; no observed double-charge, signed vs blocked counts, or real chain/mock trace from actual scripted run.
3. **B4 (P0):** demo orchestration and the dashboard must show numbers sourced from one real execution; displaying synthetic fixture targets as actual losses/savings would be misleading. Require visible mock label if mock facilitator is used.

## 5. Reproduction / safety controls

```bash
# Node 24. Non-destructive; contract and synthetic fixtures only.
pnpm exec tsx scripts/verify-integration.ts

# Explicit write authorization ONLY to random-loopback, in-memory SQLite.
pnpm exec tsx scripts/verify-integration.ts --isolated --allow-write

# GET-only; rejects non-loopback hosts. Unpaid Merchant challenge, no signing.
# First start Feed and Merchant locally with a mock facilitator, never production data.
pnpm exec tsx scripts/verify-integration.ts --live

# Guard decisions; stubs fetch, no wallet, signing or settlement.
pnpm exec tsx --test tests/integration/guard-safety.test.ts
```

Do not run the Demo `POST /reset` against a shared Feed. Do not call any simulated `0xmock...` hash on-chain evidence: mock evidence has no explorer link. `POST /report` validates only tx-hash **syntax**, not chain provenance.

**Exit gate:** Resolve both P0 Guard failures, rerun Node 24 integrated tests, then explicitly authorize and capture B3/B4 payment E2E in an isolated Base Sepolia/mock environment. Until then the **two real payment acceptance categories remain SKIP**, not PASS.
