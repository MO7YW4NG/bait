/**
 * Lazy, scope-aware environment parsing: the feed never needs wallet keys,
 * GMI credentials or Stripe. Call loadEnv('scope') at module startup.
 * Importing this module does NOT validate or log any secret.
 */
import "dotenv/config";
import { z } from "zod";

const key = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte 0x private key");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte 0x address");
const decimalUsdc = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/, "must be a decimal USDC string (max 6 places)");

export const envSchema = z.object({
  FEED_URL: z.string().url().default("http://localhost:4030"),
  MERCHANT_URL: z.string().url().default("http://localhost:4021"),
  RPC_URL: z.string().url().default("https://sepolia.base.org"),
  FACILITATOR_URL: z.string().url().default("https://x402.org/facilitator"),
  GUARD_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.6),
  MOCK_FACILITATOR: z.enum(["0", "1"]).default("0").transform((v) => v === "1"),
  MAX_PRICE_PER_CALL_USDC: decimalUsdc.default("0.10"),
  GMI_API_KEY: z.string().min(1).optional(),
  GMI_BASE_URL: z.string().url().default("https://api.gmi-serving.com/v1"),
  CUSTOMER_MODEL: z.string().min(1).optional(),
  JUDGE_MODEL: z.string().min(1).optional(),
  DECOY_PRIVATE_KEY: key.optional(),
  CUSTOMER_PRIVATE_KEY: key.optional(),
  MERCHANT_PAYTO: address.optional(),
  STRIPE_SECRET_KEY: z.string().startsWith("sk_test_", "only sk_test_ Stripe keys are allowed").optional(),
});
export type BaitEnv = z.infer<typeof envSchema>;
export type EnvScope =
  | "feed"
  | "merchants"
  | "decoy"
  | "customer-scripted"
  | "customer-llm"
  | "guard"
  | "judge"
  | "preflight"
  | "demo"
  | "stripe";

const selected: Record<EnvScope, readonly (keyof BaitEnv)[]> = {
  feed: ["FEED_URL", "GUARD_MIN_SCORE"],
  merchants: ["MERCHANT_URL", "MERCHANT_PAYTO", "FACILITATOR_URL", "MOCK_FACILITATOR", "RPC_URL"],
  decoy: ["FEED_URL", "MERCHANT_URL", "RPC_URL", "FACILITATOR_URL", "MOCK_FACILITATOR", "DECOY_PRIVATE_KEY", "MAX_PRICE_PER_CALL_USDC", "JUDGE_MODEL", "GMI_API_KEY", "GMI_BASE_URL"],
  "customer-scripted": ["FEED_URL", "MERCHANT_URL", "RPC_URL", "FACILITATOR_URL", "MOCK_FACILITATOR", "CUSTOMER_PRIVATE_KEY", "GUARD_MIN_SCORE", "MAX_PRICE_PER_CALL_USDC"],
  "customer-llm": ["FEED_URL", "MERCHANT_URL", "RPC_URL", "FACILITATOR_URL", "MOCK_FACILITATOR", "CUSTOMER_PRIVATE_KEY", "GUARD_MIN_SCORE", "MAX_PRICE_PER_CALL_USDC", "GMI_API_KEY", "GMI_BASE_URL", "CUSTOMER_MODEL"],
  guard: ["FEED_URL", "GUARD_MIN_SCORE", "MAX_PRICE_PER_CALL_USDC", "RPC_URL"],
  judge: ["GMI_API_KEY", "GMI_BASE_URL", "JUDGE_MODEL"],
  preflight: ["RPC_URL", "FACILITATOR_URL", "DECOY_PRIVATE_KEY", "CUSTOMER_PRIVATE_KEY", "MERCHANT_PAYTO", "GMI_API_KEY", "GMI_BASE_URL", "CUSTOMER_MODEL", "JUDGE_MODEL", "MOCK_FACILITATOR"],
  demo: ["FEED_URL", "MERCHANT_URL", "GUARD_MIN_SCORE", "MOCK_FACILITATOR"],
  stripe: ["STRIPE_SECRET_KEY"],
};

const required: Partial<Record<EnvScope, readonly (keyof BaitEnv)[]>> = {
  merchants: ["MERCHANT_PAYTO"],
  decoy: ["DECOY_PRIVATE_KEY"],
  "customer-scripted": ["CUSTOMER_PRIVATE_KEY"],
  "customer-llm": ["CUSTOMER_PRIVATE_KEY", "GMI_API_KEY", "CUSTOMER_MODEL"],
  judge: ["GMI_API_KEY", "JUDGE_MODEL"],
  preflight: ["DECOY_PRIVATE_KEY", "CUSTOMER_PRIVATE_KEY", "MERCHANT_PAYTO"],
  stripe: ["STRIPE_SECRET_KEY"],
};

export function loadEnv(scope: EnvScope): BaitEnv {
  const input: Record<string, string> = {};
  for (const name of selected[scope]) {
    const value = process.env[name]?.trim();
    if (value) input[name] = value;
  }
  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    const reasons = parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message);
    // Never interpolate raw process.env values or the Zod input into errors.
    throw new Error("Invalid " + scope + " environment:\n- " + reasons.join("\n- "));
  }
  const missing = (required[scope] ?? []).filter((name) => parsed.data[name] === undefined);
  if (missing.length) throw new Error("Missing " + scope + " environment variables: " + missing.join(", "));
  return parsed.data;
}

export const getEnv = loadEnv;
