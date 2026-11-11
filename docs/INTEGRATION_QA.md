# B5 Integration QA — Bait

> Status: **PARTIAL / NOT RELEASE-CERTIFIED**. Snapshot: 2026-11-11, based on `main` at `35881dfd240101d34cf6594d655fb4eb7a716eae`. This report distinguishes synthetic acceptance expectations from measured payments. A SKIP is **never** counted as PASS.

## Repository state and module ownership

| Workstream | Observed state at B5 branch creation | Required integration gate |
| --- | --- | --- |
| B0 / shared contracts | Merged into `main` via PR #2 | Contract exports and TypeScript environment available |
| B1 / Feed, SQLite, Risk | `feat/b1-risk-feed` exists, **not on main** | Ephemeral in-memory API tests, risk scoring, dedupe, advisory, SSE |
| B2 / Dashboard | PR #3 open | Actual browser UI updates from Feed and marks mock receipts |
| B3 / Customer | PR #1 open, draft | Actual scripted OFF/ON records and pre-sign Guard behavior |
| B4 / Demo | PR #4 open, draft | One-command runner, healthy services, accurate observed counters |
| A / payments, Decoy, Guard | No corresponding branch in initial branch listing | HTTP 402, guard pre-sign blocking, fail-closed, settlement proof |
| B5 / Integration QA | `feat/b5-integration-qa` | Contract/fixture verifier delivered; integrated gates pending |

Only B5-owned files are changed. Do not merge an incomplete B5 report as a claim that the demo works.

## Running verification

Node.js **24**, pnpm 10 and the repository's existing `tsx` dependency are required. Run these from the repo root.

```sh
pnpm exec tsx scripts/verify-integration.ts
pnpm exec tsx scripts/verify-integration.ts --isolated --allow-write
pnpm exec tsx scripts/verify-integration.ts --live
pnpm exec tsx scripts/verify-integration.ts --live --expect-demo
```

- **Default**: no network, no database writes, no wallet access. Runs contract fixtures and reports all unavailable gates as SKIP.
- **`--isolated --allow-write`**: explicit authorization for synthetic writes and `POST /reset`. Loads B1's exported `createFeedApp` only if the module exists; starts a random **127.0.0.1** port with `dbPath: ':memory:'`; closes connections and database. Never touches `data/bait.db`, deployed Feed or any wallet. On B0-only `main`, it correctly SKIPs B1 tests.
- **`--live`**: GET-only checks to running Feed/Merchant loopback services. The unpaid merchant GET requests expect 402 and **never sign**. External hosts, authenticated URLs and HTTPS hosts are rejected. No POST, reset, SQLite write or payment.
- **`--live --expect-demo`**: additionally compares **observed** `GET /stats` with scripted acceptance targets; a matching number is not chain evidence.
- Never set `--isolated` without `--allow-write`, or vice versa. Unsupported flags fail. No B5 option authorizes actual testnet payment.

## Latest executed test evidence (local only)

Environment used for this preliminary run: **Node.js v22.16.0** with experimental TypeScript stripping and a local copy of B0 contract runtime helpers. This is **not** a Node 24 certification, not a `pnpm exec tsx` run, and not an integrated B1/A checkout.

| Check | Result | Evidence / limitation |
| --- | --- | --- |
| USDC atomic `bigint` conversion and malformed string rejection | PASS | Local fixture execution |
| Mock settlement classification, invalid network rejection | PASS | Local fixture execution |
| Risk response shape, epoch-ms timestamps and mock explorer links | PASS | Local fixture execution |
| Event type and epoch-ms validation | PASS | Local fixture execution |
| Origin + pathname normalization, credentials rejection | PASS | Local fixture execution |
| 6/7, 1/7 score expectations and 5 decoy fixtures | PASS | **Expectation math/fixtures only**, not B1 engine result |
| Synthetic OFF/ON accounting targets | PASS | **Fixture aggregation only**, not observed payment amounts |
| Node 24 requirement | SKIP | Runner available only on local Node 22 for this run |
| B1 API, risk score, advisory, reset, SSE, customer DB writes | SKIP | B1 implementation not merged into checked-out `main`; writing tests require opt-in |
| Live Feed/Merchant, x402 402 and challenge network | SKIP | No running loopback services in this environment |
| A Guard pre-sign, fail-closed and no settlement when blocked | SKIP | A-owned code and instrumented payer not available |
| Actual Base Sepolia settlement | SKIP | No wallet/network payment is executed |

