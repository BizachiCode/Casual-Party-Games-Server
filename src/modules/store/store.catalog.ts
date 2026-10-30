import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gameConfigDirectory } from "../../config/paths.js";

/** One Stars pack (or bundle) sold in the platform stores. */
export interface StoreProductDefinition {
  /** The client's key (`store_pack_<id>` in the localization table). */
  id: string;
  /** The store SKU, the same in Google Play and App Store Connect. */
  productId: string;
  stars: number;
  /** Extra Stars on top of `stars` (the "bonus" a bigger pack gives). */
  bonusStars: number;
  shards: number;
  /** Shown to players; the stores charge their own localized price. */
  priceUsd: number;
  /** A non-consumable (a starter bundle): each account buys it once. */
  oncePerAccount: boolean;
  /** "" or a client label key such as "best_value". */
  badge: string;
}

/** game_config/party-store.json, written by Unity's "Tools > Casual Party > Export to Server". */
export interface StoreCatalog {
  version: 1;
  /** Accept purchases without payment (also needs PARTY_IAP_DEMO_PURCHASES on the server). */
  demoPurchases: boolean;
  /** Accept Apple Sandbox and Google license-tester purchases. */
  allowTestPurchases: boolean;
  googlePackageName: string;
  appleBundleId: string;
  appleAppId: number;
  products: StoreProductDefinition[];
}

/** No store: the catalog of a server that has no party-store.json. */
export const EMPTY_STORE_CATALOG: StoreCatalog = {
  version: 1,
  demoPurchases: false,
  allowTestPurchases: false,
  googlePackageName: "",
  appleBundleId: "",
  appleAppId: 0,
  products: [],
};

const MAX_PRODUCTS = 100;
const MAX_AMOUNT = 100_000_000;
const ID_PATTERN = /^[a-z0-9_]{2,40}$/;
const SKU_PATTERN = /^[a-z0-9_.]{2,150}$/;
const BADGE_PATTERN = /^[a-z_]{1,20}$/;

/** game_config/party-store.json, or the file in PARTY_STORE_CATALOG. A missing file means no store. */
export function loadStoreCatalog(path = join(gameConfigDirectory, "party-store.json")): StoreCatalog {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return structuredClone(EMPTY_STORE_CATALOG);
    throw error;
  }
  return JSON.parse(text);
}

function invalid(subject: string, detail: string): never {
  throw new Error("Invalid store catalog: " + subject + " " + detail);
}

const integer = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

function validateProduct(product: StoreProductDefinition): void {
  const subject = 'product "' + product?.id + '"';
  if (typeof product?.id !== "string" || !ID_PATTERN.test(product.id))
    invalid(subject, "needs an id of a-z, 0-9 and _ (2 to 40 characters).");
  if (typeof product.productId !== "string" || !SKU_PATTERN.test(product.productId))
    invalid(subject, "needs a productId of a-z, 0-9, _ and . (2 to 150 characters).");
  for (const field of ["stars", "bonusStars", "shards"] as const) {
    if (!integer(product[field], 0, MAX_AMOUNT)) invalid(subject, field + " must be an integer from 0 to 100000000.");
  }
  if (product.stars + product.bonusStars + product.shards <= 0) invalid(subject, "must give Stars or shards.");
  if (typeof product.priceUsd !== "number" || !(product.priceUsd >= 0.01 && product.priceUsd <= 999.99))
    invalid(subject, "priceUsd must be from 0.01 to 999.99.");
  if (typeof product.oncePerAccount !== "boolean") invalid(subject, "oncePerAccount must be true or false.");
  if (typeof product.badge !== "string" || (product.badge !== "" && !BADGE_PATTERN.test(product.badge)))
    invalid(subject, "badge must be empty or a-z and _ (up to 20 characters).");
}

/** Throws unless the catalog is well formed: unique ids and SKUs, positive grants, plausible prices. */
export function validateStoreCatalog(catalog: StoreCatalog): void {
  if (catalog?.version !== 1 || !Array.isArray(catalog.products) || catalog.products.length > MAX_PRODUCTS)
    invalid("catalog", "needs version 1 and at most " + MAX_PRODUCTS + " products.");
  if (typeof catalog.demoPurchases !== "boolean" || typeof catalog.allowTestPurchases !== "boolean")
    invalid("catalog", "needs demoPurchases and allowTestPurchases as true or false.");
  for (const field of ["googlePackageName", "appleBundleId"] as const) {
    if (typeof catalog[field] !== "string" || catalog[field].length > 150) invalid("catalog", field + " must be text.");
  }
  if (!integer(catalog.appleAppId, 0, Number.MAX_SAFE_INTEGER)) invalid("catalog", "appleAppId must be an integer.");
  const ids = new Set<string>();
  const skus = new Set<string>();
  for (const product of catalog.products) {
    validateProduct(product);
    if (ids.has(product.id)) invalid('product "' + product.id + '"', "appears twice.");
    if (skus.has(product.productId)) invalid('product "' + product.id + '"', "reuses the productId of another.");
    ids.add(product.id);
    skus.add(product.productId);
  }
}
