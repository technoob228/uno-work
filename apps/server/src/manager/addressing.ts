/**
 * addressing - Transport-agnostic "is the assistant being addressed?" policy.
 *
 * Both the Telegram connector (and, later, Slack) normalize an inbound message
 * into a {@link NormalizedIncomingMessage} and ask {@link decideAddressing}
 * whether the assistant should react at all. The rule:
 *
 *   - a 1:1 direct message is always addressed;
 *   - in a group/channel the assistant stays silent unless it is explicitly
 *     addressed — @-mentioned, replied to, or called by one of its configured
 *     names (fuzzy, so "Антоха" also answers to "Антон"/"Тоху");
 *   - immediately after it replied, a short "hot window" lets follow-ups land
 *     without re-addressing it;
 *   - a final smart tier (an LLM classifier the connector runs out-of-band) is
 *     consulted ONLY when the cheap deterministic checks miss AND the owner
 *     opted in — this module never calls a model, it just reports via
 *     `needsSmartCheck` that the caller may.
 *
 * Keeping this pure (no clock, no I/O) is what makes it unit-testable and
 * shareable across transports; the caller supplies the two facts this module
 * cannot derive on its own — whether the message is a DM and whether the bot
 * is still inside its hot window.
 */

export interface NormalizedIncomingMessage {
  /** 1:1 DM / private chat — always addressed, no gating. */
  readonly isDirectMessage: boolean;
  /** This message replies to one of the bot's own messages. */
  readonly isReplyToBot: boolean;
  /** The message @-mentions the bot's handle (or `/cmd@bot`). */
  readonly explicitMention: boolean;
  /** Another bot sent this — never engage, it invites message loops. */
  readonly senderIsBot: boolean;
  /**
   * User-visible text used for name detection. The caller folds any voice
   * transcript in here so "Антоха, посмотри" spoken aloud is caught too; may
   * be empty (e.g. a caption-less photo).
   */
  readonly text: string;
}

export interface AddressingConfig {
  /**
   * Wake names / aliases, e.g. `["Антоха", "Антон", "Тоха"]`. Matched
   * case-insensitively and forgivingly (see {@link nameIsMentioned}) so common
   * Russian declensions of a name still trigger.
   */
  readonly names: ReadonlyArray<string>;
  /**
   * In groups/channels, require an explicit address (mention / reply / name).
   * `false` makes the bot answer every message — only sane for a channel
   * dedicated to talking to it. Default `true`.
   */
  readonly requireMentionInGroups: boolean;
  /**
   * Let the caller consult its LLM classifier when the deterministic checks
   * miss. This module only flags the opportunity via `needsSmartCheck`.
   * Default `false`.
   */
  readonly smartWake: boolean;
  /**
   * Seconds after the bot last replied to a chat during which follow-ups from
   * the same chat need no re-addressing. `0` disables the hot window.
   */
  readonly hotWindowSec: number;
}

export const DEFAULT_ADDRESSING_CONFIG: AddressingConfig = {
  names: [],
  requireMentionInGroups: true,
  smartWake: false,
  hotWindowSec: 0,
};

export type AddressingReason =
  | "direct"
  | "open-group"
  | "reply"
  | "mention"
  | "name"
  | "hot-window"
  // Not produced by decideAddressing itself — the caller sets it when its
  // opt-in LLM classifier (see wakeClassifier.ts) turns a miss into a hit.
  | "smart";

export type AddressingDecision =
  | { readonly addressed: true; readonly reason: AddressingReason }
  | { readonly addressed: false; readonly needsSmartCheck: boolean };

export interface AddressingContext {
  /** The bot replied to this chat within `config.hotWindowSec`. */
  readonly withinHotWindow: boolean;
}

const NOT_ADDRESSED = (needsSmartCheck: boolean): AddressingDecision => ({
  addressed: false,
  needsSmartCheck,
});

const ADDRESSED = (reason: AddressingReason): AddressingDecision => ({
  addressed: true,
  reason,
});

// Fold ё→е and lowercase so "Ёжик"/"ежик" and case variants unify; then keep
// only letters/digits, turning "Антон," or "@antoха!" into clean tokens.
function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е");
}

function tokenize(text: string): ReadonlyArray<string> {
  return normalizeToken(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

// Small Damerau-free Levenshtein; inputs are short wake words so the O(n·m)
// table is trivial.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous: Array<number> = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current: Array<number> = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + cost;
      current[j] = Math.min(insertion, deletion, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Does a single message token address a configured wake name? Forgiving on
 * purpose (the owner asked for "не обязательно строго"):
 *   - exact match;
 *   - the name is a prefix of the token or vice-versa (declensions: "Тоха" →
 *     "Тоху", "Антон" → "Антоне"), guarded by a 3-char floor so "ты" never
 *     matches "Тоха";
 *   - a small edit distance with a shared stem, which catches nickname drift
 *     like "Антоха" ↔ "Антон" that prefix rules miss.
 */
function tokenMatchesName(token: string, name: string): boolean {
  if (token.length < 3 || name.length < 3) {
    return token === name;
  }
  if (token === name) return true;
  if (token.startsWith(name) || name.startsWith(token)) return true;
  const prefix = sharedPrefixLength(token, name);
  if (prefix < 3) return false;
  const distance = levenshtein(token, name);
  const threshold = Math.max(name.length, token.length) <= 4 ? 1 : 2;
  return distance <= threshold;
}

/** True when any configured name is addressed anywhere in the text. */
export function nameIsMentioned(text: string, names: ReadonlyArray<string>): boolean {
  if (names.length === 0 || text.trim().length === 0) return false;
  const normalizedNames = names
    .map((name) => normalizeToken(name.trim()))
    .filter((name) => name.length > 0);
  if (normalizedNames.length === 0) return false;
  const tokens = tokenize(text);
  return tokens.some((token) => normalizedNames.some((name) => tokenMatchesName(token, name)));
}

/**
 * The single decision point. Returns `addressed: true` with the reason it
 * fired, or `addressed: false` with whether the caller should still run its
 * smart classifier before giving up.
 */
export function decideAddressing(
  message: NormalizedIncomingMessage,
  config: AddressingConfig,
  context: AddressingContext = { withinHotWindow: false },
): AddressingDecision {
  // Never answer another bot: two assistants in one group would ping-pong.
  if (message.senderIsBot) {
    return NOT_ADDRESSED(false);
  }
  if (message.isDirectMessage) {
    return ADDRESSED("direct");
  }
  // A group the owner marked as "always on" (a channel dedicated to the bot).
  if (!config.requireMentionInGroups) {
    return ADDRESSED("open-group");
  }
  if (message.isReplyToBot) {
    return ADDRESSED("reply");
  }
  if (message.explicitMention) {
    return ADDRESSED("mention");
  }
  if (nameIsMentioned(message.text, config.names)) {
    return ADDRESSED("name");
  }
  if (config.hotWindowSec > 0 && context.withinHotWindow) {
    return ADDRESSED("hot-window");
  }
  return NOT_ADDRESSED(config.smartWake && message.text.trim().length > 0);
}
