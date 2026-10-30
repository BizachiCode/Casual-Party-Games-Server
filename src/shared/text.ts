/**
 * Player-written text (names, chat) without angle brackets or control characters (below U+0020), the same rule the
 * Unity client applies.
 */
export function cleanText(text: string): string {
  let result = "";
  for (const character of text) {
    if (character !== "<" && character !== ">" && character >= " ") result += character;
  }
  return result;
}

/**
 * The form display names are compared in: Unicode-normalised, lower case, single spaces. Two names with the same key
 * are the same name; the unique index on users.name_key keeps every display name to one account.
 */
export function nameKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
