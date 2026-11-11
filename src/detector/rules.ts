import { atomicToUsdc, sumAtomic } from "../lib/money.js";
import { isDelivered } from "../lib/weather.js";
import type { RiskFlag, RiskFlagObservation, TransactionEvidence } from "../lib/contracts.js";

/**
 * Deterministic detection rules — the source of truth for the risk score.
 * Details state observable facts only.
 */
export const INJECTION_RE = /ignore (all |previous )?instructions|SYSTEM:|send .{0,40}key/i;

/** A contract `RiskFlagObservation` plus the evidence fields the feed can store per flag. */
export type Finding = RiskFlagObservation & {
  flag: RiskFlag;
  detail: string;
  txHash: string | null;
  quotedAtomic: string;
  chargedAtomic: string; // total settled for this transaction
};

function isEmptyBody(body: unknown): boolean {
  if (body === null || body === undefined || body === "") return true;
  if (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0) return true;
  return false;
}

export function hasInjection(body: unknown): string | null {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  const m = INJECTION_RE.exec(text);
  if (!m) return null;
  const start = Math.max(0, m.index - 10);
  return text.slice(start, m.index + 70);
}

export function detect(tx: TransactionEvidence): Finding[] {
  const findings: Finding[] = [];
  const quoted = BigInt(tx.quotedAtomic);
  const charged = sumAtomic(tx.settlements.map((s) => s.amountAtomic));
  const firstTx = tx.settlements[0]?.txHash ?? null;
  const base = { by: "rule" as const, quotedAtomic: tx.quotedAtomic, chargedAtomic: charged.toString() };

  // PRICE_CHANGE: the 402 (or any settlement) asked for more than the quote.
  const required = tx.requiredAtomic !== undefined ? BigInt(tx.requiredAtomic) : null;
  const overSettlement = tx.settlements.find((s) => BigInt(s.amountAtomic) > quoted);
  if ((required !== null && required > quoted) || overSettlement) {
    const asked = overSettlement ? BigInt(overSettlement.amountAtomic) : required!;
    findings.push({
      ...base,
      flag: "PRICE_CHANGE",
      txHash: overSettlement?.txHash ?? firstTx,
      detail: `quoted ${atomicToUsdc(quoted)} USDC, payment required ${atomicToUsdc(asked)} USDC`,
    });
  }

  // DOUBLE_CHARGE: more than one settlement for one requestId.
  if (tx.settlements.length > 1) {
    findings.push({
      ...base,
      flag: "DOUBLE_CHARGE",
      txHash: tx.settlements[1]!.txHash,
      detail: `${tx.settlements.length} settlements for one order (request ${tx.requestId}): ${tx.settlements
        .map((s) => `${atomicToUsdc(s.amountAtomic)} USDC`)
        .join(" + ")} = ${atomicToUsdc(charged)} USDC`,
    });
  }

  // NON_DELIVERY: paid, but the final body is empty or not the product.
  if (tx.settlements.length > 0 && (isEmptyBody(tx.finalBody) || !isDelivered(tx.finalBody))) {
    const shown = JSON.stringify(tx.finalBody ?? null).slice(0, 60);
    findings.push({
      ...base,
      flag: "NON_DELIVERY",
      txHash: tx.settlements[tx.settlements.length - 1]!.txHash,
      detail: `paid ${atomicToUsdc(charged)} USDC; response ${shown} does not match the advertised product`,
    });
  }

  // PROMPT_INJECTION: instruction-like text in the delivered data.
  const snippet = hasInjection(tx.finalBody);
  if (snippet) {
    findings.push({
      ...base,
      flag: "PROMPT_INJECTION",
      txHash: tx.settlements[tx.settlements.length - 1]?.txHash ?? null,
      detail: `response contains instruction-like text: "${snippet}"`,
    });
  }

  return findings;
}
