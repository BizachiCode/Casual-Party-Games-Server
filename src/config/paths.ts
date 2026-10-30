import { fileURLToPath } from "node:url";
import { join } from "node:path";

// src/config and build/config sit at the same depth, so these resolve alike in development and production.
export const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
export const repositoryRoot = join(serverRoot, "..");

/**
 * The game's content: courses, characters, goals and matchmaking rules (written by Unity's "Tools > Casual Party >
 * Export to Server"), plus the server-only season and event policies.
 */
export const gameConfigDirectory = join(serverRoot, "game_config");
/** Default output of `npm run content -- export`. */
export const exportedBundlePath = join(repositoryRoot, "Exports", "Server", "party-bundle.json");