**Overall preliminary run: PASS 7 / FAIL 0 / SKIP 5 (12 reporting entries).** The combined count is for the default run only. `--isolated` and `--live` have **not** been executed against installed B1/A services. A zero FAIL count is **not** a release pass.

The runnable isolated harness additionally asserts exact HTTP 200/400 responses, URL canonicalization, score tolerance of `1e-8`, mock evidence, rule-vs-judge scoring, requestId deduplication, `POST /reset` effects, SSE event ID consistency, reconnect cursor and no feedback-loop event insertion.

## Acceptance targets (synthetic, NOT actual trading data)

| Scripted mode | Spent atomic | Wasted atomic | Other |
| --- | ---: | ---: | --- |
| Guard OFF | `100000` (0.100 USDC) | `60000` (0.060 USDC) | injections = 1 |
| Guard ON | `10000` (0.010 USDC) | `0` (0.000 USDC) | blocked = 4 |

Good Decoy: `(1+5)/(2+5) = 0.857142857...`. Bad Decoy: `1/(2+5) = 0.142857143...`. Unknown merchant should return `verdict: unknown`, `merchantId: null`. AI judge flags are advisory; they must not change an otherwise good score. All money fields on the wire are integer decimal **strings** of atomic USDC. Timestamp units are Unix **milliseconds**.

## Payment safety boundaries

B5 **never** signs a wallet request, calls a facilitator, uses a private key, performs a testnet settlement, or reads secrets. It checks public 402 terms on live loopback services without authorizing payment. Blocked-without-settlement, feed outage fail-closed, pre-sign hook placement, secret leakage and on-chain receipts **remain unverified** until A's modules and an explicitly authorized, instrumented testnet runner are available. Simulated receipts such as `0xmock...` must be visibly labelled and have **no** explorer link. Only `eip155:84532` (Base Sepolia) is allowed.

## Critical Demo blockers and recommended owners

1. **P0 — A payment chain missing:** No verified Merchant HTTP 402 → x402 buyer settlement → Decoy rules → Guard pre-sign rejection exists on `main`. **Owner: A**. Merge a minimal mocked Base Sepolia vertical slice first; instrument that zero signatures/settlements happen for Guard-blocked calls. Never silently allow when Feed is unreachable.
2. **P0 — B1 risk storage/SSE not integrated on `main`:** The customer and dashboard cannot share trustworthy data or observed counters. **Owner: B1**, coordinated with **B2**. Merge B1, run `--isolated --allow-write`, fix any FAIL before treating UI as evidence; verify SSE resets/reconnects are stable.
3. **P0 — Demo orchestration and accounting depend on missing A/B1:** A green Dashboard alone cannot demonstrate 0.060→0.000 USDC avoided. **Owners: B3 + B4**, with **B2** for labeling. Run `pnpm demo` on the integrated checkout, collect actual `/stats` response, show mock versus on-chain mode clearly, then record the 90-second demo.

Additional risks: The B1 `POST /report` interface validates the tx hash **format only**, not an on-chain transfer. It must not be described as cryptographic proof. GMI judge and tool-calling customer are optional; prioritize reproducible scripted P0 first.

## Gate to mark B5 complete

On a Node 24 checkout containing merged B1, B2, B3, B4 and A:
- Run `pnpm check` plus B5 default and isolated tests; publish actual PASS/FAIL/SKIP.
- Start loopback services and run `--live`; ensure the five unpaid paid endpoints return 402 for Base Sepolia.
- Execute the authorized scripted demo with clearly marked test/mock rail; run `--live --expect-demo` against its *observed* state, document mismatches.
- Independently inspect Guard abort-before-sign and fail-closed behavior; use instrumented wallet/facilitator and testnet approval before any real settlement test.
- Mark B5 fully PASS only if no required P0 test is FAIL **or SKIP**, and real versus mock receipts remain unambiguous.
