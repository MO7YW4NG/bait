# Bait — 90 秒 Demo 腳本

> c0mpiled-18 YC Startup School Hackathon · Taipei · 2026-11-11
> 旁白英文，約 220 字 ≈ 每分鐘 145 字。畫面 = 黑底大字卡 + dashboard (`http://localhost:4030`) + 一個終端機 + 編輯器。

---

## 完整腳本

### Part 1 — 痛點與數據（0–40s）

| 時間 | 畫面 | 旁白 |
|---|---|---|
| **0–8s** | 黑底大字：**"Agents will buy things."** | "We believe agent commerce is the future. Agents with wallets, paying APIs and other agents for data and services, with no human in the loop." |
| **8–14s** | 大字：**"So will scammers."** | "And wherever money moves without a human watching, scammers follow." |
| **14–30s** | 數據卡，三行依序淡入：<br>**10 frontier models · real USDC**<br>**7 paid a cheating seller**<br>**6 paid twice for the same data**<br>角落小字：*Source: BlockRun Agent Money Benchmark, Oct 2026* | "BlockRun just tested this. They gave ten frontier models real money and a marketplace with cheating sellers. Seven out of ten paid a cheater. Six paid twice for the same data, including top models from Anthropic and OpenAI." |
| **30–40s** | 大字：**"No chargebacks."** → 切 Bait logo | "On stablecoin rails there's no chargeback. Once an agent signs, the money is gone. So the check has to happen *before* payment. That's why we built **Bait**: we get scammed first, so your agent doesn't." |

### Part 2 — Demo（40–90s）

| 時間 | 畫面 | 旁白 |
|---|---|---|
| **40–55s**<br>Decoy | dashboard 全螢幕，終端機縮在右下角跑 `pnpm demo`。5 個 merchant 依序出現：honest 變 🟢 `ok`，其他 4 個變 🔴 `risky` 並出現 flag。滑鼠點 price-switch 的 Basescan 連結，跳到真實交易頁（剪輯加速 2×）。 | "Bait sends decoy agents with capped testnet wallets to buy first. Five sellers, one honest. The other four switch the price, take payment and send nothing, charge twice, or hide instructions in the data. Every flag links to an on-chain receipt." |
| **55–65s**<br>Guard OFF | event log 捲動，一筆筆付款。計數器 **Wasted without Bait** 從 0 跳到 **0.060 USDC**（剪輯加速 2×）。 | "Now a customer agent on GMI, without Bait. Same task: buy weather data from every seller. It overpays, pays for nothing, pays twice. Sixty percent of its budget, gone." |
| **65–75s**<br>Guard ON | event log 出現 4 行紅色 **BLOCKED**，附理由，例如 *"risk score 0.14 (PRICE_CHANGE: quoted 0.010, charged 0.050)"*。計數器 **Wasted with Bait: 0.000** · **Blocked: 4**。 | "Same agent, with Bait. Four payments blocked before the agent signs anything. Zero wasted." |
| **75–83s**<br>程式碼 | 編輯器開 `src/guard/guardedFetch.ts`，反白 `baitHook()`（`onBeforePaymentCreation` 裡呼叫 `checkBeforeSign`）。 | "It's one hook in front of any x402 payment. If the feed says risky, nothing gets signed." |
| **83–90s**<br>結尾 | 黑底，Bait logo + `github.com/MO7YW4NG/bait` | "Agents will get scammed. Let Bait get scammed first." |

---

## 純旁白版（給錄音用）

> We believe agent commerce is the future. Agents with wallets, paying APIs and other agents for data and services, with no human in the loop. And wherever money moves without a human watching, scammers follow.
>
> BlockRun just tested this. They gave ten frontier models real money and a marketplace with cheating sellers. Seven out of ten paid a cheater. Six paid twice for the same data, including top models from Anthropic and OpenAI.
>
> On stablecoin rails there's no chargeback. Once an agent signs, the money is gone. So the check has to happen before payment. That's why we built Bait: we get scammed first, so your agent doesn't.
>
> Bait sends decoy agents with capped testnet wallets to buy first. Five sellers, one honest. The other four switch the price, take payment and send nothing, charge twice, or hide instructions in the data. Every flag links to an on-chain receipt.
>
> Now a customer agent on GMI, without Bait. Same task: buy weather data from every seller. It overpays, pays for nothing, pays twice. Sixty percent of its budget, gone.
>
> Same agent, with Bait. Four payments blocked before the agent signs anything. Zero wasted.
>
> It's one hook in front of any x402 payment. If the feed says risky, nothing gets signed.
>
> Agents will get scammed. Let Bait get scammed first.

---

