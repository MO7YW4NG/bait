import type {
  ApiWriteResponse, CustomerSpendRecord, DemoStats, EvidencePostRequest,
  FeedEventInput, MerchantRiskSummary, ReportPostRequest, RiskResponse,
} from "./contracts.js";

/** Remote-only typed access; agents must never import/open the SQLite store. */
export class FeedHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "FeedHttpError";
  }
}

export function createFeedClient(feedUrl = process.env.FEED_URL ?? "http://localhost:4030",
  timeoutMs = 10_000) {
  const base = new URL(feedUrl);
  if (!["http:", "https:"].includes(base.protocol)) throw new TypeError("Invalid feed URL");
  const endpoint = (pathname: string) => new URL(pathname, base).toString();

  async function request<T>(pathname: string, body?: unknown): Promise<T> {
    const response = await fetch(endpoint(pathname), {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new FeedHttpError(response.status,
        "Risk feed " + response.status + ": " + detail.slice(0, 300));
    }
    return await response.json() as T;
  }

  return {
    risk: (url: string) =>
      request<RiskResponse>("/risk?url=" + encodeURIComponent(url)),
    evidence: (input: EvidencePostRequest) =>
      request<ApiWriteResponse>("/evidence", input),
    report: (input: ReportPostRequest) =>
      request<ApiWriteResponse>("/report", input),
    spend: (input: CustomerSpendRecord) =>
      request<ApiWriteResponse>("/spend", input),
    event: (input: FeedEventInput) =>
      request<ApiWriteResponse>("/events", input),
    merchants: () => request<MerchantRiskSummary[]>("/merchants"),
    stats: () => request<DemoStats>("/stats"),
    reset: () => request<ApiWriteResponse>("/reset", {}),
    async health(): Promise<boolean> {
      const response = await fetch(endpoint("/health"), { signal: AbortSignal.timeout(timeoutMs) });
      return response.ok;
    },
  };
}

export const feedClient = createFeedClient();
export const getRisk = (url: string, feedUrl?: string) => createFeedClient(feedUrl).risk(url);
export const postEvidence = (body: EvidencePostRequest, feedUrl?: string) =>
  createFeedClient(feedUrl).evidence(body);
export const postReport = (body: ReportPostRequest, feedUrl?: string) =>
  createFeedClient(feedUrl).report(body);
export const postSpend = (body: CustomerSpendRecord, feedUrl?: string) =>
  createFeedClient(feedUrl).spend(body);
export const postEvent = (body: FeedEventInput, feedUrl?: string) =>
  createFeedClient(feedUrl).event(body);
