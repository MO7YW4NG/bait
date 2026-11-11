# Bait — 90-second Mock Demo recording runbook

**Verified scope (2026-11-11):** Actual A Merchant/Decoy/Guard, B1 Risk Feed, B2 Dashboard and B3 Customer completed a **real-module Mock x402 E2E** in Node 24 on Windows and Ubuntu. Evidence: [B4 CI run 43027668695](https://github.com/MO7YW4NG/bait/actions/runs/43027668695). The facilitator produced **simulated settlements, not on-chain transactions**. No final video has been recorded or delivered.

## Recording setup

1. Run `pnpm install` and then `pnpm demo --pause 5`. Mock mode uses disposable in-memory wallet keys, a local chain-ID-only stub and a fresh, isolated SQLite database; no funded wallet or `.env` is required.
2. Open the **Dashboard URL printed by the terminal**. The default is port 4030, but B4 uses another local port when 4030 is occupied.
3. Arrange **Terminal** on the left and **Dashboard** on the right. For the pre-sign explanation, have `src/guard/guardedFetch.ts` open in a code editor.
4. Capture the Decoy and both Customer runs. Leave the command running at `DEMO_COMPLETE` to preserve the live dashboard; Ctrl+C stops B4-owned child processes and deletes the temporary DB.
5. Confirm this recording's actual `GET /stats` values and all merchant verdicts. Do not copy previous test values if this run differs.
6. Overlay clearly: **MOCK FACILITATOR · SIMULATED SETTLEMENT · NOT ON-CHAIN**. Do not show mock hashes as explorer-verified transactions.

## CI-verified observed sample

These values were read by `src/demo.e2e.test.ts` from the **running** B1 server during a full A/B1/B2/B3/B4 mock execution. They were not written into the feed as artificial statistics.

| Observable | Measured Mock result |
| --- | --- |
| Five controlled sellers | `honest` = ok; `price-switch` / `ghost` / `double` / `injector` = risky |
| Guard OFF | spent **0.100000**, wasted **0.060000** simulated USDC, one injection |
| Guard ON | spent **0.010000**, wasted **0.000000** simulated USDC, **4 blocks** |
| Receipts | `0xmock…` with `simulated=true`; **no Basescan links** |
| SSE | Real `payment_settled` and `guard_blocked` events; A and B3 both emit for a block, so deduplicate by customer decision |

Source: [Windows/Ubuntu Mock E2E run 43027668695](https://github.com/MO7YW4NG/bait/actions/runs/43027668695). These are outcomes of five **team-controlled test merchants**, not independent real-world fraud rates.

## Exact screen switches

| Time | Screen | Action |
| --- | --- | --- |
| **0–20 s** | Bait title → README Mermaid architecture | Problem, risk intelligence and check-before-sign positioning |
| **20–40 s** | Terminal Decoy output → Dashboard merchant list | Five merchants; one clean, four rule-backed risky cases |
| **40–65 s** | Guard OFF/ON terminal results beside dashboard comparison | Highlight measured **0.060000 vs 0.000000 simulated USDC waste**, **4 blocked** |
| **65–80 s** | Dashboard SSE event list + mock payment evidence | Show `guard_blocked` and `payment_settled`, SIMULATED label and no fake chain link; optionally briefly show the actual pre-sign callback |
| **80–90 s** | Full-screen dashboard + closing tagline | Reusable pre-sign risk signal and scope disclaimer |

Record one actual live workflow, then edit out idle time. Never substitute synthetic fixtures for real execution footage.

## English narration

**0–20 seconds**

> “AI agents increasingly pay APIs on behalf of users. A changed quote or duplicate purchase can become an irreversible loss. Bait gives agents risk intelligence about sellers before the payment signature is created.”

**20–40 seconds**

> “Our decoy buys from five controlled test merchants. One delivers correctly. Four demonstrate a price switch, missing delivery, repeat charges, and prompt injection. We record observable evidence for each and update a shared risk feed.”

**40–65 seconds**

> “Now the same scripted customer runs twice. Without the guard, this mock run records zero point zero six simulated USDC wasted. With Bait enabled, wasted spend is zero and four risky purchases are blocked. These figures come directly from the feed.”

**65–80 seconds**

> “The dashboard updates from real server-sent events. Each risk flag has test evidence, and mock settlements are explicitly marked simulated, not on-chain. The guard acts before signing.”

**80–90 seconds**

> “Bait turns decoy evidence into reusable payment protection for other agents. Bait gets scammed first, so your agent doesn't.”

## Submission checklist

- [x] Mock E2E observed values and SSE from actual modules verified in [CI](https://github.com/MO7YW4NG/bait/actions/runs/43027668695)
- [ ] Record a new run and verify its visible `GET /stats` matches the spoken values
- [ ] Label every mock settlement **SIMULATED · NOT ON-CHAIN**
- [ ] Keep secrets, private keys and credentials completely off camera
- [ ] Confirm four *customer decisions* blocked, not eight duplicate actor event messages
- [ ] Export a readable 90-second video and upload the submission link

**Not claimed:** Real Base Sepolia payment settlement, third-party merchant fraud, independent B5 release certification or an already-rendered final video.
