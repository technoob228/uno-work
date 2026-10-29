/**
 * Splitting a long assistant reply into chat-sized messages without losing
 * text, plus the short "still on it" note a connector sends during a long
 * turn — shared by the Telegram and Slack connectors.
 *
 * A reply used to be cut at the chat limit (`text.slice(0, 4000)`): whatever
 * came after was gone. {@link splitReplyText} cuts at the best boundary it can
 * find (paragraph, line, sentence, word, then hard) and keeps fenced code
 * blocks balanced across parts, so each part renders on its own.
 *
 * @module manager/connectorReplyText
 */

const FENCE_LINE = /^```[^`]*$/;

/** Where to cut `text` so the head is at most `limit` chars, preferring natural breaks. */
const findCut = (text: string, limit: number): number => {
  if (text.length <= limit) return text.length;
  const window = text.slice(0, limit);
  // Never cut so early that the part is mostly empty.
  const floor = Math.floor(limit * 0.5);
  for (const separator of ["\n\n", "\n", ". ", "! ", "? ", "; ", ", ", " "]) {
    const index = window.lastIndexOf(separator);
    if (index >= floor) return index + separator.length;
  }
  // No break at all: a hard cut, but never between the halves of a surrogate pair.
  const code = text.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
};

/** The fence opener line still open at the end of `text`, or null. */
const openFenceAtEnd = (text: string): string | null => {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    if (FENCE_LINE.test(line)) open = open === null ? line : null;
  }
  return open;
};

/**
 * Split `text` into parts of at most `limit` characters (UTF-16 units, what
 * Telegram and Slack count). Joining the parts gives back every word of the
 * input; only whitespace at the cuts and the fence lines added to keep code
 * blocks balanced differ.
 */
export const splitReplyText = (text: string, limit: number): ReadonlyArray<string> => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= limit) return [trimmed];
  // Room for a reopened fence line at the head and a closing fence at the tail.
  const FENCE_RESERVE = 16;
  const parts: Array<string> = [];
  let rest = trimmed;
  let reopen: string | null = null;
  while (rest.length > 0) {
    const prefix = reopen === null ? "" : `${reopen}\n`;
    const budget = Math.max(1, limit - prefix.length - FENCE_RESERVE);
    if (prefix.length + rest.length <= limit && openFenceAtEnd(prefix + rest) === null) {
      parts.push(prefix + rest);
      break;
    }
    const cut = findCut(rest, budget);
    let head = prefix + rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).replace(/^\s+/, "");
    const open = openFenceAtEnd(head);
    if (open !== null && rest.length > 0) {
      head = `${head}\n\`\`\``;
      reopen = open;
    } else {
      reopen = null;
    }
    if (head.trim().length > 0) parts.push(head);
  }
  return parts;
};

export type ReplyLanguage = "ru" | "en";

/**
 * One phone screen of a chat message, in characters. A Uno answer longer
 * than {@link SCREEN_MAX_CHARS} is cut to about {@link SCREEN_CUT_CHARS}
 * with a pointer to the whole answer (Misha 29.10: "два гигантских
 * сообщения с путями к файлам — непонятно"). The cut is a safety net: the
 * instructions already ask for one screen.
 */
export const SCREEN_MAX_CHARS = 1_100;
export const SCREEN_CUT_CHARS = 900;

/**
 * `text` as it goes to a phone: unchanged when it fits one screen, else its
 * head (cut at a paragraph / line / sentence) and one line saying where the
 * rest is — the Uno chat in Uno Work (`moreUrl`, the person's own address
 * when known).
 */
export const fitReplyToScreen = (
  text: string,
  input: { readonly language: ReplyLanguage; readonly moreUrl: string },
): { readonly text: string; readonly cut: boolean } => {
  const trimmed = text.trim();
  if (trimmed.length <= SCREEN_MAX_CHARS) return { text: trimmed, cut: false };
  let head = trimmed.slice(0, findCut(trimmed, SCREEN_CUT_CHARS)).trimEnd();
  // A half table or list heading at the cut reads as noise: drop a dangling header line.
  head = head.replace(/\n[^\n]{0,40}:\s*$/, "").trimEnd();
  if (openFenceAtEnd(head) !== null) head = `${head}\n\`\`\``;
  const more =
    input.language === "ru"
      ? `…дальше — в чате Uno в Uno Work: ${input.moreUrl}`
      : `…the rest is in the Uno chat in Uno Work: ${input.moreUrl}`;
  return { text: `${head}\n\n${more}`, cut: true };
};

/**
 * The language to talk to the person in: the script of what they wrote
 * wins (a Russian message gets a Russian note even from an English client),
 * then the client's language code, then English.
 */
export const detectReplyLanguage = (
  text: string,
  languageCode: string | null | undefined,
): ReplyLanguage => {
  const cyrillic = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const latin = (text.match(/[a-z]/gi) ?? []).length;
  if (cyrillic > 0 && cyrillic >= latin / 2) return "ru";
  if (latin > 0) return "en";
  const code = (languageCode ?? "").toLowerCase();
  return code.startsWith("ru") || code.startsWith("uk") || code.startsWith("be") ? "ru" : "en";
};

const minutesWord = (minutes: number, language: ReplyLanguage): string => {
  if (language === "en") return minutes === 1 ? "minute" : "minutes";
  const mod10 = minutes % 10;
  const mod100 = minutes % 100;
  if (mod10 === 1 && mod100 !== 11) return "минуту";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "минуты";
  return "минут";
};

const formatElapsed = (elapsedMs: number, language: ReplyLanguage): string => {
  const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
  if (minutes < 90) return `${minutes} ${minutesWord(minutes, language)}`;
  const hours = Math.round(minutes / 6) / 10;
  return language === "ru" ? `${String(hours).replace(".", ",")} ч` : `${hours} h`;
};

/**
 * The one short note a long turn sends now and then: no "check the app",
 * just that the work goes on and the answer will come here.
 */
export const progressNoteText = (input: {
  readonly language: ReplyLanguage;
  readonly elapsedMs: number;
  /** The first note says it will answer here; later ones only say it still works. */
  readonly first: boolean;
}): string => {
  const elapsed = formatElapsed(input.elapsedMs, input.language);
  if (input.language === "ru") {
    return input.first
      ? `Работаю над этим уже ${elapsed} — задача долгая. Ответ пришлю сюда, как закончу.`
      : `Всё ещё работаю (${elapsed}). Ответ пришлю сюда.`;
  }
  return input.first
    ? `Working on it for ${elapsed} now — it's a long one. I'll send the answer here when I'm done.`
    : `Still working on it (${elapsed}). The answer will come here.`;
};

/**
 * Minutes after the request when a progress note is due: the first after a
 * few minutes, then ever less often so an hours-long turn never spams.
 */
export const PROGRESS_NOTE_SCHEDULE_MS: ReadonlyArray<number> = [
  3 * 60_000,
  15 * 60_000,
  45 * 60_000,
  2 * 60 * 60_000,
];
/** After the schedule runs out: one note every this long. */
export const PROGRESS_NOTE_REPEAT_MS = 2 * 60 * 60_000;

/** When the `sent`-th progress note (0-based) is due, in ms after the request. */
export const progressNoteDueAfterMs = (sent: number): number => {
  const scheduled = PROGRESS_NOTE_SCHEDULE_MS[sent];
  if (scheduled !== undefined) return scheduled;
  const last = PROGRESS_NOTE_SCHEDULE_MS.at(-1) ?? 0;
  return last + (sent - PROGRESS_NOTE_SCHEDULE_MS.length + 1) * PROGRESS_NOTE_REPEAT_MS;
};
