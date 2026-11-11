# Bait — Two-Person Hackathon Execution Plan

> **Goal:** Ship a credible 90-second demo of an AI-agent payment guard, not a broad platform.
>
> Event: c0mpiled-18, Taipei — 2026-11-11. Original coding window: 18:30–22:30 (Asia/Taipei).  
> Source of truth for product behavior: [plan.md](./plan.md). This file defines **ownership, integration boundaries, deadlines, and fallbacks** for a two-person team.

## 1. Ownership at a glance

| Owner | Workstream | Owns | Definition of done |
| --- | --- | --- | --- |
| **A — Payment & Detection Core** | Merchant zoo, x402 buyer, decoy, deterministic detector, pre-sign guard | `src/merchants/server.ts`, `src/lib/x402buyer.ts`, `src/lib/mockFacilitator.ts`, `src/agents/decoy.ts`, `src/detector/rules.ts`, `src/guard/guardedFetch.ts` | Paid calls work; the five merchants produce the expected flags; risky payments are blocked **before signature** |
| **B — Risk Platform & Demo** | Feed API, SQLite, dashboard, customer agent, orchestrated demo, video | `src/lib/db.ts`, `src/lib/feedClient.ts`, `src/feed/server.ts`, `src/agents/customer.ts`, `src/demo.ts`, `web/`, `README.md` | Feed records evidence, dashboard updates live, scripted guard OFF/ON runs complete, 90-second video is recorded |

### Shared setup (first 10 minutes only)

- Agree on the HTTP API contracts below **before** implementing them.
- **B** owns the shared repository scaffold, `package.json`, `tsconfig.json`, `.env.example`, and `src/lib/env.ts`.
- **A** owns x402 network configuration and wallet / facilitator smoke tests.
- **B** owns `src/lib/gmi.ts` and `src/detector/judge.ts` **only after P0 passes**.
- One person should own each shared file; coordinate changes in chat to avoid overwriting each other's commits.
- Use separate feature branches (`feat/payment-core`, `feat/risk-demo`) and merge once each acceptance gate passes, or coordinate small direct commits to `main`. **Do not rewrite the other person's work.**

## 2. Parallel build: the smallest reliable vertical slice

### A — Payment & Detection Core

1. Create five deterministic test merchants on `:4021`: `honest`, `price-switch`, `ghost`, `double`, `injector`.
2. Implement x402 v2 `exact` payments on **Base Sepolia only**, with a mock-facilitator fallback available from the start.
3. Implement `decoy.ts`: fetch quote → pay → inspect response → retry once with same request ID when instructed → send evidence to the feed.
4. Implement **deterministic** flags: `PRICE_CHANGE`, `NON_DELIVERY`, `DOUBLE_CHARGE`, `PROMPT_INJECTION`.
5. Implement `guardedFetch.ts`: consult the feed and verify quoted vs payment-required amount in the `onBeforePaymentCreation` hook; abort before signing if risky, overpriced, above cap, or feed unavailable (fail closed).

**Acceptance:** `honest` has no flags; each other merchant has exactly its designated flag. For the guard-on path, no signature or settlement is created for the four flagged merchants.

### B — Risk Platform & Demo

1. Build feed server on `:4030` with `node:sqlite`; the feed server must be the **only DB owner**.
2. Implement `/evidence`, `/risk`, `/report`, `/spend`, `/events`, `/merchants`, `/stats`, `/reset`, and `/health` from `plan.md`.
3. Build the live dashboard: merchant verdicts, observed flags, payment evidence links, blocked count, wasted USDC before/after. Use SSE for event updates.
4. Build `customer.ts` with `--guard off|on --scripted` first. Integrate with A's buyer / guard modules through their documented interfaces.
5. Implement `pnpm demo` to reset, run decoy, run guard OFF, and run guard ON. Draft README and produce the 90-second walkthrough.
6. Add GMI model-driven customer and AI judge **only if the core scripted demo is already recorded**.

**Acceptance:** one demo command shows the decoy findings, the before/after payment comparison, and a live dashboard with evidence.

## 3. API/interface contract: freeze before parallel coding

A and B must jointly agree on these minimal payloads; `plan.md` has the full schema.

| Endpoint / interface | Producer → Consumer | Required behavior |
| --- | --- | --- |
| `GET /merchants` on `:4021` | A → A/B | `[{ id, name, quoteUrl, dataUrl }]` |
| `GET /m/:id/quote` | A → A/B | `{ merchantId, product, priceUsdc, description }` |
| `POST /evidence` on `:4030` | A → B | `{ transaction, flags }`; write one outcome even if flags are empty |
| `GET /risk?url=<dataUrl>` | B → A | `{ merchantId, score, verdict, flags, evidence }`; unknown merchants return `unknown`, not 404 |
| `POST /spend` | B customer → B feed | Record each attempted purchase, its guard mode, spend, waste, and block status |
| `POST /events` + `GET /events` | A/B → B dashboard | Event stream for live log, including settlement and block events |
| `GET /stats` and `GET /merchants` | B → dashboard | Read latest guard-off/on runs and merchant verdicts |
| `createBuyer({ beforeSign })` | A → B customer | Returns typed payment result; aborts must be nonfatal and distinguishable |
| `guardedFetch(url, opts)` | A → B customer | Returns `allowed`, `reason`, and optional payment result |

