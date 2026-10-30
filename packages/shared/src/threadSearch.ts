/**
 * Message search, the parts the server and the web app must agree on: how a
 * query splits into tokens, what counts as a match, and how a match shows.
 * Adapted from upstream t3code `paletteSearch.ts` and `threadSearch.ts`.
 */

const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const WRAPPING_QUOTES = /^\s*["'`“”‘’]+|["'`“”‘’]+\s*$/g;
const CURLY_APOSTROPHES = /[‘’]/g;

/** A trigram index cannot look for less; two-letter words only narrow hits. */
const MESSAGE_TOKEN_MIN_LENGTH = 3;
/** A token shorter than this must start a word: "fts" is not in "drafts". */
const MESSAGE_WORD_START_LENGTH = 4;
const WHOLE_WORD = 1;
const WORD_START = 0.8;
const MID_WORD = 0.3;
const PHRASE_BONUS = 0.25;

const SNIPPET_LENGTH = 240;
/** Result rows show one line, so the match must sit near the start. */
const SNIPPET_LEAD = 24;
/** A thread shows a link as its text, so the address is not searched. */
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\([^)\s]*\)/g;

export function foldThreadSearchCase(text: string): string {
  const lowered = text.toLowerCase().replace(/ς/g, "σ");
  if (lowered.length === text.length) return lowered;
  // "İ" lowers to two units, which would shift every offset after it.
  let folded = "";
  for (const character of text) {
    const lower = character.toLowerCase().replace(/ς/g, "σ");
    folded += lower.length === character.length ? lower : character;
  }
  return folded;
}

function scanOccurrences(text: string, query: string, offsets?: number[]): number {
  if (text.length === 0 || query.length === 0) return 0;
  const haystack = foldThreadSearchCase(text);
  const needle = foldThreadSearchCase(query);
  let count = 0;
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const offset = haystack.indexOf(needle, cursor);
    if (offset === -1) break;
    offsets?.push(offset);
    count += 1;
    cursor = offset + needle.length;
  }
  return count;
}

export function countThreadSearchOccurrences(text: string, query: string): number {
  return scanOccurrences(text, query);
}

export function findThreadSearchOccurrences(text: string, query: string): number[] {
  const offsets: number[] = [];
  scanOccurrences(text, query, offsets);
  return offsets;
}

/** Messages as they read: a link is its label. */
export function threadSearchVisibleText(text: string): string {
  return text.replace(MARKDOWN_LINK, "$1");
}

/** Every `long` token must match; `short` ones only narrow. No long token, no search. */
export function messageSearchTokens(query: string): {
  readonly long: ReadonlyArray<string>;
  readonly short: ReadonlyArray<string>;
} {
  const tokens = query
    .replace(WRAPPING_QUOTES, "")
    .replace(CURLY_APOSTROPHES, "'")
    .normalize("NFC")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const isLong = (token: string) => Array.from(token).length >= MESSAGE_TOKEN_MIN_LENGTH;
  return { long: tokens.filter(isLong), short: tokens.filter((token) => !isLong(token)) };
}

/** The most telling word of a query; "" when it has none to look up. */
export function longestMessageSearchToken(query: string): string {
  return messageSearchTokens(query).long.reduce(
    (longest, token) => (token.length > longest.length ? token : longest),
    "",
  );
}

/** A query for the trigram index: every token as a quoted phrase, or null. */
export function messageSearchMatchExpression(query: string): string | null {
  const { long } = messageSearchTokens(query);
  return long.length === 0
    ? null
    : long.map((token) => `"${token.replaceAll('"', '""')}"`).join(" ");
}

/** Where a word begins: camelCase and digits count, as they read that way. */
function startsWordAt(text: string, index: number): boolean {
  const current = text[index] ?? "";
  if (!ALPHANUMERIC.test(current)) return true;
  const before = text[index - 1] ?? "";
  if (!ALPHANUMERIC.test(before)) return true;
  return before === before.toLowerCase() && current !== current.toLowerCase();
}

function endsWordAt(text: string, end: number): boolean {
  return end >= text.length || !ALPHANUMERIC.test(text[end] ?? "") || startsWordAt(text, end);
}

