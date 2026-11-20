/**
 * Secrets out of text that leaves this computer for a colleague (T51): a
 * shared chat's feed, a read-only chat's answer, a session's last answer.
 *
 * Two passes, both before anything is sent (the server cleans by patterns
 * once more):
 * - the values of this project's keys known to this computer (its `.env`),
 *   wherever they appear — they are what a colleague must never read;
 * - token shapes: `sk-…`, `ghp_…`, `xox?-…`, `AKIA…`, `uno_…`, JWTs, PEM
 *   private keys, `Bearer …`, `token=…` / `password: …` style assignments.
 *
 * Pure: the caller reads the `.env` files.
 *
 * @module team/scrub.logic
 */

export const SCRUBBED = "[secret removed]";

/** A value shorter than this is not looked for (it would hit ordinary words). */
const MIN_VALUE_CHARS = 8;
/** A value this long is looked for even when it is only letters. */
const PLAIN_VALUE_CHARS = 16;

const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  // OpenAI / Anthropic style keys (sk-…, sk-ant-…, sk-proj-…)
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Slack
  /\bxox[abprse]-[A-Za-z0-9-]{10,}/g,
  // AWS access key ids
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Uno keys (account keys, the AI key, machine tokens)
  /\buno(?:llm)?_[A-Za-z0-9_-]{12,}/g,
  // Stripe
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}/g,
  // Google API keys
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  // JWTs
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Telegram bot tokens
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
];

/** `Bearer xyz`: the word stays, the credential goes. */
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g;

/**
 * `token=…`, `password: …`, `"api_key": "…"`, `SECRET=…`: the name stays,
 * the value goes. Only names that say they are secret.
 */
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"'`,;&]{6,})/gi;

/** Worth looking for: long enough, and not an ordinary word or number. */
export function isSecretLookingValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < MIN_VALUE_CHARS) return false;
  if (/^(true|false|null|none|yes|no|on|off)$/i.test(trimmed)) return false;
  // A port, a count, a year.
  if (/^\d+$/.test(trimmed) && trimmed.length < 12) return false;
  // A URL without credentials in it, a path: not a secret by itself.
  if (/^(https?:\/\/)[^@\s]*$/i.test(trimmed) || /^[~./][\w./-]*$/.test(trimmed)) return false;
  if (trimmed.length >= PLAIN_VALUE_CHARS) return true;
  // Shorter: only when it has a digit or a symbol (a word like "production" isn't one).
  return /[\d\W_]/.test(trimmed) && /[A-Za-z]/.test(trimmed);
}

/** Values of a `.env` file: `KEY=value`, `export KEY="value"`; comments and blanks skipped. */
export function envValues(text: string): ReadonlyArray<string> {
  const values: Array<string> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[1]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2) {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      // An inline comment after a space.
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (isSecretLookingValue(value)) values.push(value);
  }
  return values;
}

export interface ScrubResult {
  readonly text: string;
  /** How many things were taken out. */
  readonly removed: number;
}

/**
 * The text with this computer's key values and token shapes replaced by
 * {@link SCRUBBED}. `known`: values to look for (from {@link envValues}).
 */
export function scrubSecrets(text: string, known: ReadonlyArray<string> = []): ScrubResult {
  let removed = 0;
  let out = text;
  // Longest first: a value that contains another goes whole.
  const values = [...new Set(known.map((value) => value.trim()))]
    .filter(isSecretLookingValue)
    .toSorted((a, b) => b.length - a.length);
  for (const value of values) {
    if (!out.includes(value)) continue;
    const parts = out.split(value);
    removed += parts.length - 1;
    out = parts.join(SCRUBBED);
  }
  out = out.replace(PEM, () => {
    removed += 1;
    return SCRUBBED;
  });
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, () => {
      removed += 1;
      return SCRUBBED;
    });
  }
  out = out.replace(BEARER, (_all, word: string) => {
    removed += 1;
    return `${word}${SCRUBBED}`;
  });
  out = out.replace(ASSIGNMENT, (all, name: string, sep: string, value: string) => {
    if (value === SCRUBBED || value.startsWith("[secret")) return all;
    removed += 1;
    return `${name}${sep}${SCRUBBED}`;
  });
  return { text: out, removed };
}
