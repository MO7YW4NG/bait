/**
 * Bait HTTP contracts, v1. Source of truth: plan.md §§4.1–4.8 and TEAM_SPLIT.md §3.
 *
 * Wire money fields use integer decimal strings in the smallest USDC unit
 * (1 USDC = 1_000_000 atomic units). Convert to bigint before arithmetic.
 * Never JSON.stringify(bigint). Quote 'priceUsdc' is the plan's legacy
 * human-readable decimal string; it must never be used for calculations.
 */
export const BASE_SEPOLIA_NETWORK = "eip155:84532" as const;
export const USDC_DECIMALS = 6 as const;
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

/** Non-negative integer in base 10; e.g. "10000" = 0.010000 USDC. */
export type UsdcAtomicString = string;

export function toAtomicString(amount: bigint): UsdcAtomicString {
  if (amount < 0n) throw new RangeError("USDC atomic units must be non-negative");
  return amount.toString();
}
export function parseAtomicString(amount: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) {
    throw new TypeError("Expected a non-negative integer USDC atomic-unit string");
  }
  return BigInt(amount);
}
/** Parse decimal quote precisely, never using floating-point numbers. */
export function quoteToAtomic(priceUsdc: string): bigint {
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(priceUsdc)) {
    throw new TypeError("Quote must be a non-negative decimal USDC string (up to 6 places)");
  }
  const [whole, fraction = ""] = priceUsdc.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
}

export type MerchantId = "honest" | "price-switch" | "ghost" | "double" | "injector" | (string & {});
export interface Merchant {
  id: MerchantId;
  name: string;
  quoteUrl: string;
  dataUrl: string;
}
export interface MerchantQuote {
  merchantId: MerchantId;
  product: string;
  /** Display-only decimal string, retained to match plan.md. Not a number. */
  priceUsdc: string;
  description: string;
  /** Optional for backwards-compatible merchant discovery; if present, authoritative. */
  priceAtomic?: UsdcAtomicString;
}

export interface PaymentSettlement {
  txHash: string;
  amountAtomic: UsdcAtomicString;
  simulated: boolean;
  network?: typeof BASE_SEPOLIA_NETWORK;
}

/** Wire representation of the decoy transaction. bigint must be serialized first. */
export interface TransactionEvidence {
  merchantId: MerchantId;
  requestId: string;
  quotedAtomic: UsdcAtomicString;
  requiredAtomic?: UsdcAtomicString;
  settlements: PaymentSettlement[];
  finalBody: unknown;
  status: number;
  runId?: string;
  url?: string;
}

export const RISK_FLAGS = [
  "PRICE_CHANGE",
  "NON_DELIVERY",
  "DOUBLE_CHARGE",
  "PROMPT_INJECTION",
] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];
export type EvidenceSource = "decoy" | "report";
export type DetectionSource = "rule" | "judge";
export interface RiskFlagObservation {
  flag: RiskFlag;
  by: DetectionSource;
  detail?: string;
}
/** Strings from the deterministic rules are interpreted as 'by: rule'. */
export type RiskFlagInput = RiskFlag | RiskFlagObservation;
export type RiskVerdict = "ok" | "risky" | "unknown";

export interface RiskEvidenceItem {
  flag: RiskFlag;
  by: DetectionSource;
  txHash: string | null;
  explorerUrl: string | null;
  /** Atomic strings, despite the shortened property names retained from plan.md. */
  quoted: UsdcAtomicString;
  charged: UsdcAtomicString;
  detail: string;
  /** Unix epoch milliseconds, consistent with Date.now(). */
  ts: number;
}
export interface RiskResponse {
  /** null when no merchant matches the requested URL. */
  merchantId: MerchantId | null;
  /** Bayesian weighted score (0..1); numeric score is NOT money. */
  score: number;
  verdict: RiskVerdict;
  flags: RiskFlag[];
  evidence: RiskEvidenceItem[];
}
export interface MerchantRiskSummary extends RiskResponse {
  id: MerchantId;
  name: string;
  /** Normalized origin + pathname of the paid endpoint. */
  url: string;
}

export const FEED_EVENT_TYPES = [
  "run_started",
  "quote",
  "payment_settled",
  "flag_raised",
  "judge_note",
  "guard_blocked",
  "guard_allowed",
  "wasted",
  "injection_exposed",
  "run_finished",
  "reset",
] as const;
export type FeedEventType = (typeof FEED_EVENT_TYPES)[number];
export interface FeedEvent {
  id: number;
  /** Unix epoch milliseconds. */
  ts: number;
  actor: string;
  type: FeedEventType;
  payload: Record<string, unknown> & {
    merchantId?: MerchantId;
    txHash?: string;
    runId?: string;
  };
}
export type FeedEventInput = Omit<FeedEvent, "id" | "ts"> & { ts?: number };

export interface CustomerSpendRecord {
  /** Unique demo run ID; latest per guard mode supplies /stats. */
  run: string;
  guard: "on" | "off";
  merchantId: MerchantId;
  spentAtomic: UsdcAtomicString;
  wastedAtomic: UsdcAtomicString;
  blocked: boolean;
  injection: boolean;
  ts?: number;
}
export interface DemoStats {
  off: { spent: UsdcAtomicString; wasted: UsdcAtomicString; injections: number };
  on: { spent: UsdcAtomicString; wasted: UsdcAtomicString; blocked: number };
}

export interface WeatherReport {
  city: string;
  tempC: number;
  condition: string;
  humidity: number;
  observedAt: string;
  note?: string;
}

export interface EvidencePostRequest {
  transaction: TransactionEvidence;
  flags: RiskFlagInput[];
}
export interface ReportPostRequest {
  url: string;
  outcome: "good" | "bad";
  /** Proof of payment; regex /^0x(mock)?[0-9a-f]+$/i required by feed. */
  txHash: string;
}
export interface SpendPostRequest extends CustomerSpendRecord {}
export interface EventPostRequest extends FeedEventInput {}
export interface ApiWriteResponse {
  ok: true;
  id?: number;
}

/** Merchant service, port 4021. Path parameter id is a MerchantId. */
export interface MerchantApi {
  "GET /merchants": { response: Merchant[] };
  "GET /m/:id/quote": { response: MerchantQuote };
  "GET /m/:id/data": { response: WeatherReport | Record<string, unknown> };
  "GET /health": { response: string };
}
/** Feed service, port 4030. GET /events has text/event-stream body, not JSON. */
export interface FeedApi {
  "POST /evidence": { request: EvidencePostRequest; response: ApiWriteResponse };
  "GET /risk": { query: { url: string }; response: RiskResponse };
  "POST /report": { request: ReportPostRequest; response: ApiWriteResponse };
  "POST /spend": { request: SpendPostRequest; response: ApiWriteResponse };
  "POST /events": { request: EventPostRequest; response: ApiWriteResponse };
  "GET /events": { response: "text/event-stream"; event: FeedEvent };
  "GET /merchants": { response: MerchantRiskSummary[] };
  "GET /stats": { response: DemoStats };
  "POST /reset": { response: ApiWriteResponse };
  "GET /health": { response: string };
}

/** A payment aborted before a wallet signature is not a settlement. */
export type BuyerResult =
  | { blocked: true; reason: string; status?: number; requiredAtomic?: bigint }
  | {
      blocked?: false;
      status: number;
      body: unknown;
      requiredAtomic?: bigint;
      settlement?: { txHash: string; amountAtomic: bigint; simulated: boolean };
      network: typeof BASE_SEPOLIA_NETWORK;
    };
