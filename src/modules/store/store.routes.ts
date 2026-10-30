import { Router } from "express";
import { z } from "zod";
import { optionalPlayer, requirePlayer } from "../account/account.middleware.js";
import type { AccountService } from "../account/account.service.js";
import { iapError } from "./iap/iap.domain.js";
import { IapStore } from "./iap/iap.ports.js";
import type { StoreService } from "./store.service.js";

/** Strings the client leaves out arrive as "" (JsonUtility), so "" counts as absent. */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform(value => value || undefined);

const purchaseBody = z.object({
  productId: z.string().min(1).max(150),
  receipt: z.object({
    store: z.enum([IapStore.GooglePlay, IapStore.AppleAppStore, IapStore.Demo]),
    transactionId: optionalText(200),
    purchaseToken: optionalText(4096),
    // A StoreKit 2 signed transaction is a JWS of about 1.5 KB.
    signedTransaction: optionalText(16384),
  }),
});

/** /api/store: the packs (public), a pre-purchase check and the purchase itself. */
export function storeRoutes(store: StoreService, accounts: AccountService): Router {
  const router = Router();
  const signedIn = requirePlayer(accounts, "Sign in to buy.");
  router.get("/", optionalPlayer(accounts), async (req, res) => {
    res.json(await store.listing(req.player?.id));
  });
  router.get("/check", signedIn, async (req, res) => {
    const productId = typeof req.query.productId === "string" ? req.query.productId : "";
    res.json(await store.check(req.player.id, productId));
  });
  router.post("/purchase", signedIn, async (req, res) => {
    const body = z.object({ productId: z.string().min(1).max(150) }).safeParse(req.body ?? {});
    if (!body.success) throw iapError("IAP_UNKNOWN_PRODUCT", "no product id");
    const parsed = purchaseBody.safeParse(req.body);
    if (!parsed.success) throw iapError("IAP_RECEIPT_REJECTED", "malformed receipt");
    res.json(await store.purchase(req.player.id, parsed.data.productId, parsed.data.receipt));
  });
  return router;
}
