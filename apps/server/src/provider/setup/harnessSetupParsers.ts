/**
 * Pure text helpers for the harness install / sign-in jobs: log capping,
 * ANSI stripping, secret scrubbing and the regexes that pull the verification
 * URL and one-time code out of a CLI's device-auth prompt.
 *
 * Observed prompts these are tuned against (2026-09, macOS, stdout piped):
 *
 *   codex login --device-auth
 *     1. Open this link in your browser and sign in to your account
 *        https://auth.openai.com/codex/device
 *     2. Enter this one-time code (expires in 15 minutes)
 *        41IV-83JI8
 *
 *   claude auth login
 *     Opening browser to sign in…
 *     If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&...
 *     Paste code here if prompted >
 *
 * @module provider/setup/harnessSetupParsers
 */

/** Keep the last ~64KB of output; enough for any npm/uv failure trace. */
export const SETUP_LOG_CAP_BYTES = 64 * 1024;

// oxlint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Append `chunk` to `current`, dropping the oldest bytes so the result never
 * exceeds `cap`. When trimming, cut at the next newline so the tail starts on
 * a whole line.
 */
export function appendCappedLog(
  current: string,
  chunk: string,
  cap: number = SETUP_LOG_CAP_BYTES,
): string {
  const next = current + chunk;
  if (next.length <= cap) return next;
  const overflow = next.length - cap;
  const newline = next.indexOf("\n", overflow);
  const cutAt = newline === -1 || newline >= next.length - 1 ? overflow : newline + 1;
  return next.slice(cutAt);
}

export function lastNonEmptyLine(log: string): string | undefined {
  const lines = stripAnsi(log).split(/\r?\n|\r/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length > 0) return line;
  }
  return undefined;
}

/** Replace every occurrence of `secret` (when non-trivial) with a marker. */
export function scrubSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.trim().length < 4) return text;
  return text.split(secret).join("[redacted]");
}

export interface OAuthPromptParse {
  readonly verificationUrl?: string;
  readonly userCode?: string;
  readonly needsCodeInput: boolean;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>`)\]]+/g;
// Codex prints e.g. `41IV-83JI8`; be permissive on segment lengths but keep the
// dash-joined upper-case shape so version strings and hashes never match.
const DEVICE_CODE_PATTERN = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/;
const PASTE_CODE_PATTERN = /paste (?:the |your )?(?:authorization |auth )?code/i;

function trimTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/, "");
}

function isLikelyAuthUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const haystack = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
    return (
      haystack.includes("auth") ||
      haystack.includes("login") ||
      haystack.includes("device") ||
      haystack.includes("oauth")
    );
  } catch {
    return false;
  }
}

/**
 * Pull the verification URL, one-time code and "paste code" prompt out of a
 * CLI's device-auth output. Works on the raw (ANSI-coloured) text.
 */
export function parseOAuthPrompt(rawText: string): OAuthPromptParse {
  const text = stripAnsi(rawText);
  const urls = [...text.matchAll(URL_PATTERN)].map((match) => trimTrailingPunctuation(match[0]));
  const verificationUrl = urls.find(isLikelyAuthUrl) ?? urls[0];

  // Only look for a device code once a URL is present: codex prints both in
  // the same block, and it keeps "v0.153.2"-style noise from being mistaken
  // for a code before the prompt has even started.
  let userCode: string | undefined;
  if (verificationUrl) {
    const afterUrl = text.slice(text.indexOf(verificationUrl) + verificationUrl.length);
    userCode = DEVICE_CODE_PATTERN.exec(afterUrl)?.[1] ?? DEVICE_CODE_PATTERN.exec(text)?.[1];
  }

  return {
    ...(verificationUrl ? { verificationUrl } : {}),
    ...(userCode ? { userCode } : {}),
    needsCodeInput: PASTE_CODE_PATTERN.test(text),
  };
}