**Contract rule:** money is represented as **USDC atomic-unit strings / `bigint`**, not floating-point arithmetic. Every paid attempt carries a stable `requestId`. Every demo run has an identifiable `runId`.

**Integration check (early):** A posts a synthetic valid evidence payload and event → B's feed stores and broadcasts it → B's dashboard updates → A queries `GET /risk` and reads the expected verdict. Do this **before** integrating real payments.

## 4. Milestones and working schedule

> These are targets based on the earlier 19:10–22:30 discussion, **not a claim about the current time**. If already late, skip ahead to the next acceptance gate and reduce scope; the submission deadline takes priority.

| Target | A — Payment Core | B — Platform & Demo | Gate |
| --- | --- | --- | --- |
| **19:10–19:20** | Lock buyer/payment and evidence types | Scaffold and lock feed endpoints | Both can build independently |
| **19:20–20:10** | Merchant zoo + x402 buyer + mock fallback | Feed + DB + dashboard skeleton | End-to-end HTTP smoke test by **20:10** |
| **20:10–20:50** | Decoy + exact detection rules | Scripted customer OFF/ON | Four flags, one clean merchant |
| **20:50–21:15** | Guard pre-sign hook | Stats + before/after dashboard | Guard ON blocks four risky merchants |
| **21:15–21:40** | Repair payment/integration issues | `pnpm demo`, README and narration | One full deterministic run works |
| **21:40–22:10** | Verify transactions and guard hook | Record 90-second video; push deliverables | Public repo + video available |
| **22:10–22:30** | Critical fixes only | Critical fixes only | Final submission check |

**At 21:00:** if behind, drop the GMI LLM customer and judge. **At 21:40:** stop adding features and record whichever functioning end-to-end path exists.

## 5. Priorities

**P0 — Required for the demo**

- Five test merchants with one honest outcome and four observable risk cases.
- Decoy payment/observation, deterministic detector, risk feed and evidence.
- Guard operating **before payment signing**; customer scripted ON/OFF comparison.
- Visible dashboard and reproducible 90-second demo.

**P1 — Only after P0 is stable**

- GMI-powered tool-calling customer agent.
- GMI advisory judge (must **not** alter deterministic merchant scores).

**P2 — Defer from this hackathon**

- Stripe card rail, live real-merchant probing, production deployment, tokens, billing, multi-tenancy.

## 6. Demo acceptance checklist

- [ ] `pnpm check` passes.
- [ ] Both services pass `GET /health`.
- [ ] Merchant paid endpoints return HTTP 402 before payment.
- [ ] Decoy produces exactly: honest → `[]`, price-switch → `[PRICE_CHANGE]`, ghost → `[NON_DELIVERY]`, double → `[DOUBLE_CHARGE]`, injector → `[PROMPT_INJECTION]`.
- [ ] Risk feed shows honest `ok` and four `risky` merchants.
- [ ] Scripted guard OFF: **expected** wasted = 0.060 testnet USDC, injections = 1.
- [ ] Scripted guard ON: **expected** wasted = 0.000 testnet USDC, blocked = 4.
- [ ] At least one real testnet settlement links to Base Sepolia explorer, **or** mock settlement is clearly labeled `simulated`.
- [ ] `pnpm demo` can run the whole story without manual editing.
- [ ] README, public repository, and 90-second video are ready.

The numbers above are **acceptance targets for the specified scripted scenario**, not measured results until a run passes. If using `MOCK_FACILITATOR=1`, never claim that mock settlements are on-chain transactions.

## 7. Coordination and emergency fallback

- **Check-in every 20 minutes:** each person states one completed check, one blocker, and the next integration action. Keep updates short.
- **Do not wait until the end to merge.** Prefer a working vertical slice over feature completeness.
- If x402 public facilitator is slow: use the included `MOCK_FACILITATOR=1` fallback, mark simulated evidence unmistakably, keep the pre-sign guard flow.
- If GMI inference is slow/unavailable: run `--scripted` and deterministic rules only.
- If the dashboard is late: prioritize feed API and a minimal stats/event display over styling.
- If the integration fails near the deadline: record the last verified working flow, explain limitations, and avoid fabricating successful transactions.

### 90-second pitch structure

1. **0–25s:** problem — autonomous agents can lose money paying untrusted sellers.
2. **25–45s:** decoy buys first, gathers payment evidence, flags four distinct behaviors.
3. **45–70s:** guard OFF vs ON — compare **measured** wasted spend and blocks.
4. **70–80s:** show the pre-sign hook in `guardedFetch.ts`.
5. **80–90s:** “Bait gets scammed first, so your agent doesn't.”

**Single success criterion:** the viewer can see that Bait detected risky payment behavior and demonstrably prevented a subsequent agent payment **before signing**, with evidence they can inspect.
