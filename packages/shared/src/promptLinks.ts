/**
 * Prompt links: a link opens Work with a prompt in a new chat's box (upstream
 * `shared/promptLinks`, without repo / pull request / model). A link never
 * runs anything: it fills a draft, the person reads it and presses Send.
 */
export const PROMPT_LINK_MAX_PROMPT_LENGTH = 8_000;
export const PROMPT_LINK_SCHEME = "uno-work";

export interface LinkedPrompt {
  readonly text: string;
  readonly hiddenCharacters: number;
}

export type PromptLinkResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

// Hidden characters let models read instructions invisible to the person
// reviewing the prompt. U+FFFC too: the composer's own placeholder for a
// terminal excerpt, a link must not be able to fake one.
const HIDDEN_CHARACTERS =
  // oxlint-disable-next-line no-misleading-character-class -- these are the characters it removes.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0D\uFEFF\uFFA0\uFFF0-\uFFFC\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/gu;
const isEmojiPart = (codePoint: number | undefined) =>
  codePoint !== undefined &&
  ((codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2190 && codePoint <= 0x2bff) ||
    codePoint === 0xfe0f);

export function sanitizeLinkedPrompt(raw: string): LinkedPrompt {
  let hiddenCharacters = 0;
  const visible = Array.from(
    raw.replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(HIDDEN_CHARACTERS, () => {
      hiddenCharacters++;
      return "";
    }),
  );
  const text = visible
    .filter((character, index) => {
      if (character !== "\u200D") return true;
      const kept =
        isEmojiPart(visible[index - 1]?.codePointAt(0)) &&
        isEmojiPart(visible[index + 1]?.codePointAt(0));
      if (!kept) hiddenCharacters++;
      return kept;
    })
    .join("");
  return { text: text.trim(), hiddenCharacters };
}

/** Reads `?prompt=` from a link's query, raw: routers turn `prompt=123` into a number. */
export function parsePromptLink(search: string): PromptLinkResult<LinkedPrompt> {
  const raw = new URLSearchParams(search).get("prompt");
  if (raw === null) return { ok: false, error: "This link has no prompt." };
  if (raw.length > PROMPT_LINK_MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      error: `This prompt is longer than ${PROMPT_LINK_MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters, so Work didn't open it.`,
    };
  }
  const prompt = sanitizeLinkedPrompt(raw);
  if (prompt.text.length > 0) return { ok: true, value: prompt };
  return {
    ok: false,
    error:
      prompt.hiddenCharacters > 0
        ? "This prompt had only hidden characters, so it may be malicious. Work didn't open it."
        : "This link has no prompt.",
  };
}

/**
 * The app path for `uno-work://new?prompt=\u2026`; null for anything else. The
 * query goes through URLSearchParams: only `prompt` survives, so a link can't
 * reach any other route or setting.
 */
export function promptLinkAppPath(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== `${PROMPT_LINK_SCHEME}:` || url.host !== "new") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  const prompt = url.searchParams.get("prompt");
  if (prompt === null) return null;
  return `/new?${new URLSearchParams({ prompt }).toString()}`;
}
