# B0 frozen API contract (A + B)

Authoritative TypeScript types: [src/lib/contracts.ts](../src/lib/contracts.ts). Source: [plan.md](../plan.md) §§4.1–4.8 and [TEAM_SPLIT.md](../TEAM_SPLIT.md) §3. Do not create parallel conflicting DTOs. NodeNext ESM TypeScript imports use a .js extension: `import type { RiskResponse } from '../lib/contracts.js'`.

## Money, IDs and timestamps

- Base Sepolia only: `eip155:84532`; USDC has 6 decimals. Every HTTP payment amount (`quotedAtomic`, `requiredAtomic`, `amountAtomic`, `spentAtomic`, `wastedAtomic`, `quoted`, `charged`) is a non-negative integer **string** in USDC atomic units. Convert with `toAtomicString(bigint)` / `parseAtomicString(string)`; never compute using `Number` or `parseFloat`. JSON cannot serialize bigint directly.
- Compatibility exception dictated by plan.md: merchant quote `priceUsdc` is a human-readable decimal **string** (e.g. `"0.010"`), never a number. Convert using `quoteToAtomic` before comparing. Optional `priceAtomic` is already an atomic-unit string.
- `runId` identifies the demo run. `requestId` must stay the same across retries, including the two purchases from `double`.
- Mock receipts (`0xmock...`) must always be identified as simulated and have no explorer URL. Base Sepolia real tx explorer: `https://sepolia.basescan.org/tx/<hash>`.
- Event/evidence `ts` is Unix epoch **milliseconds**. `score` 0–1 is a numeric metric, **not** money.

## A: merchant service :4021

| Route | Request | Response |
| --- | --- | --- |
| `GET /merchants` | — | `Merchant[]` = `[{id,name,quoteUrl,dataUrl}]` |
| `GET /m/:id/quote` | `id` | `MerchantQuote {merchantId,product,priceUsdc,description,priceAtomic?}` |
| `GET /m/:id/data` | x402 v2 HTTP 402 handshake, `PAYMENT-SIGNATURE` and `X-Request-Id` | Weather data; dishonest test merchants intentionally return anomalies |
| `GET /health` | — | HTTP 200 |

## B1: feed service :4030

| Endpoint | Request | Response / semantics |
| --- | --- | --- |
| `POST /evidence` | `EvidencePostRequest {transaction,flags:RiskFlagInput[]}` | `{ok:true,id?}`; one evidence per flag, exactly **one** outcome even with empty flags; rule weight 5; judge-only flags never affect score |
| `GET /risk?url=...` | `url`, normalized `origin+pathname` | `RiskResponse {merchantId,score,verdict,flags,evidence}`; unseen URL returns `unknown` with `merchantId:null`, not 404 |
| `POST /report` | `{url,outcome:'good'|'bad',txHash}` | `{ok:true,id?}`; verify txHash format, HTTP 400 if absent or malformed; weight 1 |
| `POST /spend` | `CustomerSpendRecord` | `{ok:true,id?}`; one row per merchant attempt, including blocked (zero spend) |
| `POST /events` | `FeedEventInput {actor,type,payload,ts?}` | `{ok:true,id?}`; persist and broadcast |
| `GET /events` | — | `text/event-stream`: JSON `FeedEvent`, last 50 on connect, keepalive every 15 s |
| `GET /merchants` | — | `MerchantRiskSummary[]`; NOT the :4021 merchant discovery array |
| `GET /stats` | — | `DemoStats {off:{spent,wasted,injections},on:{spent,wasted,blocked}}`; spent/wasted atomic strings, latest run **per guard mode** |
| `POST /reset` | — | `{ok:true}`; clear state + broadcast reset |
| `GET /health` | — | HTTP 200 |

Flags: `PRICE_CHANGE`, `NON_DELIVERY`, `DOUBLE_CHARGE`, `PROMPT_INJECTION`. Source is `rule` or `judge`, and the judge is advisory only. Scores: `(1 + G) / (2 + G + B)`, where weighted clean/bad outcomes are G/B. One decoy good = 6/7, one decoy bad = 1/7; threshold `GUARD_MIN_SCORE` defaults to 0.6. Unknown when no outcomes.

## B1–B4 required integration discipline

- **B1 Feed + DB:** reuse `FeedApi`, `EvidencePostRequest`, `RiskResponse`, `MerchantRiskSummary`, `FeedEvent`, `CustomerSpendRecord` and `DemoStats`. Only feed opens `data/bait.db`; store atomic strings in TEXT, calculate with bigint. A string flag is implicitly source `rule`. Judge-only flags never lower a score.
- **B2 Dashboard:** fetch feed `GET /merchants` and `GET /stats`; subscribe to `GET /events` SSE and parse `FeedEvent`. Display atomic amounts as 6-decimal USDC and distinguish mock/simulated receipts from real testnet hashes.
- **B3 Customer:** discover from **merchant** `GET /merchants`, fetch `MerchantQuote`, convert `priceUsdc` using `quoteToAtomic` (or trust provided `priceAtomic`); reuse A's x402 buyer and guard. Keep a stable merchant request ID per run; POST typed events and one `CustomerSpendRecord` per merchant attempt. `loadEnv('customer-scripted')` needs no GMI API key; `customer-llm` requires the key and model.
- **B4 Demo:** `pnpm demo` will launch `src/demo.ts`, start servers via `process.execPath` on Windows (no bash), reset then run decoy, customer OFF, customer ON. Separate attempts with run IDs and label mock settlements accurately.

## Environment and implementation status

Use `loadEnv('feed'|'merchants'|'decoy'|'customer-scripted'|'customer-llm'|'guard'|'judge'|'preflight'|'demo'|'stripe')` at module entrypoints. Importing `env.ts` has no mandatory secret validation. Feed never needs private keys, and Stripe scope rejects production keys. `.gitignore` already protects `.env` and database files.

B0 includes scaffolding **only**; the scripts target future B1/A/B3/B4 entrypoints: `src/feed/server.ts`, `src/merchants/server.ts`, `src/agents/decoy.ts`, `src/agents/customer.ts`, `src/preflight.ts` and `src/demo.ts`. Those scripts cannot run yet and B0 does **not** claim the demo works. `pnpm check` checks the TypeScript source currently present. `dev` aliases `dev:feed`.
