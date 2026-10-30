import { z } from "zod";

// Every setting the server reads from the environment, validated once at startup. Invalid values abort the start
// with a message that names the variable, instead of failing later during a match.
const integer = (name: string, min: number, max: number, fallback: number) =>
  z.preprocess(
    value => (value === undefined || value === "" ? fallback : Number(value)),
    z
      .number({ error: `${name} must be an integer from ${min} to ${max}.` })
      .int(`${name} must be an integer from ${min} to ${max}.`)
      .min(min, `${name} must be an integer from ${min} to ${max}.`)
      .max(max, `${name} must be an integer from ${min} to ${max}.`),
  );
const optionalText = z
  .string()
  .optional()
  .transform(value => value?.trim() || undefined);

const schema = z.object({
  DATABASE_URL: z
    .string({ error: "DATABASE_URL with a MySQL database is required." })
    .regex(/^mysql:\/\//, "DATABASE_URL with a MySQL database is required."),
  REDIS_URL: optionalText,
  PARTY_REDIS_PREFIX: z
    .string()
    .default("party:dev")
    .refine(value => /^[a-zA-Z0-9:_-]{1,64}$/.test(value), "Invalid Redis namespace."),
  ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform(value =>
      value
        .split(",")
        .map(origin => origin.trim())
        .filter(Boolean),
    ),
  PARTY_MAINTENANCE: z
    .string()
    .default("0")
    .transform(value => value === "1"),
  PARTY_MAINTENANCE_MESSAGE: z.string().max(180, "PARTY_MAINTENANCE_MESSAGE is limited to 180 characters.").default(""),
  PARTY_API_REQUESTS_PER_MINUTE: integer("PARTY_API_REQUESTS_PER_MINUTE", 30, 10000, 240),
  PARTY_TRUST_PROXY_HOPS: integer("PARTY_TRUST_PROXY_HOPS", 0, 3, 0),
  PARTY_DRAIN_SECONDS: integer("PARTY_DRAIN_SECONDS", 0, 300, 45),
  PARTY_ADMIN_KEY: optionalText,
  PARTY_ADMIN_ALLOWED_IPS: z
    .string()
    .default("")
    .transform(value =>
      value
        .split(",")
        .map(entry => entry.trim())
        .filter(Boolean),
    ),
  PARTY_ADMIN_MAX_FAILURES: integer("PARTY_ADMIN_MAX_FAILURES", 1, 1000, 10),
  PARTY_ADMIN_LOCKOUT_SECONDS: integer("PARTY_ADMIN_LOCKOUT_SECONDS", 10, 86400, 900),
  PARTY_RENAME_COOLDOWN_HOURS: integer("PARTY_RENAME_COOLDOWN_HOURS", 0, 8760, 24),
  PARTY_NAME_BLOCKLIST: optionalText,
  PARTY_CONTENT_STAGE: optionalText,
  PARTY_CONTENT_BUNDLE: optionalText,
  PARTY_SEASON_CATALOG: optionalText,
  PARTY_EVENTS_CATALOG: optionalText,
  PARTY_MATCHMAKING_CATALOG: optionalText,
  PARTY_STORE_CATALOG: optionalText,
  PARTY_IAP_DEMO_PURCHASES: z
    .string()
    .optional()
    .refine(value => !value || value === "0" || value === "1", "PARTY_IAP_DEMO_PURCHASES must be 0 or 1."),
  PARTY_IAP_GOOGLE_SERVICE_ACCOUNT_FILE: optionalText,
  PARTY_IAP_GOOGLE_SERVICE_ACCOUNT_JSON: optionalText,
  PARTY_IAP_APPLE_ROOT_CERTS_DIR: optionalText,
  PARTY_IAP_APPLE_ONLINE_CHECKS: z
    .string()
    .default("1")
    .refine(value => value === "0" || value === "1", "PARTY_IAP_APPLE_ONLINE_CHECKS must be 0 or 1."),
  NODE_ENV: optionalText,
});

export interface ServerSettings {
  databaseUrl: string;
  redisUrl?: string;
  redisPrefix: string;
  /** Browser origins allowed to call the API and open sockets. Empty allows any origin (local development). */
  allowedOrigins: string[];
  maintenance: boolean;
  maintenanceMessage: string;
  apiRequestsPerMinute: number;
  trustProxyHops: number;
  /** On shutdown, running matches may finish for up to this long. */
  drainSeconds: number;
  /** Enables the admin endpoints and the GM console (/gm). Never sent to clients. */
  adminKey?: string;
  /** Addresses or CIDR ranges that may reach the admin surfaces; empty allows any address. */
  adminAllowedIps?: string[];
  /** Wrong admin keys from one address before it is locked out (default 10). */
  adminMaxFailures?: number;
  /** How long a lockout lasts, and the window that counts wrong keys (default 900 seconds). */
  adminLockoutSeconds?: number;
  /** Hours before a player may change their display name again (0 = no limit; default 24). */
  renameCooldownHours?: number;
  /** Extra forbidden name words, one per line; defaults to game_config/name-blocklist.txt when that exists. */
  nameBlocklistPath?: string;
  /** Where an uploaded content bundle is staged for the next restart. */
  contentStagePath?: string;
  /** Exported content bundle to run; defaults to the catalogs in game_config. */
  contentBundlePath?: string;
  /** Season policy file; defaults to game_config/season.json. */
  seasonCatalogPath?: string;
  /** Timed events; defaults to game_config/events.json. */
  eventsCatalogPath?: string;
  /** Matchmaking rules; defaults to party-matchmaking.json next to the content bundle, else in game_config. */
  matchmakingCatalogPath?: string;
  /** Store packs; defaults to game_config/party-store.json (a missing file means no store). */
  storeCatalogPath?: string;
  /** Accept store purchases without payment (the catalog must allow them too). Off when absent. */
  iapDemoPurchases?: boolean;
  /** Google Play Developer API service account key: a file, or the JSON itself. Never logged. */
  iapGoogleServiceAccountFile?: string;
  iapGoogleServiceAccountJson?: string;
  /** Folder of Apple root certificates (DER); defaults to certs/apple in the server root. */
  iapAppleRootCertsDir?: string;
  /** Check certificate revocation with Apple (OCSP) when verifying App Store receipts. Off when absent. */
  iapAppleOnlineChecks?: boolean;
}

export function loadSettings(source: NodeJS.ProcessEnv = process.env): ServerSettings {
  const result = schema.safeParse(source);
  if (!result.success) throw new Error(result.error.issues.map(issue => issue.message).join(" "));
  const env = result.data;
  return {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    redisPrefix: env.PARTY_REDIS_PREFIX,
    allowedOrigins: env.ALLOWED_ORIGINS,
    maintenance: env.PARTY_MAINTENANCE,
    maintenanceMessage: env.PARTY_MAINTENANCE_MESSAGE,
    apiRequestsPerMinute: env.PARTY_API_REQUESTS_PER_MINUTE,
    trustProxyHops: env.PARTY_TRUST_PROXY_HOPS,
    drainSeconds: env.PARTY_DRAIN_SECONDS,
    adminKey: env.PARTY_ADMIN_KEY,
    adminAllowedIps: env.PARTY_ADMIN_ALLOWED_IPS,
    adminMaxFailures: env.PARTY_ADMIN_MAX_FAILURES,
    adminLockoutSeconds: env.PARTY_ADMIN_LOCKOUT_SECONDS,
    renameCooldownHours: env.PARTY_RENAME_COOLDOWN_HOURS,
    nameBlocklistPath: env.PARTY_NAME_BLOCKLIST,
    contentStagePath: env.PARTY_CONTENT_STAGE,
    contentBundlePath: env.PARTY_CONTENT_BUNDLE,
    seasonCatalogPath: env.PARTY_SEASON_CATALOG,
    eventsCatalogPath: env.PARTY_EVENTS_CATALOG,
    matchmakingCatalogPath: env.PARTY_MATCHMAKING_CATALOG,
    storeCatalogPath: env.PARTY_STORE_CATALOG,
    // Demo purchases default to on outside production; production needs an explicit "1".
    iapDemoPurchases: env.PARTY_IAP_DEMO_PURCHASES
      ? env.PARTY_IAP_DEMO_PURCHASES === "1"
      : env.NODE_ENV !== "production",
    iapGoogleServiceAccountFile: env.PARTY_IAP_GOOGLE_SERVICE_ACCOUNT_FILE,
    iapGoogleServiceAccountJson: env.PARTY_IAP_GOOGLE_SERVICE_ACCOUNT_JSON,
    iapAppleRootCertsDir: env.PARTY_IAP_APPLE_ROOT_CERTS_DIR,
    iapAppleOnlineChecks: env.PARTY_IAP_APPLE_ONLINE_CHECKS === "1",
  };
}