function bestTokenMatch(
  text: string,
  folded: string,
  token: string,
): { readonly quality: number; readonly offset: number } | null {
  let best: { quality: number; offset: number } | null = null;
  for (let index = folded.indexOf(token); index !== -1; index = folded.indexOf(token, index + 1)) {
    const quality = !startsWordAt(text, index)
      ? MID_WORD
      : endsWordAt(text, index + token.length)
        ? WHOLE_WORD
        : WORD_START;
    if (best === null || quality > best.quality) best = { quality, offset: index };
    if (quality === WHOLE_WORD) break;
  }
  return best;
}

export interface MessageSearchGrade {
  readonly quality: number;
  /** Where a snippet should start to show the match. */
  readonly offset: number;
}

/**
 * Grades messages against a query so a whole word beats a word's middle, and
 * rejects what the index only found by trigrams: `null` when a token is
 * missing, or a short one never starts a word. Prepared once per query, since
 * the server grades many hits for it.
 */
export function messageSearchGrader(query: string): (text: string) => MessageSearchGrade | null {
  const { long, short } = messageSearchTokens(query);
  const tokens = [...long, ...short].map((token) => ({
    token: foldThreadSearchCase(token),
    mustStartWord: Array.from(token).length < MESSAGE_WORD_START_LENGTH,
    grades: long.includes(token),
  }));
  const phrase = tokens.length > 1 ? tokens.map(({ token }) => token).join(" ") : null;
  return (text) => {
    const folded = foldThreadSearchCase(text).replace(CURLY_APOSTROPHES, "'");
    let quality: number = WHOLE_WORD;
    let offset = Number.POSITIVE_INFINITY;
    for (const { token, mustStartWord, grades } of tokens) {
      const found = bestTokenMatch(text, folded, token);
      if (found === null) return null;
      if (found.quality === MID_WORD && mustStartWord) return null;
      if (grades) quality = Math.min(quality, found.quality);
      offset = Math.min(offset, found.offset);
    }
    const together = phrase === null ? -1 : folded.replace(/\s+/g, " ").indexOf(phrase);
    if (together !== -1) {
      const exact = folded.indexOf(phrase ?? "");
      return { quality: quality + PHRASE_BONUS, offset: exact === -1 ? offset : exact };
    }
    return { quality, offset };
  };
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Up to 240 characters from a few words before the match, on one line. */
export function buildThreadSearchSnippet(text: string, matchStart: number): string {
  let start = Math.max(0, matchStart - SNIPPET_LEAD);
  const wordStart = text.slice(start, matchStart).search(/\s/);
  if (start > 0 && wordStart !== -1) start += wordStart + 1;
  // Cut between characters, not inside an emoji's surrogate pair.
  if (isLowSurrogate(text.charCodeAt(start))) start += 1;
  // Collapsing whitespace shortens the text, so read more of it.
  const rawEnd = Math.min(text.length, start + SNIPPET_LENGTH * 2);
  const shown = text
    .slice(start, rawEnd)
    .replace(/\*\*|`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  let end = Math.min(shown.length, SNIPPET_LENGTH - 2);
  if (isLowSurrogate(shown.charCodeAt(end))) end -= 1;
  const cut = end < shown.length || rawEnd < text.length;
  return `${start > 0 ? "…" : ""}${shown.slice(0, end)}${cut ? "…" : ""}`;
}

/** Which parts of `text` to highlight for `query`, for a one-line result. */
export function threadSearchHighlightParts(
  text: string,
  query: string,
): ReadonlyArray<{ readonly text: string; readonly match: boolean }> {
  const folded = foldThreadSearchCase(text);
  const ranges: Array<readonly [number, number]> = [];
  for (const token of messageSearchTokens(query).long) {
    const needle = foldThreadSearchCase(token);
    for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + 1)) {
      ranges.push([at, at + needle.length]);
    }
  }
  ranges.sort((left, right) => left[0] - right[0]);
  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    if (from > cursor) parts.push({ text: text.slice(cursor, from), match: false });
    parts.push({ text: text.slice(from, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts;
}
