# Bait — 90-second demo recording runbook

**Status:** Storyboard and narration only. **No end-to-end video or actual payments have been recorded by B4.** All figures below marked `[OBSERVED]` must be replaced after a successful integrated run. Target numbers in `plan.md` are not presentation evidence.

## Before recording

Use one terminal, one browser window, and one code editor. Set browser zoom so the merchant table, metrics, event stream and the simulated/real settlement provenance are readable. Arrange windows so transitions are one shortcut rather than a mouse hunt.

1. **Browser tab 1:** `http://localhost:4030` (Risk Dashboard; available only when B1/B2 are running).
2. **Browser tab 2:** `https://agentmoneybench.com/` with the self-reported result and date visible.
3. **Editor tab:** `src/guard/guardedFetch.ts` focused on the **actual implemented** pre-sign callback.
4. **Terminal:** repository root, with no secrets visible. Run `pnpm preflight` first and do not record sensitive output.
5. **Start:** `pnpm demo --pause 5`. Record a complete successful run. If the runtime exceeds the 90-second edit, trim dead time, **never splice in invented events**.
6. Determine `MOCK_FACILITATOR` from the actual run. If `1`, overlay **SIMULATED SETTLEMENT — NOT ON-CHAIN** during any payment evidence shot; do not click fake Basescan links. If `0`, only show a Basescan link for a receipt verified in the explorer.
7. Write down, from the **actual feed response** `GET /stats` and dashboard, `[OFF_SPENT]`, `[OFF_WASTED]`, `[ON_SPENT]`, `[ON_WASTED]`, `[BLOCKED]`, `[INJECTIONS]`, plus the actual merchant verdicts and flags. Do not use the target values merely because they appear in the spec.
8. Confirm that the Guard ON trace demonstrates **no signing or settlement on blocked attempts**. A dashboard's blocked count alone does not prove the hook stage. Open the exact A implementation and/or actual logs.

## Timeline: exact screen switching

| Timestamp | Screen / switch | Evidence to capture |
| --- | --- | --- |
| **0–10 s** | Title in browser or editor: “Bait — Risk intelligence for agent payments”; show BlockRun research source in a small citation | Source is BlockRun's benchmark (vendor-reported, Solana, not x402) |
| **10–25 s** | Switch to README architecture Mermaid; highlight Decoy → Detector → Feed → Guard | Explain payment-time checks; avoid unsupported success claims |
| **25–45 s** | Switch to Dashboard, then terminal Decoy output; briefly return to Dashboard merchant list | The five **observed** merchant entries; flag labels; settlement provenance |
| **45–57 s** | Terminal and Dashboard: Guard OFF portion | Actual OFF waste/expenses and injection status |
| **57–70 s** | Same terminal/Dashboard: Guard ON portion | Actual blocks and ON waste; compare on-screen values from the same feed |
| **70–80 s** | Switch to editor: `src/guard/guardedFetch.ts` | Real implementation of `onBeforePaymentCreation`; show where abort occurs, not a pseudocode slide |
| **80–90 s** | Dashboard conclusion, overlay tagline | Actual observed result with simulated/testnet label |

Recommended editing: record the terminal + dashboard side by side and crop/highlight rather than rearranging windows during payment runs. Hotkeys can be native OS window switchers. Prepare screen positions before live execution.

## Concise English narration (conditional on what actually works)

**0–25 seconds (problem)**

> “Agents are starting to pay for APIs automatically. BlockRun's own benchmark reported that seven of ten tested models paid a cheating seller at least once. That benchmark used Solana, not our payment protocol. On irreversible rails, protection has to run before the agent signs.”

**25–45 seconds (decoy)**

> “Bait sends a capped decoy to five controlled test merchants. We inspect the quote, settlement and returned data. The feed records price changes, missing delivery, repeat charges and prompt injection. These are observed test cases, not accusations against real sellers.”

**45–70 seconds (Guard OFF versus ON)**

> “Here's the same scripted customer without a guard. The feed records [OBSERVED OFF WASTE] testnet USDC wasted. Now with the guard on, it records [OBSERVED ON WASTE] wasted and [OBSERVED BLOCKS] blocked attempts. These numbers come from this run, not from a slide.”

**70–80 seconds (hook)**

> “The risk check runs in the x402 pre-sign hook. A risky seller or unexpected price is rejected before a signature is created.”

**80–90 seconds (positioning)**

> “Bait turns decoy payment evidence into a reusable risk signal for agents. Bait gets scammed first, so your agent doesn't.”

The voice-over above is a **draft**, not a factual claim of achieved results. If results were not obtained or no hook abort was demonstrated, do **not** speak the conditional result lines; instead show the working subset, state its limits, and avoid declaring the demo passed. If the run uses mock mode, change “testnet USDC” to “simulated USDC settlement values” on screen and in narration.

## Final evidence checklist

- [ ] Real `pnpm demo` run captured with exit/health outcomes and no hidden errors.
- [ ] Five merchant flags match live feed state; one clean seller is visible.
- [ ] Both ON/OFF counters match `GET /stats` exactly.
- [ ] Guard ON refused before payment signature, not after settlement.
- [ ] Real Base Sepolia receipts are verified, **or** mock settlement is labeled unmistakably.
- [ ] BlockRun results attributed as vendor-reported external background, not Bait data.
- [ ] Secret keys, API keys and wallet mnemonics never appear on screen.
- [ ] Exported video is 90 seconds or less, with readable numbers and a source citation.
- [ ] If any item fails, revise voice-over to the demonstrated subset.

Source for intended **targets** and timing: [plan.md](../plan.md) and [TEAM_SPLIT.md](../TEAM_SPLIT.md). Actual recorded output must be used for all claims about Bait's performance.
