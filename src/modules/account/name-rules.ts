import { existsSync, readFileSync } from "node:fs";
import { ApiError } from "../../shared/errors.js";
import { cleanText } from "../../shared/text.js";

// Display name rules shared by sign-up, guest sign-in, the rename endpoint and the GM console.

export const NAME_MIN_LENGTH = 3;
export const NAME_MAX_LENGTH = 20;

// Words a display name may not contain. The list is intentionally offensive content for filtering (common slurs and
// profanity in English, Portuguese and Spanish); it is stored as base64 so the source stays readable. Operators add
// their own words in game_config/name-blocklist.txt (see loadNameRules).
const BUILT_IN_WORDS = [
  "YXJyb21iYWRvCmFzc2hvbGUKYmFzdGFyZApiaXRjaApibG93am9iCmJ1Y2V0YQpidWxsc2hpdApjYWJyb24KY2FyYWxobwpjaGlu",
  "Z2FkYQpjaGluZ2FyCmNoaW5nYXR1bWFkcmUKY2hpbmsKY29jawpjdWxlcm8KY3VtCmN1bnQKY3V6YW8KZGljawpkaWNraGVhZApk",
  "aWxkbwpmYWcKZmFnZ290CmZvZGEKZm9kYXNlCmZvZGVyCmZ1Y2sKZnVja2VyCmZ1Y2tpbmcKZ2lsaXBvbGxhcwpoaWp1ZXB1dGEK",
  "aGl0bGVyCmppenoKam9kZXIKa2lrZQptYXJpY2EKbWFyaWNvbgptZXJkYQptaWVyZGEKbW90aGVyZnVja2VyCm5hemkKbmlnZ2EK",
  "bmlnZ2VyCnBlbmRlam8KcGVuaXMKcGlyb2NhCnBvbGxhCnBvcm4KcG9ybm8KcG9ycmEKcHVuaGV0YQpwdXNzeQpwdXRhCnB1dGlu",
  "aGEKcHV0bwpyYXBlCnJhcGlzdApyZXRhcmQKcmV0YXJkZWQKc2hpdApzbHV0CnNwaWMKdHJhbm55CnR3YXQKdmFnYWJ1bmRhCnZh",
  "Z2luYQp2ZXJnYQp2aWFkbwp3YW5rZXIKd2V0YmFjawp3aG9yZQp6b3JyYQ==",
];

const LEETSPEAK: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
};

/** Lower case, accents folded and the usual digit and symbol substitutions undone. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[013457@$]/g, character => LEETSPEAK[character] ?? character);
}

/** Letters repeated in a row count once ("fuuuck" is "fuck"). */
const collapse = (word: string) => word.replace(/([a-z])\1+/g, "$1");

/** The words of a blocklist file: one per line, blank lines and `#` comments skipped. */
export function readBlocklist(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));
}

/** A display name as stored: player text without angle brackets or control characters, trimmed, single spaces. */
export function cleanName(raw: unknown): string {
  return cleanText(typeof raw === "string" ? raw : "")
    .trim()
    .replace(/\s+/g, " ");
}

/** The rules a display name must follow: its shape (length, letters) and the blocklist. */
export class NameRules {
  private readonly words = new Set<string>();
  private readonly collapsed = new Set<string>();

  constructor(extraWords: string[] = []) {
    const builtIn = readBlocklist(Buffer.from(BUILT_IN_WORDS.join(""), "base64").toString("utf8"));
    for (const word of [...builtIn, ...extraWords]) {
      const letters = fold(word).replace(/[^a-z]/g, "");
      if (!letters) continue;
      this.words.add(letters);
      this.collapsed.add(collapse(letters));
    }
  }

  /** Whether a word of the name is on the blocklist: whole words, also split at capitals, digits and symbols. */
  blocked(name: string): boolean {
    const spaced = name
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2");
    return fold(spaced)
      .split(/[^a-z]+/)
      .some(token => token && (this.words.has(token) || this.collapsed.has(collapse(token))));
  }

  /** The cleaned name, or the 400 that says why it is refused. */
  check(raw: unknown): string {
    const name = cleanName(raw);
    const length = [...name].length;
    if (length < NAME_MIN_LENGTH || length > NAME_MAX_LENGTH)
      throw new ApiError(
        400,
        `The name must have ${NAME_MIN_LENGTH} to ${NAME_MAX_LENGTH} characters.`,
        "NAME_INVALID",
      );
    if (!/[\p{L}\p{N}]/u.test(name)) throw new ApiError(400, "The name needs a letter or a digit.", "NAME_INVALID");
    if (/^[\p{N} ]+$/u.test(name)) throw new ApiError(400, "The name cannot be only numbers.", "NAME_INVALID");
    if (this.blocked(name)) throw new ApiError(400, "That name is not allowed.", "NAME_NOT_ALLOWED");
    return name;
  }

  /** The cleaned name when it passes every rule, else `fallback`. */
  orElse(raw: unknown, fallback: string): string {
    try {
      return this.check(raw);
    } catch (error) {
      if (error instanceof ApiError) return fallback;
      throw error;
    }
  }
}

/**
 * The built-in words plus the operator's file: one word per line, `#` starts a comment. `file` (PARTY_NAME_BLOCKLIST)
 * must exist when it was set; the default game_config/name-blocklist.txt may be missing.
 */
export function loadNameRules(file: string | undefined, defaultFile: string): NameRules {
  const path = file ?? defaultFile;
  if (!existsSync(path)) {
    if (file) throw new Error(`PARTY_NAME_BLOCKLIST: ${file} does not exist.`);
    return new NameRules();
  }
  return new NameRules(readBlocklist(readFileSync(path, "utf8")));
}
