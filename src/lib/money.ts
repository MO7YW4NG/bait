/**
 * Display + explorer helpers. Constants and parsing live in contracts.ts (frozen B0 contract).
 * All money math is bigint in USDC atomic units (6 decimals).
 */
import { BASE_SEPOLIA_NETWORK, USDC_DECIMALS, quoteToAtomic } from "./contracts.js";

export const NETWORK = BASE_SEPOLIA_NETWORK;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

/** "0.10" → 100000n. Accepts the env/quote decimal-string format only. */
export const usdcToAtomic = quoteToAtomic;

/** 10000n → "0.010" (at least 3 decimals, up to 6, trailing zeros trimmed past 3). */
export function atomicToUsdc(atomic: bigint | string | number): string {
  const a = BigInt(atomic);
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const whole = abs / SCALE;
  let frac = (abs % SCALE).toString().padStart(USDC_DECIMALS, "0");
  while (frac.length > 3 && frac.endsWith("0")) frac = frac.slice(0, -1);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function sumAtomic(values: Array<bigint | string>): bigint {
  return values.reduce<bigint>((acc, v) => acc + BigInt(v), 0n);
}

export function explorerTxUrl(txHash: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null; // mock / malformed → no link
  return `https://sepolia.basescan.org/tx/${txHash}`;
}

export function isSimulatedTx(txHash: string): boolean {
  return txHash.startsWith("0xmock");
}

export function asHex(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new TypeError("expected 0x-prefixed hex");
  return value as `0x${string}`;
}
