import { randomBytes } from "node:crypto";
import type { FacilitatorClient } from "@x402/core/server";
import { NETWORK } from "./money.js";

/**
 * MOCK_FACILITATOR=1 fallback. Keeps the 402 handshake and the buyer's EIP-3009 signature real,
 * but "settles" locally with a fake `0xmock…` tx hash. Nothing moves on-chain.
 * The dashboard must label these settlements "simulated".
 */
export function createMockFacilitator(): FacilitatorClient {
  return {
    async verify(paymentPayload, requirements) {
      const auth = (paymentPayload.payload as { authorization?: { from?: string; value?: string } })
        .authorization;
      const amountOk =
        paymentPayload.accepted.amount === requirements.amount &&
        (auth?.value === undefined || auth.value === requirements.amount);
      if (!amountOk) {
        return { isValid: false, invalidReason: "amount_mismatch", payer: auth?.from };
      }
      return { isValid: true, payer: auth?.from };
    },

    async settle(paymentPayload, requirements) {
      const auth = (paymentPayload.payload as { authorization?: { from?: string } }).authorization;
      // Optional chaos switch to rehearse the public facilitator's intermittent failures.
      const failRate = Number(process.env.MOCK_SETTLE_FAIL_RATE ?? 0);
      if (failRate > 0 && Math.random() < failRate) {
        return {
          success: false,
          errorReason: "invalid_exact_evm_transaction_failed",
          transaction: "",
          network: requirements.network,
          payer: auth?.from,
        };
      }
      return {
        success: true,
        transaction: "0xmock" + randomBytes(30).toString("hex"),
        network: requirements.network,
        payer: auth?.from,
        amount: requirements.amount,
      };
    },

    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
        extensions: [],
        signers: { "eip155:*": ["0x000000000000000000000000000000000000dEaD"] },
      };
    },
  };
}
