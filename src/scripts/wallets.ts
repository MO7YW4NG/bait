/**
 * pnpm wallets — create .env (from .env.example) and fill in any MISSING wallet values.
 * Never overwrites an existing key. Prints addresses only, never private keys.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ENV = ".env";
let text = existsSync(ENV) ? readFileSync(ENV, "utf8") : existsSync(".env.example") ? readFileSync(".env.example", "utf8") : "";

function get(key: string): string | undefined {
  const m = new RegExp(`^${key}=([^\\s#]*)`, "m").exec(text);
  return m?.[1] || undefined;
}
function set(key: string, value: string) {
  const re = new RegExp(`^${key}=.*$`, "m");
  text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
}

const isKey = (v?: string) => !!v && /^0x[0-9a-fA-F]{64}$/.test(v);
const isAddr = (v?: string) => !!v && /^0x[0-9a-fA-F]{40}$/.test(v);

for (const key of ["DECOY_PRIVATE_KEY", "CUSTOMER_PRIVATE_KEY"]) {
  if (!isKey(get(key))) {
    set(key, generatePrivateKey());
    console.log(`generated ${key}`);
  }
  console.log(`${key.replace("_PRIVATE_KEY", "").toLowerCase().padEnd(8)} ${privateKeyToAccount(get(key) as `0x${string}`).address}`);
}
if (!isAddr(get("MERCHANT_PAYTO"))) {
  set("MERCHANT_PAYTO", privateKeyToAccount(generatePrivateKey()).address); // receive-only; key discarded
  console.log("generated MERCHANT_PAYTO (receive-only address)");
}
console.log(`merchant ${get("MERCHANT_PAYTO")}`);

writeFileSync(ENV, text);
console.log(`\nWrote ${ENV}. Fund decoy + customer with ≥ 2 USDC each: https://faucet.circle.com/ (Base Sepolia). No ETH needed.`);
