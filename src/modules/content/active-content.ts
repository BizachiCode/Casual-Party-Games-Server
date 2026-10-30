import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gameConfigDirectory } from "../../config/paths.js";
import { readBundle } from "./content-bundle.js";
import type { PartyContent } from "./content.types.js";
import { validateCatalogs } from "./content.validation.js";

/**
 * The content this process runs, immutable until restart. With a bundle path (PARTY_CONTENT_BUNDLE) it is that exported
 * release; otherwise the catalogs in game_config, which Unity's "Tools > Casual Party > Export to Server" writes.
 * Invalid content aborts startup.
 */
export function loadContent(bundlePath?: string): PartyContent {
  if (bundlePath) {
    const { config, characterCatalog, goalCatalog } = readBundle(bundlePath);
    return { config, characterCatalog, goalCatalog };
  }
  const read = (name: string) => JSON.parse(readFileSync(join(gameConfigDirectory, `party-${name}.json`), "utf8"));
  return validateCatalogs(read("courses"), read("characters"), read("goals"));
}
