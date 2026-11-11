# Bait — B5 final integration QA and B4 release sign-off

**Verified on 2026-11-11 (Asia/Taipei).** This report is an acceptance record, not a claim that on-chain settlement occurred.

## Source-of-truth snapshots

| Subject | Verified SHA / status |
| --- | --- |
| `main` at independent B4 QA | `5ae583e122f7efeca72bfbe5881a85da235379bd` (A security #14, A retry #15, B0/B1/B2/B3 all merged) |
| **B4 candidate** | `3a561820b3d06f66734ac4cdac8ee995d275ea69` — PR [#4](https://github.com/MO7YW4NG/bait/pull/4), **Draft, OPEN, NOT MERGED** when signed off |
| B5 QA (includes corrected post-customer reputation assertions) | `0820e4cf90b1dcd33eaa8e974390974122bf1c69` and subsequent documentation update; PR [#6](https://github.com/MO7YW4NG/bait/pull/6), **Draft, OPEN, NOT MERGED** |
| Disposable B4+B5 candidate | `345b5826e9be296a40f718815541d122d2461271` — temp PR [#16](https://github.com/MO7YW4NG/bait/pull/16), **NEVER MERGE** |
| B4's own native CI | [Actions 43029522254](https://github.com/MO7YW4NG/bait/actions/runs/43029522254) — Ubuntu/Windows success |
| B5 independent comprehensive QA | [Actions 43032669797](https://github.com/MO7YW4NG/bait/actions/runs/43032669797) — frozen lock, real module Mock E2E, independent Ctrl+C/port tests |
| Independent Chromium verification | [Browser job 130561655389](https://github.com/MO7YW4NG/bait/actions/runs/43032149923/job/130561655389) — success, same B4 SHA |

**B4 RELEASE GATE: PASS — MOCK DEMO ONLY.** Security/contract job and full Demo/repeat/interactive job passed on the B5 independent candidate; B2 real Chromium passed in an independent earlier candidate with **the same B4 HEAD and unchanged B2 files**. This does **not** certify real Base Sepolia settlement. Any later changes to B4 HEAD, B5 tests or `main` require revalidation. Formal B4 merge is reserved for the owner/integration lead.

**B5 FINAL RELEASE GATE: PENDING.** B4 PR #4 must be merged **before** final B5 synchronization, QA CI, merge, and independent final-main verification. **No B5 merge is authorized by this document while B4 is open.**

## Independent evidence types and exact results

| Evidence class | Execution | PASS | FAIL | SKIP | Grounding |
| --- | --- | ---: | ---: | ---: | --- |
| Build/reproducibility | Node.js 24, pnpm 10, `pnpm install --frozen-lockfile`, `pnpm check` | PASS | 0 | 0 | Independent CI 43032669797 security and demo |
| Guard Safety | Original B5 `guard-safety.test.ts` | **7** | **0** | 0 | Re-tested against merged A #14 |
| A P0 policy | `src/guard/paymentSafety.test.ts` | **10** | **0** | 0 | Network `eip155:84532`, specific USDC asset, fail-closed, mixed/unsafe 402, zero signatures when blocked |
| A mock settlement/retry | `src/lib/x402buyer.mock.test.ts` | **2** | **0** | 0 | One positive simulated success; 3 failed signed attempts produce **0 settlements**, fresh nonces; not on-chain proof |
| B1 backend | `src/feed/server.test.ts` | **8** | **0** | 0 | SQLite, HTTP, evidence, score, SSE replay/reset |
| B2 logic | JS syntax and `web/app.test.cjs` | **2** | **0** | 0 | Browser behavior logic |
| B2 browser | Chromium `web/integration.test.cjs` | **1** | **0** | 0 | [Actual Chromium run](https://github.com/MO7YW4NG/bait/actions/runs/43032149923/job/130561655389); actual B1 API, SSE and DOM |
| B3 unit/contracts | `customer*.test.ts`, A compatibility, preflight safety | **34** | **0** | 0 | Node24 independent CI |
| B3 HTTP E2E | `tests/b3-mock-e2e.ts` | **1 run** | **0** | 0 | Real A/B1/B3 modules; `B3_MOCK_E2E_RESULT` printed and queried from live Feed |
| B4 smoke | `src/demo.test.ts` | **8** | **0** | 0 | CLI/prerequisites, reject remote Feed before reset |
| B4 contract | `src/demo.contract.test.ts` | **3** | **0** | 0 | Actual B1+B2 contracts, separate fixture-only in-memory DB |
| B4 actual Mock E2E | `src/demo.e2e.test.ts` | **2** | **0** | 0 | Real Merchant/Decoy/Feed/Buyer/Guard/Customer/Dashboard/SSE and occupied 4030 |
| B4 direct CLI (repeatability) | `pnpm demo --once` **twice**, separate temp SQLite each run | **2 runs** | **0** | 0 | Actual measured `GET /stats` summaries and clean exits, CI 43032669797 |
| B5 independent interactive | `tests/integration/demo-release.test.ts` | **1** | **0** | 0 | Live Feed counters, both ports occupied, Ctrl+C exit 130, zero writes to external ports, zero temp DB leaks |
| B5 isolated API/integration | `verify-integration.ts --isolated --allow-write` | **16** | **0** | **3** | Real isolated B1 API/SQLite/SSE plus separately labelled synthetic fixtures |
| **Base Sepolia funded E2E** | **Not executed — no approval for payment/fees** | 0 | 0 | **1** | Wallet/facilitator/RPC/on-chain receipts intentionally unverified |

B5's three harness-level SKIPs include optional live-read-only mode and mock/payment instrumentation that are **separately** exercised by actual B3/B4 Mock E2E. They remain marked SKIP in that script's output; don't silently count them as script PASS. The **one release-level SKIP** is genuine funded Base Sepolia E2E. Individual suite counts intentionally overlap with higher-level contract scenarios; never sum duplicate scenarios to inflate coverage.

### Observed mock purchase evidence, NOT test fixtures

Source: independent B5 CI `B3_MOCK_E2E_RESULT` (real modules and persisted Feed), `src/demo.e2e.test.ts`, and B5's interactive HTTP `GET /stats`:

| Metric | Guard OFF | Guard ON |
| --- | ---: | ---: |
| Atomic spent | `100000` | `10000` |
| Display spent | **0.100000 simulated USDC** | **0.010000 simulated USDC** |
| Atomic wasted | `60000` | `0` |
| Display wasted | **0.060000 simulated USDC** | **0.000000 simulated USDC** |
| Injection exposures | **1** | **0** |
| Blocked risk merchants | **0** | **4** |
| Settled blocked merchants | n/a | **0** |

Actual B3 Mock HTTP E2E stored **10 spend rows** and **53 events**, verified SSE and all five merchants: `honest` clean; `price-switch` / `ghost` / `double` / `injector` each with exact deterministic risk rule. `double` charged twice **only in the explicitly unsafe Guard OFF demo**. For Guard ON, customer settlement events contain **only** the honest merchant, and the four risk merchants have no settlement. A Guard SDK and B3 Customer each emit some blocked *events*; event deduplication by actor/request is required to avoid presenting eight blocks as eight transactions.

**Risk scores:** after the initial weighted Decoy evidence, clean `honest` = `6/7`; four risky sellers = `1/7`. After Guard ON successfully buys from `honest` and posts a weight-one good report, `honest` becomes `7/8` (not `6/7`); four risky sellers remain `1/7`. B5's independently authored post-customer assertion was corrected for this legitimate scoring progression; **no B1/B4 source code was changed**.

Mock receipts are `0xmock...` and `simulated=true`; no BaseScan explorer URL is displayed. `POST /report` only verifies hash syntax and does **not** prove on-chain provenance.

### Port, database and process lifecycle proof

B5's independent actual interactive `pnpm demo` test occupied ports **4021 and 4030 simultaneously** with external HTTP sentinels. B4 selected dynamically allocated private ports, queried the real session-owned Feed and Dashboard, then processed `SIGINT`:

- Measured external HTTP writes: `{"4021":0,"4030":0}`; no unrelated service received `POST /reset`.
- Demo exit code **130** (Ctrl+C); demo-owned listeners no longer reachable after exit.
- New `bait-demo-*` temporary SQLite directories remaining: **0**.
- Dashboard HTML, JS/CSS and actual B1 `GET /stats` accessible while interactive session was running.
- Separate `pnpm demo --once` commands both exited successfully and produced identical *target metrics*, with fresh temporary SQLite data.

No test in this QA touched the shared `data/bait.db` or sent real funded USDC.

## Release gate and outstanding risk

| Priority | Status | Detail / action |
| --- | --- | --- |
| P0 unsafe chain or asset signing | **PASS: FIXED** | Merged A #14 policy and original B5 7/7 safety suite validated; no unsafe HTTP 402 signature |
| P0 Guard-blocked payment / forged on-chain receipt | **PASS in Mock** | No Guard ON risky merchant settlements; simulated hashes have no explorer |
| P1 full Demo, measurable OFF/ON, Dashboard/SSE | **PASS in Mock** | Actual E2E and independent test from observed `GET /stats`; two repeat `--once` runs |
| P1 reuse/Reset shared services, orphan processes | **PASS in Mock** | Both default ports occupied, no external writes, Ctrl+C owned-process cleanup |
| P2 test-runner efficiency | **OPEN, non-blocking** | B4 `src/demo.e2e.test.ts` has a `Promise.race` 120-second timer that remains active after the success branch; CI test harness takes longer to exit than the working `pnpm demo --once` itself. Owner B4 may tidy later. |
| **Real chain payment** | **SKIP, out of Mock release scope** | Requires explicit wallet/fee authorization, Base Sepolia RPC/facilitator verification and independent chain receipts |

**B4 RELEASE GATE: PASS** for **90-second hackathon MOCK presentation**; there is no currently evidenced unresolved P0/P1 *within the Mock demonstration scope*. **Never use this sign-off as production payment readiness or genuine Base Sepolia E2E certification.**

**B4 merge:** not performed by B5 QA. PR #4 owner/integrator must merge, then B5 must synchronize newest main and rerun all release checks **on the merged branch**. B5 PR #6 must stay Draft until that occurs.

## Required post-B4 procedure (not yet performed)

1. Confirm GitHub PR #4 `merged=true` and record its actual merge SHA. Do not infer from closed state.
2. Update `feat/b5-integration-qa` from that exact latest main by normal non-forced merge; do not edit other teams' files.
3. Repeat frozen pnpm install, `pnpm check`, B5 7/7 Guard, A tests, B1/B2/B3, B5 16/0/3, real Mock E2E and `pnpm demo --once` twice.
4. Require GitHub CI green and zero uncorrected P0/P1, then mark PR #6 Ready and merge with expected-head safety.
5. Record B5 GitHub merge SHA and run the same QA against formal `main`.
6. Real Base Sepolia funded E2E remains **SKIP** until explicit user authorization.

**Video-readiness:** candidate B4 Mock Demo is ready for recording a 90-second judge video from its feature branch. **Formal submission from `main` remains blocked until the authorized B4 merge, B5 post-merge validation/merge and final-main smoke.**
