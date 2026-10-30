import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ContentBundle, PartyContent } from "./content.types.js";
import { PROTOCOL, validateCatalogs } from "./content.validation.js";

// Byte-for-byte twin of Assets/CasualPartyMultiplayer/Core/Content/ContentBundle.cs: both sides hash the exact JSON
// text, so a bundle exported from Unity verifies here and the other way round (test:content-parity).

export const MAX_SECTION_BYTES = 1024 * 1024;
const REVISION_PREFIX = `party-v${PROTOCOL}`;

function requireValue(ok: unknown, path: string): asserts ok {
  if (!ok) throw new Error("Invalid content: " + path);
}

/** Replaces the single "revision" value in the gameplay JSON text. */
function stamp(json: string, revision: string): string {
  const pattern = /"revision"\s*:\s*"[^"]*"/g;
  requireValue(typeof json === "string" && [...json.matchAll(pattern)].length === 1, "exactly one gameplay revision");
  return json.replace(pattern, '"revision":"' + revision + '"');
}

export function checksum(gameplay: string, characters: string, goals: string): string {
  const hash = createHash("sha256").update("party-content-v1\n");
  for (const section of [gameplay, characters, goals]) {
    requireValue(typeof section === "string" && Buffer.byteLength(section) <= MAX_SECTION_BYTES, "section size/type");
    hash.update(Buffer.byteLength(section) + "\n").update(section, "utf8");
  }
  return hash.digest("hex");
}

/** Validates the catalogs, stamps the content revision into the gameplay JSON and checksums the release. */
export function packBundle(gameplayJson: string, charactersJson: string, goalsJson: string): ContentBundle {
  validateCatalogs(JSON.parse(gameplayJson), JSON.parse(charactersJson), JSON.parse(goalsJson));
  const revision =
    REVISION_PREFIX + "-" + checksum(stamp(gameplayJson, REVISION_PREFIX), charactersJson, goalsJson).slice(0, 12);
  gameplayJson = stamp(gameplayJson, revision);
  return {
    formatVersion: 1,
    gameplayJson,
    charactersJson,
    goalsJson,
    checksum: checksum(gameplayJson, charactersJson, goalsJson),
  };
}

export function verifyBundle(bundle: ContentBundle): PartyContent {
  requireValue(bundle?.formatVersion === 1 && /^[a-f0-9]{64}$/.test(bundle.checksum), "bundle version/checksum");
  requireValue(
    bundle.checksum === checksum(bundle.gameplayJson, bundle.charactersJson, bundle.goalsJson),
    "checksum mismatch",
  );
  const content = validateCatalogs(
    JSON.parse(bundle.gameplayJson),
    JSON.parse(bundle.charactersJson),
    JSON.parse(bundle.goalsJson),
  );
  requireValue(
    packBundle(bundle.gameplayJson, bundle.charactersJson, bundle.goalsJson).gameplayJson === bundle.gameplayJson,
    "revision mismatch",
  );
  return content;
}

export function readBundle(path: string): PartyContent & { bundle: ContentBundle } {
  const data = readFileSync(path);
  requireValue(data.length <= 4 * MAX_SECTION_BYTES, "bundle size");
  const bundle = JSON.parse(data.toString("utf8")) as ContentBundle;
  return { bundle, ...verifyBundle(bundle) };
}

/** Writes through a temporary file and a rename, so readers never see a half-written file. */
export function atomicWrite(path: string, data: string | Buffer): void {
  path = resolve(path);
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temp, data, { flag: "wx", mode: 0o644 });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** Writes several files; if one fails, the ones already written are restored. */
export function writeTransaction(entries: [path: string, data: string][]): void {
  requireValue(new Set(entries.map(([path]) => resolve(path))).size === entries.length, "duplicate export path");
  const previous = entries.map(([path]) => (existsSync(path) ? readFileSync(path) : null));
  let written = 0;
  try {
    for (const [path, data] of entries) {
      atomicWrite(path, data);
      written++;
    }
  } catch (error) {
    for (let i = written - 1; i >= 0; i--) {
      if (previous[i] === null) unlinkSync(entries[i][0]);
      else atomicWrite(entries[i][0], previous[i]);
    }
    throw error;
  }
}
