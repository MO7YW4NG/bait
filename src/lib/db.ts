import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  parseAtomicString,
  type CustomerSpendRecord,
  type DemoStats,
  type FeedEvent,
  type FeedEventInput,
  type MerchantRiskSummary,
  type RiskEvidenceItem,
  type RiskFlagInput,
  type RiskFlagObservation,
  type RiskResponse,
  type TransactionEvidence,
} from "./contracts.js";

type MerchantRow = { id: string; name: string; url: string };
type OutcomeRow = { good: number; weight: number };
type EvidenceRow = {
  flag: string; by: "rule" | "judge"; tx_hash: string | null;
  quoted_atomic: string; charged_atomic: string; detail: string; ts: number;
};
type EventRow = { id: number; ts: number; actor: string; type: FeedEvent["type"]; payload: string };
type SpendRow = {
  run: string; guard: "on" | "off"; spent_atomic: string; wasted_atomic: string;
  blocked: number; injection: number; ts: number; id: number;
};

/** Canonical merchant identity. Query strings and fragments never affect a match. */
export function normalizeMerchantUrl(input: string): string {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new TypeError("Expected an HTTP(S) merchant URL without credentials");
  }
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.origin + pathname;
}

export class RiskDatabase {
  private readonly db: DatabaseSync;

