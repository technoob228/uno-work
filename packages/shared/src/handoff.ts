/**
 * Handoff preamble markers, shared between the server (which builds seeds in
 * `orchestration/handoff.ts`) and the web app (which recognises a seed in the
 * chat timeline and renders it collapsed). Strings live here once so the two
 * sides cannot drift apart.
 */

export const HANDOFF_PREAMBLE_START =
  "[Context: this conversation continues an earlier thread. Recent history, oldest first:]";
export const HANDOFF_PREAMBLE_END = "[End of context. Reply to the message below.]";

/**
 * Marker the Telegram connector used before the preamble became shared. Kept
 * so preambles already persisted in old threads are still recognised.
 */
export const LEGACY_TELEGRAM_HANDOFF_PREAMBLE_START =
  "[Context: this Telegram chat previously ran in another thread (the harness/model was switched). Recent history, oldest first:]";

export const HANDOFF_PREAMBLE_STARTS: ReadonlyArray<string> = [
  HANDOFF_PREAMBLE_START,
  LEGACY_TELEGRAM_HANDOFF_PREAMBLE_START,
];

/** First line of a "Continue on <machine>" seed: `[Continued from <machine>] …`. */
export const CONTINUE_SEED_PREFIX = "[Continued from ";