## 錄影前檢查清單

- [ ] `pnpm preflight` 全綠（兩個錢包 ≥ 0.5 USDC、facilitator、GMI）。
- [ ] `MOCK_FACILITATOR=0`。真實 Base Sepolia 才能講 "on-chain receipt"。若被迫用 mock，畫面必須看得到 "simulated"，旁白刪掉 "on-chain receipt"。
- [ ] 錄影前 `POST /reset` 清空 feed。
- [ ] customer 用 `--scripted`，數字才穩定。**0.060 / 60% 是預期值，旁白一律講那次錄影實際跑出的數字。**
- [ ] 計數器只算 customer。decoy 花的 0.10 USDC 是測試成本，不算 "wasted"。
- [ ] Basescan 交易頁先開好分頁（交易上鏈要幾秒）。
- [ ] dashboard 縮放 125–150%；終端機字型 ≥ 18pt；關掉通知。
- [ ] 錄一次完整 `pnpm demo`，剪輯時把 decoy 和 guard OFF 兩段加速 2×，角落標 "2×"。

---

## 備案：純終端機版（B 的 dashboard / customer 未完成時）

| 時間 | 畫面 | 旁白調整 |
|---|---|---|
| 40–55s | `pnpm decoy`：表格 4 個 flag + 真實交易連結 → 點開一個 Basescan | 同上 |
| 55–75s | `pnpm guard:check`：4 行 `BLOCK … nothing signed`、1 行 `ALLOW honest` | "Without Bait, this agent would have paid all five. With Bait, four were blocked before signing." |
| 75–90s | 程式碼 + 結尾 | 同上 |

需要 feed（`:4030`）在跑。此版本沒有浪費金額的數字。

---

## 用詞規則（評審可能追問）

| ✅ 可以說 | ❌ 不要說 | 理由 |
|---|---|---|
| "BlockRun reports / BlockRun tested" | 把數據講成獨立研究 | 結果是 BlockRun 自行公布；任務集與紀錄未公開 |
| "including top models from Anthropic and OpenAI" | "all frontier models got scammed" | Opus 5.5、GPT-6.1 Sol、GPT-6 Astra 沒中招 |
| "stablecoin rails" | "BlockRun tested x402" | BlockRun 用的是 Solana USDC，沒提 x402 |
| "hide instructions in the data"（描述 feed 會標記的風險） | "agents fall for prompt injection" | BlockRun 的 hidden instructions 陷阱 0/10 中招 |
| "x402 checks the signature, not the goods" | "x402 is broken / full of scammers" | 沒有測量數據；協定本來就不判斷賣家誠信 |
| "observable facts: quoted 0.010, charged 0.050" | 稱任何商家 "scam" / "fraud" | Responsible design |
| "our own test merchants on testnet" | "Bait pays real sellers" | MVP 只測自己的模擬商家；測真實賣家是 What's next |

## Q&A 可用的數據（2026-11-11 查證）

- **x402 Bazaar 有 33,496 個付費端點上架**（Coinbase CDP discovery API 即時查詢），自願登錄。抽樣 2,000 筆：96% 單價 ≤ $0.05，中位數 $0.005；主要是鏈上/行情資料、搜尋、天氣、LLM 呼叫。→ "Most of x402 today is sub-cent data calls. Nobody reviews a half-cent charge."
- **真實交易量仍小**：第三方分析指出帳面量大量來自訊號/洗量（Artemis 估 >95% 非真實買賣）。→ 講 "before agent commerce scales"，不講 "millions lost today"。
- **Stripe**：信用卡零售走 ACP + Shared Payment Token（有退款、金額上限），API 微支付走 Stripe machine payments（x402 / MPP）。→ "Same feed, any rail: on x402 the evidence is a tx hash; on Stripe it's a PaymentIntent."
- **What's next**：用 decoy 測 Bazaar 公開目錄，發表第一個實測的不誠實賣家比例。

## 來源

- BlockRun Agent Money Benchmark — https://agentmoneybench.com/ · https://github.com/BlockRunAI/agent-money-bench
- x402 Bazaar — https://docs.cdp.coinbase.com/x402/seller/get-discovered · https://docs.x402.org/extensions/bazaar
- x402 市場狀況 — https://forkast.news/the-x402-foundation-activated-a-27-year-old-internet-code-200-million-transactions-later-the-real-volume-is-still-tiny/ · https://www.coindesk.com/markets/2026/03/11/coinbase-backed-ai-payments-protocol-wants-to-fix-micropayment-but-demand-is-just-not-there-yet
- Stripe — https://stripe.com/blog/agentic-commerce-suite · https://docs.stripe.com/payments/machine
