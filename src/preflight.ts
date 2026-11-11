/** pnpm preflight — env, wallet balances, facilitator support, GMI models. Never prints secrets. */
import { createPublicClient, erc20Abi, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { loadEnv } from "./lib/env.js";
import { NETWORK, atomicToUsdc } from "./lib/money.js";
import { BASE_SEPOLIA_USDC } from "./lib/contracts.js";

let failures = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const bad = (msg: string) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const warn = (msg: string) => console.log(`  ! ${msg}`);

const env = loadEnv("preflight");
const client = createPublicClient({ chain: baseSepolia, transport: http(env.RPC_URL) });

console.log("Wallets (Base Sepolia USDC)");
for (const key of ["DECOY_PRIVATE_KEY", "CUSTOMER_PRIVATE_KEY"] as const) {
  const pk = env[key];
  if (!pk) {
    bad(`${key} missing — run \`pnpm wallets\``);
    continue;
  }
  const address = privateKeyToAccount(pk as `0x${string}`).address;
  try {
    const bal = await client.readContract({ address: BASE_SEPOLIA_USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    const line = `${key.replace("_PRIVATE_KEY", "").toLowerCase()} ${address}: ${atomicToUsdc(bal)} USDC`;
    bal >= 500_000n ? ok(line) : bad(`${line} (need ≥ 0.5 — https://faucet.circle.com/ → Base Sepolia)`);
  } catch (err) {
    bad(`${key}: balance check failed (${(err as Error).message.split("\n")[0]})`);
  }
}
env.MERCHANT_PAYTO ? ok(`merchant payTo ${env.MERCHANT_PAYTO}`) : bad("MERCHANT_PAYTO missing — run `pnpm wallets`");

console.log("\nFacilitator");
if (env.MOCK_FACILITATOR) {
  warn("MOCK_FACILITATOR=1 — settlements are simulated (0xmock…), not on-chain");
} else {
  try {
    const res = await fetch(`${env.FACILITATOR_URL.replace(/\/$/, "")}/supported`, { signal: AbortSignal.timeout(8_000) });
    const sup = (await res.json()) as { kinds?: Array<{ x402Version: number; scheme: string; network: string }> };
    const hit = sup.kinds?.find((k) => k.scheme === "exact" && k.network === NETWORK && k.x402Version === 2);
    hit ? ok(`${env.FACILITATOR_URL} supports exact on ${NETWORK} (v2)`) : bad(`${env.FACILITATOR_URL} does not list exact/${NETWORK}/v2`);
  } catch (err) {
    bad(`facilitator unreachable: ${(err as Error).message}  → fallback: MOCK_FACILITATOR=1`);
  }
}

console.log("\nGMI Cloud");
if (!env.GMI_API_KEY) {
  warn("GMI_API_KEY not set — LLM customer/judge disabled (scripted mode still works)");
} else {
  try {
    const t0 = Date.now();
    const res = await fetch(`${env.GMI_BASE_URL.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${env.GMI_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = ((await res.json()) as { data?: Array<{ id: string }> }).data?.map((m) => m.id) ?? [];
    ok(`${ids.length} models listed (${Date.now() - t0} ms)`);
    for (const key of ["CUSTOMER_MODEL", "JUDGE_MODEL"] as const) {
      const id = env[key];
      if (!id) warn(`${key} not set`);
      else ids.includes(id) ? ok(`${key}=${id}`) : bad(`${key}=${id} not in /models`);
    }
  } catch (err) {
    bad(`GMI /models failed: ${(err as Error).message}`);
  }
}

console.log(failures ? `\n${failures} problem(s).` : "\nAll good.");
process.exit(failures ? 1 : 0);
