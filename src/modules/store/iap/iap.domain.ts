import { createHash } from "node:crypto";
import { ApiError } from "../../../shared/errors.js";

/** Codes the client branches on. 4xx are permanent (the client drops the order), 409 pending and 503 are retried. */
export const IAP_ERRORS = {
  IAP_UNKNOWN_PRODUCT: { status: 400, message: "That product is not for sale." },
  IAP_RECEIPT_REJECTED: { status: 400, message: "The store receipt was not accepted." },
  IAP_PRODUCT_MISMATCH: { status: 400, message: "The receipt is for a different product." },
  IAP_RECEIPT_USED: { status: 409, message: "That purchase was already redeemed by another account." },
  IAP_ALREADY_OWNED: { status: 409, message: "You already own this." },
  IAP_DEMO_DISABLED: { status: 403, message: "Demo purchases are turned off." },
  IAP_PURCHASE_PENDING: { status: 409, message: "The purchase is still pending at the store." },
  IAP_STORE_UNAVAILABLE: { status: 503, message: "The store could not be reached. Try again later." },
} as const;

export type IapCode = keyof typeof IAP_ERRORS;

/** The error of a code. `detail` says why in the server log only; players never see it. */
export function iapError(code: IapCode, detail = ""): ApiError {
  if (detail) console.warn(`[store] ${code}: ${detail}`);
  return new ApiError(IAP_ERRORS[code].status, IAP_ERRORS[code].message, code);
}

export const rejected = (detail: string) => iapError("IAP_RECEIPT_REJECTED", detail);
export const storeUnavailable = (detail: string) => iapError("IAP_STORE_UNAVAILABLE", detail);

/** Store-wide id of one transaction: SHA-256 hex of `<store>:<id>` (tokens are long; the key has a fixed size). */
export function iapTransactionKey(store: string, id: string): string {
  return createHash("sha256").update(`${store}:${id}`).digest("hex");
}

/**
 * The account token handed to the store with a purchase (Apple `appAccountToken`, Google obfuscated account id): a UUID
 * derived from the user id, so a receipt can be tied to the account that paid without exposing the id.
 */
export function iapAccountToken(userId: string): string {
  const hex = createHash("sha256").update(`iap-account:${userId}`).digest("hex");
  // RFC 4122 layout (version 4, variant 10xx) so every store accepts it as a UUID.
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const groups = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    variant + hex.slice(17, 20),
    hex.slice(20, 32),
  ];
  return groups.join("-");
}
