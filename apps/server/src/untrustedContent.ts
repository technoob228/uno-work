/**
 * Defanging helpers for content a model will read but did not author.
 *
 * Two distinct shapes, deliberately not one function:
 *
 * - `wrapUntrustedContent` is for *bodies* — thread transcripts, tool output.
 *   The content keeps its newlines and structure and is fenced by explicit
 *   delimiters that the content itself cannot close.
 * - `sanitizeUntrustedField` is for *labels* — titles, member names, project
 *   names, repository names. These get interpolated into prose ("thread
 *   \"$title\" on $memberLabel"), where a fenced envelope would be noise and a
 *   newline or a stray delimiter is the whole attack. So it flattens instead of
 *   fencing, and truncates, because a label is never legitimately long.
 *
 * Peer-originated data needs both: every string that crossed an environment
 * boundary is attacker-influenced, including the ones that used to be safe when
 * all data was local.
 */

const UNTRUSTED_OPEN = "<untrusted_thread_output>";
const UNTRUSTED_CLOSE = "</untrusted_thread_output>";

/**
 * Wrap attacker-influenced thread content in explicit delimiters. Occurrences
 * of the closing delimiter inside the content are defanged so injected text
 * cannot escape the envelope.
 */
export function wrapUntrustedContent(text: string): string {
  const defanged = text.replaceAll("</untrusted_thread_output", "<\\/untrusted_thread_output");
  return `${UNTRUSTED_OPEN}${defanged}${UNTRUSTED_CLOSE}`;
}

export const DEFAULT_UNTRUSTED_FIELD_MAX_LENGTH = 200;

// C0/C1 control characters plus the Unicode line/paragraph separators. Matched
// explicitly rather than relying on `\s`, which leaves most C1 controls in.
// oxlint-disable-next-line no-control-regex -- deliberately matching control characters
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/**
 * Flatten an attacker-influenced short field (title, label, name) so it cannot
 * forge structure in the surrounding prompt: control characters and line breaks
 * collapse to single spaces, angle brackets are neutralised so no tag or
 * delimiter can be spelled, and the result is length-capped.
 *
 * Returns the empty string for input that is empty after flattening — callers
 * decide the placeholder, because "(untitled)" and "(unknown member)" are not
 * interchangeable.
 */
export function sanitizeUntrustedField(
  value: string,
  maxLength: number = DEFAULT_UNTRUSTED_FIELD_MAX_LENGTH,
): string {
  const flattened = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  // Angle brackets are the only characters that let a field spell a delimiter
  // or a tag; substituting the single-guillemet lookalikes keeps the text
  // readable while making that impossible, unlike stripping which silently
  // mangles a legitimate "a<b".
  const defanged = flattened.replaceAll("<", "‹").replaceAll(">", "›");
  if (defanged.length <= maxLength) {
    return defanged;
  }
  return `${defanged.slice(0, Math.max(0, maxLength - 1))}…`;
}
