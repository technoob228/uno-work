/**
 * Dictation's two decisions that need no microphone: where a finished
 * transcript goes, and what an error says to the person.
 */

/** Text the person typed while transcription ran is never replaced. */
export interface DictationDraft {
  /** Which composer the words were for (a draft id / thread key / "home"). */
  readonly owner: string;
  readonly text: string;
  /** Caret position (a collapsed selection) in `text`. */
  readonly cursor: number;
}

export type DictationInsert =
  /** Insert `insertion` at `at` in the current text (spaces included). */
  | { readonly kind: "insert"; readonly at: number; readonly insertion: string }
  /** The composer now shows another chat: don't put the words there. */
  | { readonly kind: "elsewhere" }
  | { readonly kind: "empty" };

const needsSpace = (char: string | undefined) => char !== undefined && !/\s/.test(char);

/**
 * Where a finished transcript goes (idea from upstream's voice input
 * `resolveTranscriptCommit`, kinder to the person): into the caret it was
 * recorded at when the box is as it was; at the end when the person kept
 * typing meanwhile (their text is never overwritten or split); nowhere when
 * the box now belongs to another chat.
 */
export function resolveDictationInsert(
  captured: DictationDraft | null,
  current: DictationDraft | null,
  transcript: string,
): DictationInsert {
  const words = transcript.trim();
  if (words.length === 0) return { kind: "empty" };
  if (!current || (captured && captured.owner !== current.owner)) return { kind: "elsewhere" };
  const unchanged = captured !== null && captured.text === current.text;
  const at = unchanged
    ? Math.max(0, Math.min(captured.cursor, current.text.length))
    : current.text.length;
  const before = current.text[at - 1];
  const after = current.text[at];
  return {
    kind: "insert",
    at,
    insertion: `${needsSpace(before) ? " " : ""}${words}${needsSpace(after) ? " " : ""}`,
  };
}

const NOTHING_HEARD = /contained no text|no speech|nothing was recorded/i;

/** The dictation error a person can act on (the gateway's own words otherwise). */
export function dictationErrorMessage(message: string): string {
  return NOTHING_HEARD.test(message) ? "Didn't hear anything — check microphone access" : message;
}
