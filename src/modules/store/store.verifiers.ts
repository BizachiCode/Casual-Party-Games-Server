import { join } from "node:path";
import type { ServerSettings } from "../../config/env.js";
import { serverRoot } from "../../config/paths.js";
import { AppleAppStoreVerifier, loadAppleRootCertificates } from "./iap/apple-app-store.verifier.js";
import { GooglePlayVerifier, loadGoogleServiceAccount, type GoogleServiceAccount } from "./iap/google-play.verifier.js";
import type { IapStoreVerifier } from "./iap/iap.ports.js";

/**
 * The Google Play and App Store verifiers these settings call for. Credentials load on first use, so a server without
 * them still starts (its purchases answer IAP_STORE_UNAVAILABLE and stay pending on the phone until it is set up).
 */
export function createStoreVerifiers(settings: ServerSettings): IapStoreVerifier[] {
  let googleAccount: GoogleServiceAccount | null | undefined;
  let appleRoots: Buffer[] = [];
  const certificatesDirectory = settings.iapAppleRootCertsDir ?? join(serverRoot, "certs", "apple");
  return [
    new GooglePlayVerifier(() => {
      googleAccount ??= loadGoogleServiceAccount(
        settings.iapGoogleServiceAccountJson,
        settings.iapGoogleServiceAccountFile,
      );
      return googleAccount;
    }),
    new AppleAppStoreVerifier(() => {
      // Read again until some are found, so adding the certificates needs no restart.
      if (!appleRoots.length) appleRoots = loadAppleRootCertificates(certificatesDirectory);
      return appleRoots;
    }, settings.iapAppleOnlineChecks ?? false),
  ];
}
