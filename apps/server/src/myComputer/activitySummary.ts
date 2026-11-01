/**
 * The short line the journal keeps and the approval card shows: a command or a
 * path, one line, clipped, with what looks like a secret masked. On top of
 * `redactSecretsInText` (tokens by their prefix) it catches what only the
 * context gives away: `API_KEY=…`, `Bearer …`, `--password …`, `user:pass@host`.
 *
 * It masks before it clips, so a cut can't leave half a token readable.
 *
 * @module myComputer/activitySummary
 */
import { REDACTED, redactSecretsInText } from "../secretRedaction.ts";

export const SUMMARY_MAX_CHARS = 200;

const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|pwd|credential|auth|cookie)[A-Za-z0-9_.-]*`;
const QUOTED_OR_BARE = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'&|;]+)`;

const CONTEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization: Basic xxx / token xxx (before the plain `Bearer xxx`).
  [/\b(authorization\s*[:=]\s*["']?[A-Za-z]+\s+)[^\s"']+/gi, `$1${REDACTED}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`],
  // API_KEY=value, export TOKEN="a b", --api-key=value
  [new RegExp(String.raw`(\b${SECRET_NAME}=)${QUOTED_OR_BARE}`, "gi"), `$1${REDACTED}`],
  // --password value, --api-key value
  [new RegExp(String.raw`(--${SECRET_NAME}\s+)${QUOTED_OR_BARE}`, "gi"), `$1${REDACTED}`],
  // https://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+(@)/gi, `$1${REDACTED}$2`],
  // A JWT.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Other key formats that are worth a line: AWS, Slack, GitLab, OpenAI-style.
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  // A long unbroken blob of letters and digits.
  [/\b(?=[A-Za-z0-9+_-]*[0-9])(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}/g, REDACTED],
];

export function maskSecrets(text: string): string {
  let next = redactSecretsInText(text);
  for (const [pattern, replacement] of CONTEXT_PATTERNS) {
    next = next.replace(pattern, replacement);
  }
  return next;
}

/** One masked line of at most `max` characters. */
export function summarize(text: string, max = SUMMARY_MAX_CHARS): string {
  const line = maskSecrets(text).replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}