  constructor(filename = "data/bait.db") {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS merchants (
        id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        merchant_id TEXT NOT NULL, flag TEXT NOT NULL,
        by TEXT NOT NULL CHECK(by IN ('rule','judge')),
        tx_hash TEXT, quoted_atomic TEXT NOT NULL, charged_atomic TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '', source TEXT NOT NULL CHECK(source IN ('decoy','report')),
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        merchant_id TEXT NOT NULL, good INTEGER NOT NULL CHECK(good IN (0,1)),
        weight INTEGER NOT NULL CHECK(weight > 0), source TEXT NOT NULL,
        tx_hash TEXT, request_id TEXT, ts INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS outcomes_dedupe
        ON outcomes(source, merchant_id, request_id) WHERE request_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
        actor TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spend (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL,
        guard TEXT NOT NULL CHECK(guard IN ('on','off')),
        merchant_id TEXT NOT NULL, spent_atomic TEXT NOT NULL,
        wasted_atomic TEXT NOT NULL, blocked INTEGER NOT NULL CHECK(blocked IN (0,1)),
        injection INTEGER NOT NULL CHECK(injection IN (0,1)), ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evidence_by_merchant ON evidence(merchant_id, id DESC);
      CREATE INDEX IF NOT EXISTS spend_by_run ON spend(guard,run,id DESC);
    `);
  }

  close(): void { this.db.close(); }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertMerchant(id: string, url: string, name = id): void {
    const canonical = normalizeMerchantUrl(url);
    const existing = this.getMerchantByUrl(canonical);
    if (existing && existing.id !== id) {
      // Reports may arrive before a decoy discovers the authoritative merchant ID.
      // Preserve their outcomes and any associated data when promoting the placeholder.
      if (existing.id !== "report:" + canonical) {
        throw new Error("Merchant URL already belongs to " + existing.id);
      }
      const idTaken = this.db.prepare("SELECT id FROM merchants WHERE id=?").get(id);
      if (idTaken) throw new Error("Merchant ID already belongs to another URL");
      this.db.prepare("UPDATE merchants SET id=?,name=? WHERE id=?")
        .run(id, name, existing.id);
      for (const table of ["evidence", "outcomes", "spend"]) {
        this.db.prepare("UPDATE " + table + " SET merchant_id=? WHERE merchant_id=?")
          .run(id, existing.id);
      }
      return;
    }
    this.db.prepare(`
      INSERT INTO merchants(id,url,name) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET url=excluded.url, name=excluded.name
    `).run(id, canonical, name);
  }

  getMerchantByUrl(url: string): MerchantRow | undefined {
    return this.db.prepare("SELECT id,name,url FROM merchants WHERE url=?")
      .get(normalizeMerchantUrl(url)) as MerchantRow | undefined;
  }

  /** Atomic: at most one scored decoy outcome for each requestId per merchant. */
  recordDecoy(tx: TransactionEvidence, flags: RiskFlagInput[], merchantUrl: string): number {
    const observations: RiskFlagObservation[] = flags.map((flag) =>
      typeof flag === "string" ? { flag, by: "rule" } : flag);
    const hasRuleFlag = observations.some((flag) => flag.by === "rule");
    const chargedAtomic = tx.settlements.reduce(
      (sum, settlement) => sum + parseAtomicString(settlement.amountAtomic), 0n
    ).toString();
    const txHash = tx.settlements.at(-1)?.txHash ?? null;
    const ts = Date.now();
    return this.transaction(() => {
      this.upsertMerchant(tx.merchantId, merchantUrl);
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO outcomes(merchant_id,good,weight,source,tx_hash,request_id,ts)
        VALUES(?,?,?,?,?,?,?)
      `).run(tx.merchantId, hasRuleFlag ? 0 : 1, 5, "decoy", txHash, tx.requestId, ts);
      if (inserted.changes === 0) {
        const previous = this.db.prepare(`
          SELECT id FROM outcomes WHERE merchant_id=? AND source='decoy' AND request_id=?
        `).get(tx.merchantId, tx.requestId) as { id: number };
        return previous.id;
      }
      for (const flag of observations) {
        this.db.prepare(`
          INSERT INTO evidence(merchant_id,flag,by,tx_hash,quoted_atomic,charged_atomic,detail,source,ts)
          VALUES(?,?,?,?,?,?,?,?,?)
        `).run(tx.merchantId, flag.flag, flag.by, txHash, tx.quotedAtomic,
          chargedAtomic, flag.detail ?? "", "decoy", ts);
      }
      return Number(inserted.lastInsertRowid);
    });
  }

  /** Reports are format-checked but explicitly NOT chain-verified. */
  recordReport(url: string, outcome: "good" | "bad", txHash: string): number {
    const canonical = normalizeMerchantUrl(url);
    return this.transaction(() => {
      let merchant = this.getMerchantByUrl(canonical);
      if (!merchant) {
        const id = "report:" + canonical;
        this.upsertMerchant(id, canonical, new URL(canonical).hostname);
        merchant = this.getMerchantByUrl(canonical);
      }
      const id = merchant!.id;
      const dedupeKey = txHash.toLowerCase();
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO outcomes(merchant_id,good,weight,source,tx_hash,request_id,ts)
        VALUES(?,?,?,?,?,?,?)
      `).run(id, outcome === "good" ? 1 : 0, 1, "report", txHash, dedupeKey, Date.now());
      if (inserted.changes > 0) return Number(inserted.lastInsertRowid);
      const previous = this.db.prepare(`
        SELECT id FROM outcomes WHERE source='report' AND merchant_id=? AND request_id=?
      `).get(id, dedupeKey) as { id: number };
      return previous.id;
    });
  }

  recordSpend(record: CustomerSpendRecord): number {
    parseAtomicString(record.spentAtomic);
    parseAtomicString(record.wastedAtomic);
    const result = this.db.prepare(`
      INSERT INTO spend(run,guard,merchant_id,spent_atomic,wasted_atomic,blocked,injection,ts)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(record.run, record.guard, record.merchantId, record.spentAtomic,
      record.wastedAtomic, record.blocked ? 1 : 0, record.injection ? 1 : 0,
      record.ts ?? Date.now());
    return Number(result.lastInsertRowid);
  }

  recordEvent(input: FeedEventInput): FeedEvent {
    const ts = input.ts ?? Date.now();
    const result = this.db.prepare(`
      INSERT INTO events(ts,actor,type,payload) VALUES(?,?,?,?)
    `).run(ts, input.actor, input.type, JSON.stringify(input.payload));
    return { id: Number(result.lastInsertRowid), ts, actor: input.actor,
      type: input.type, payload: input.payload };
  }

  recentEvents(limit = 50): FeedEvent[] {
    const rows = this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as EventRow[];
    return rows.reverse().map(this.mapEvent);
  }

  eventsAfter(id: number, limit = 500): FeedEvent[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(id, limit) as unknown as EventRow[];
    return rows.map(this.mapEvent);
  }

  private mapEvent(row: EventRow): FeedEvent {
    return { id: row.id, ts: row.ts, actor: row.actor, type: row.type,
      payload: JSON.parse(row.payload) as FeedEvent["payload"] };
  }

  riskForUrl(url: string, minScore = 0.6): RiskResponse {
    const merchant = this.getMerchantByUrl(url);
    return merchant ? this.riskForMerchant(merchant.id, minScore)
      : { merchantId: null, score: 0.5, verdict: "unknown", flags: [], evidence: [] };
  }

  riskForMerchant(id: string, minScore = 0.6): RiskResponse {
    const outcomes = this.db.prepare("SELECT good,weight FROM outcomes WHERE merchant_id=?")
      .all(id) as unknown as OutcomeRow[];
    let good = 0;
    let bad = 0;
    for (const outcome of outcomes) {
      if (outcome.good) good += outcome.weight;
      else bad += outcome.weight;
    }
    const score = (1 + good) / (2 + good + bad);
    const verdict = outcomes.length === 0 ? "unknown" : score < minScore ? "risky" : "ok";
    const rows = this.db.prepare(`
      SELECT flag,by,tx_hash,quoted_atomic,charged_atomic,detail,ts
      FROM evidence WHERE merchant_id=? ORDER BY id DESC
    `).all(id) as unknown as EvidenceRow[];
    const evidence: RiskEvidenceItem[] = rows.map((row) => ({
      flag: row.flag as RiskEvidenceItem["flag"], by: row.by,
      txHash: row.tx_hash,
      explorerUrl: row.tx_hash && /^0x[0-9a-f]{64}$/i.test(row.tx_hash)
        ? "https://sepolia.basescan.org/tx/" + row.tx_hash : null,
      quoted: row.quoted_atomic, charged: row.charged_atomic,
      detail: row.detail, ts: row.ts,
    }));
    return { merchantId: id, score, verdict,
      flags: [...new Set(evidence.map((item) => item.flag))], evidence };
  }

  merchants(minScore = 0.6): MerchantRiskSummary[] {
    const rows = this.db.prepare("SELECT id,name,url FROM merchants ORDER BY id")
      .all() as unknown as MerchantRow[];
    return rows.map((merchant) => ({
      id: merchant.id, name: merchant.name, url: merchant.url,
      ...this.riskForMerchant(merchant.id, minScore),
    }));
  }

  /** Choose the most recently inserted run for each guard mode, never aggregate all runs. */
  stats(): DemoStats {
    const result: DemoStats = {
      off: { spent: "0", wasted: "0", injections: 0 },
      on: { spent: "0", wasted: "0", blocked: 0 },
    };
    for (const mode of ["off", "on"] as const) {
      const latest = this.db.prepare(`
        SELECT run FROM spend WHERE guard=? GROUP BY run ORDER BY MAX(id) DESC LIMIT 1
      `).get(mode) as { run: string } | undefined;
      if (!latest) continue;
      const rows = this.db.prepare("SELECT * FROM spend WHERE guard=? AND run=? ORDER BY id")
        .all(mode, latest.run) as unknown as SpendRow[];
      let spent = 0n;
      let wasted = 0n;
      let blocked = 0;
      let injections = 0;
      for (const row of rows) {
        spent += parseAtomicString(row.spent_atomic);
        wasted += parseAtomicString(row.wasted_atomic);
        blocked += row.blocked;
        injections += row.injection;
      }
      if (mode === "off") result.off = { spent: spent.toString(), wasted: wasted.toString(), injections };
      else result.on = { spent: spent.toString(), wasted: wasted.toString(), blocked };
    }
    return result;
  }

  reset(): void {
    this.transaction(() => {
      for (const table of ["evidence", "outcomes", "spend", "merchants", "events"]) {
        this.db.exec("DELETE FROM " + table);
      }
    });
  }
}
