/**
 * A long think, made visible (agent-flow pass 25.10, item 4).
 *
 * Smart (MiMo) on a big task reasoned for 14k tokens — 5 min 43 s — before
 * its first step, and the chat said only "Thinking · 5m · still working": the
 * reasoning streamed from the first second, but nothing showed it. Now a
 * reasoning stream that goes on for a while turns into one quiet "thinking"
 * row of the work log: "Thinking it through - …the last words of the
 * reasoning", updated every half minute (the web collapses the updates of one
 * reasoning part into one row).
 *
 * Short thinking (most turns) shows nothing new. Pure helpers, unit-tested in
 * reasoningProgress.test.ts; the ingestion keeps one state per reasoning part.
 */

/** The first row appears once a reasoning part has gone on this long… */
export const REASONING_PROGRESS_FIRST_AFTER_MS = 10_000;
/** …and has this much text (a few words don't say anything). */
export const REASONING_PROGRESS_MIN_CHARS = 200;
/** Then at most one update per this interval. */
export const REASONING_PROGRESS_EVERY_MS = 30_000;
/** How much of the reasoning's end the row carries (it is one truncated line). */
export const REASONING_PROGRESS_TAIL_CHARS = 280;
/** Keep a bit more than the tail so the cut lands on a word boundary. */
const KEPT_TEXT_CHARS = REASONING_PROGRESS_TAIL_CHARS * 2;

export const REASONING_PROGRESS_LABEL = "Thinking it through";

export interface ReasoningProgressState {
  readonly startedAtMs: number;
  readonly lastEmitAtMs: number | null;
  readonly chars: number;
  /** The end of the reasoning so far (bounded). */
  readonly text: string;
}

export interface ReasoningProgressUpdate {
  readonly summary: string;
  readonly detail: string;
}

/**
 * The last ~{@link REASONING_PROGRESS_TAIL_CHARS} characters of the reasoning
 * as one line: whitespace and markdown marks squeezed, cut on a word, "…" in
 * front when something was cut.
 */
export function reasoningTailLine(
  text: string,
  maxChars: number = REASONING_PROGRESS_TAIL_CHARS,
): string {
  const line = text
    .replace(/[`*_#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (line.length <= maxChars) return line;
  const cut = line.slice(line.length - maxChars);
  const space = cut.indexOf(" ");
  const fromWord = space > 0 && space < 40 ? cut.slice(space + 1) : cut;
  return `…${fromWord}`;
}

/**
 * Add a reasoning delta. `update` is set when a row should be written now:
 * the reasoning has run past the first threshold with enough text, and the
 * last row is older than {@link REASONING_PROGRESS_EVERY_MS}.
 */
export function noteReasoningDelta(
  previous: ReasoningProgressState | undefined,
  delta: string,
  nowMs: number,
): { readonly state: ReasoningProgressState; readonly update: ReasoningProgressUpdate | null } {
  const base: ReasoningProgressState = previous ?? {
    startedAtMs: nowMs,
    lastEmitAtMs: null,
    chars: 0,
    text: "",
  };
  const joined = `${base.text}${delta}`;
  const grown: ReasoningProgressState = {
    ...base,
    chars: base.chars + delta.length,
    text: joined.length > KEPT_TEXT_CHARS ? joined.slice(joined.length - KEPT_TEXT_CHARS) : joined,
  };
  const due =
    base.lastEmitAtMs === null
      ? nowMs - base.startedAtMs >= REASONING_PROGRESS_FIRST_AFTER_MS &&
        grown.chars >= REASONING_PROGRESS_MIN_CHARS
      : nowMs - base.lastEmitAtMs >= REASONING_PROGRESS_EVERY_MS;
  if (!due) return { state: grown, update: null };
  const detail = reasoningTailLine(grown.text);
  if (detail.length === 0) return { state: grown, update: null };
  return {
    state: { ...grown, lastEmitAtMs: nowMs },
    update: { summary: REASONING_PROGRESS_LABEL, detail },
  };
}

/** The task id of a reasoning part's rows: the web collapses rows with one id. */
export function reasoningProgressTaskId(itemId: string): string {
  return `reasoning:${itemId}`;
}
