/**
 * dictationText - splicing a transcript into whatever is already typed.
 *
 * Dictation is additive: users mix typing and speech in the same message, so
 * the transcript lands at the caret and has to bring its own spacing without
 * doubling up on what the user already typed.
 */

export interface DictationInsertion {
  /** Exactly what to splice in at the caret, spacing included. */
  readonly insertion: string;
  readonly text: string;
  readonly cursor: number;
}

const OPENING_CONTEXT = /[\s([{«"'>-]$/u;
const CLOSING_CONTEXT = /^[\s).,!?;:\]}»"']/u;

export function insertDictatedText(input: {
  readonly value: string;
  readonly cursor: number;
  readonly transcript: string;
}): DictationInsertion {
  const transcript = input.transcript.trim();
  if (transcript.length === 0) {
    return { insertion: "", text: input.value, cursor: input.cursor };
  }

  const cursor = Math.max(0, Math.min(input.value.length, input.cursor));
  const before = input.value.slice(0, cursor);
  const after = input.value.slice(cursor);

  const needsLeadingSpace = before.length > 0 && !OPENING_CONTEXT.test(before);
  const needsTrailingSpace = after.length > 0 && !CLOSING_CONTEXT.test(after);

  const insertion = `${needsLeadingSpace ? " " : ""}${transcript}${needsTrailingSpace ? " " : ""}`;
  return {
    insertion,
    text: `${before}${insertion}${after}`,
    cursor: cursor + insertion.length,
  };
}

/** `m:ss` for the recording indicator. */
export function formatDictationDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
