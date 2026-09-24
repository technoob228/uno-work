/**
 * `<uno_final_answer>` — the marker leaky reasoning models (Kimi, DeepSeek,
 * MiniMax…) are asked to put before their user-visible answer, so the text
 * before it (their thinking) can be hidden. Some echo it back as an XML tag
 * (`</uno_final_answer>` after the answer), with odd spacing or casing, or in
 * a harness path that never ran the OpenCode filter. The marker is never
 * part of an answer: every place that shows or forwards assistant text runs
 * it through {@link cleanUnoFinalAnswerText}.
 */

export const UNO_FINAL_ANSWER_MARKER = "<uno_final_answer>";

/** Opening, closing and self-closing forms, any case, spaces inside the brackets. */
const TAG = /<\s*\/?\s*uno_final_answer\s*\/?\s*>/giu;
const OPENING_TAG = /<\s*uno_final_answer\s*\/?\s*>/iu;
const FULL_TAG_TEXT = "</uno_final_answer>";

/** Length of a partially streamed tag at the very end ("<uno_fi", "</uno"). */
function partialTagSuffixLength(text: string): number {
  const tail = text.slice(-FULL_TAG_TEXT.length).toLowerCase();
  const start = tail.lastIndexOf("<");
  if (start < 0) return 0;
  const candidate = tail.slice(start).replace(/\s+/gu, "");
  // "<" alone could start anything; only trim once it clearly is our tag.
  if (candidate.length < 3) return 0;
  const isPrefix =
    "<uno_final_answer>".startsWith(candidate) || FULL_TAG_TEXT.startsWith(candidate);
  return isPrefix ? tail.length - start : 0;
}

/**
 * The user-visible part of an assistant text:
 * - with an opening marker, only what follows the first one (before it is
 *   the model's thinking);
 * - every remaining opening / closing marker removed;
 * - a marker cut off mid-stream at the end removed too.
 * Text without the marker comes back unchanged.
 */
export function cleanUnoFinalAnswerText(text: string): string {
  if (!text.includes("<")) return text;
  let out = text;
  const opening = OPENING_TAG.exec(out);
  if (opening) {
    out = out.slice(opening.index + opening[0].length).replace(/^[\s:：\-–—]+/u, "");
  }
  const hadTag = opening !== null || TAG.test(out);
  TAG.lastIndex = 0;
  out = out.replace(TAG, "");
  const partial = partialTagSuffixLength(out);
  if (partial > 0) out = out.slice(0, out.length - partial);
  return hadTag || partial > 0 ? out.replace(/\s+$/u, "") : out;
}
