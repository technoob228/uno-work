/**
 * "Uno said it started a chat — did it?" The pure half.
 *
 * Uno (the pinned assistant, a dispatcher) answers "Принял, запустил «…»"
 * in one line. On GLM-5.3 Flash it learned to write that line without the
 * call: a fresh Hermes session got the past conversation as text only — the
 * replies, not the `chat_create` calls behind them — and copied the replies
 * (canary 2534, 30.10: two of four "запустил" started nothing). So:
 *
 * - **What actually ran** is read from the turn's tool activities
 *   ({@link launchesOfTurn}): a completed `chat_create` / `create_thread` /
 *   `send_turn` / `chat_message`, with the chat it names.
 * - **The carried history says it as a fact** ({@link annotateDispatcherHistory}):
 *   a reply of a turn that started chats carries "[запущен чат «…» (id, папка,
 *   модель)]"; a launch claim of a turn that started nothing is not carried.
 * - **The server checks every answer** ({@link decideLaunchTruth}): a claim
 *   with no launch in its turn gets one hidden question back to Uno
 *   ({@link launchCheckPromptText}); a second claim with no call is replaced
 *   by {@link notLaunchedText}. The person never gets a false "started".
 *
 * @module manager/launchTruth
 */
import type { ReplyLanguage } from "./connectorReplyText.ts";

/** Tools that start work in another chat (uno-work / uno-manager MCP). */
export const LAUNCH_TOOL_NAMES: ReadonlyArray<string> = [
  "chat_create",
  "create_thread",
  "send_turn",
  "chat_message",
];

/** Tools that only look at chats: a turn using them talks about existing work. */
const STATUS_TOOL_NAMES: ReadonlyArray<string> = [
  "work_status",
  "chat_status",
  "chats_list",
  "read_thread_detail",
  "get_thread_status",
  "list_threads",
];

/** Origin component of the hidden launch check turn (`systemCommandOrigin`). */
export const LAUNCH_CHECK_ORIGIN_COMPONENT = "launch-check";

/** Hidden launch checks per message: one question, then the honest line. */
export const LAUNCH_CHECK_MAX = 1;

export interface LaunchActivity {
  readonly kind: string;
  readonly summary?: string | undefined;
  readonly turnId: string | null;
  readonly payload: unknown;
}

/** One chat a turn started (or sent work to). */
export interface LaunchFact {
  readonly tool: string;
  readonly threadId: string | null;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly model: string | null;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/** `mcp__uno_work__chat_create` → `chat_create`; null when it is not a tool name we know. */
const toolNameOf = (summary: string | undefined, names: ReadonlyArray<string>): string | null => {
  const flat = (summary ?? "").trim();
  for (const name of names) {
    if (flat === name || flat.endsWith(`__${name}`) || flat.endsWith(`.${name}`)) return name;
  }
  return null;
};

/** The payload as one string with JSON-in-JSON escapes flattened (`\\\"` → `"`). */
const flatPayload = (payload: unknown): string => {
  let text: string;
  try {
    text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  } catch {
    return "";
  }
  return text.replace(/\\+"/g, '"');
};

const FAILED_RESULT =
  /"ok"\s*:\s*false|"isError"\s*:\s*true|"error"\s*:\s*["{]|"code"\s*:\s*"[a-z_]+"/;

/**
 * The chats a turn started, from its tool activities. A call that failed
 * (`status: failed`, `ok: false`, an error code such as `harness_not_ready`)
 * started nothing.
 */
export function launchesOfTurn(
  activities: ReadonlyArray<LaunchActivity>,
  turnId: string | null,
): ReadonlyArray<LaunchFact> {
  if (turnId === null) return [];
  const facts: Array<LaunchFact> = [];
  for (const activity of activities) {
    if (activity.turnId !== turnId || activity.kind !== "tool.completed") continue;
    const tool = toolNameOf(activity.summary, LAUNCH_TOOL_NAMES);
    if (tool === null) continue;
    const payload = isRecord(activity.payload) ? activity.payload : {};
    if (payload.status === "failed") continue;
    const flat = flatPayload(activity.payload);
    const resultPart = flat.replace(/"rawInput"\s*:\s*\{[^{}]*\}/, "");
    if (FAILED_RESULT.test(resultPart) && !/"ok"\s*:\s*true/.test(resultPart)) continue;
    const data = isRecord(payload.data) ? payload.data : {};
    const input = isRecord(data.rawInput) ? data.rawInput : {};
    const resultThreadId = new RegExp(`"threadId"\\s*:\\s*"(${UUID})"`, "i").exec(resultPart)?.[1];
    const resultTitle = /"title"\s*:\s*"([^"]{1,200})"/.exec(resultPart)?.[1];
    const provider = str(input.provider);
    const model = str(input.model);
    facts.push({
      tool,
      threadId: resultThreadId ?? str(input.threadId),
      title: str(input.title) ?? (resultTitle === undefined ? null : resultTitle.trim()),
      cwd: str(input.cwd),
      model: provider !== null && model !== null ? `${provider}/${model}` : (provider ?? model),
    });
  }
  return facts;
}

/** Whether the turn looked at existing chats (status words then describe them, not a launch). */
export function lookedAtChats(
  activities: ReadonlyArray<LaunchActivity>,
  turnId: string | null,
): boolean {
  if (turnId === null) return false;
  return activities.some(
    (activity) =>
      activity.turnId === turnId &&
      activity.kind.startsWith("tool.") &&
      toolNameOf(activity.summary, STATUS_TOOL_NAMES) !== null,
  );
}

// ── The claim ────────────────────────────────────────────────────────────

/** "I started it" in the first person, past tense — always a claim of this turn. */
const FIRST_PERSON_CLAIMS: ReadonlyArray<RegExp> = [
  /(?:пере)?запустил(?:а|и)?(?![а-яё])/giu,
  /отдал(?:а|и)?\s+(?:\S+\s+)?в\s+работу/giu,
  /передал(?:а|и)?\s+(?:\S+\s+){0,2}(?:в\s+)?(?:отдельн\S*\s+|нов\S*\s+)?чат/giu,
  /(?:создал|открыл|начал|стартовал)(?:а|и)?\s+(?:\S+\s+)?(?:отдельн\S*\s+|нов\S*\s+)?чат/giu,
  /поставил(?:а|и)?\s+(?:\S+\s+)?(?:задачу|в\s+работу)/giu,
  /\b(?:i(?:'ve| have)?\s+)?(?:re)?launched\b/giu,
  /\b(?:i(?:'ve| have)?\s+)?(?:started|opened|created|spun up)\s+(?:a|an|the|one|another)?\s*(?:new\s+|separate\s+)?(?:chat|task|thread|agent)\b/giu,
  /\bkicked (?:it |this )?off\b/giu,
  /\bhanded (?:it |this )?(?:off|over)\b/giu,
];

/** "It is running" — a claim unless the turn was a status look at existing chats. */
const PASSIVE_CLAIMS: ReadonlyArray<RegExp> = [
  /запущ(?:ен|ено|ена|ены)(?![а-яё])/giu,
  /\b(?:is|was|has been)\s+(?:now\s+)?(?:launched|started)\b/giu,
];

/** A negation right before the verb: «не запустил», "didn't launch", "not started". */
const NEGATED_BEFORE =
  /(?:(?:^|[^а-яё])(?:не|ни|нельзя)|\b(?:not|never|didn't|did not|haven't|have not|wasn't|was not|couldn't|could not|isn't))\s+(?:\S+\s+)?$/iu;

const hasUnnegated = (text: string, patterns: ReadonlyArray<RegExp>): boolean => {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0);
      if (!NEGATED_BEFORE.test(before)) return true;
    }
  }
  return false;
};

/**
 * Whether an answer says work was started ("Принял, запустил «…»",
 * "отдал в работу", "launched", "started a chat"). A denial («не запустил»)
 * is not a claim; "запущен" is not one in a status answer (`statusTurn`).
 */
export function claimsLaunch(
  text: string,
  options: { readonly statusTurn?: boolean } = {},
): boolean {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return false;
  if (hasUnnegated(flat, FIRST_PERSON_CLAIMS)) return true;
  return options.statusTurn !== true && hasUnnegated(flat, PASSIVE_CLAIMS);
}

export type LaunchTruthVerdict =
  /** Nothing claimed, or the claim is backed by a call. */
  | { readonly kind: "ok" }
  /** A claim with no call: ask Uno once, hidden. */
  | { readonly kind: "check" }
  /** Still a claim with no call after the check: the person gets the honest line. */
  | { readonly kind: "correct" };

export function decideLaunchTruth(input: {
  readonly text: string;
  readonly activities: ReadonlyArray<LaunchActivity>;
  readonly turnId: string | null;
  /** Hidden checks already made for this message. */
  readonly checksMade: number;
}): LaunchTruthVerdict {
  const statusTurn = lookedAtChats(input.activities, input.turnId);
  if (!claimsLaunch(input.text, { statusTurn })) return { kind: "ok" };
  if (launchesOfTurn(input.activities, input.turnId).length > 0) return { kind: "ok" };
  return input.checksMade < LAUNCH_CHECK_MAX ? { kind: "check" } : { kind: "correct" };
}

// ── Texts ────────────────────────────────────────────────────────────────

const ORIGINAL_MAX_CHARS = 2_000;

/**
 * The hidden question back to Uno. Starts with "(Uno Work) ", so the app
 * shows it as one quiet line, not as the person's bubble.
 */
export const launchCheckPromptText = (original: string): string => {
  const trimmed = original.trim();
  const clipped =
    trimmed.length > ORIGINAL_MAX_CHARS ? `${trimmed.slice(0, ORIGINAL_MAX_CHARS)}…` : trimmed;
  return [
    "(Uno Work) Launch check: your last answer says you started a chat, but there was NO " +
      "chat_create / send_turn call in that turn — nothing was started, the person would get a " +
      "false «запустил». Ты написал, что запустил, но вызова не было. Now either call chat_create " +
      "for the request below and answer one line with what you started, or answer one line telling " +
      "the person you did NOT start it and why. Never write that you started something without the call.",
    "",
    "The request:",
    clipped,
  ].join("\n");
};

/** What the person gets when Uno claimed a launch twice without a call. */
export const notLaunchedText = (language: ReplyLanguage): string =>
  language === "ru"
    ? "Не запустил — повтори или уточни."
    : "I didn't start it — send it again or add details.";

// ── The carried history ──────────────────────────────────────────────────

export interface HistoryMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly turnId?: string | null | undefined;
}

const shortId = (id: string) => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

/** «[запущен чат «…» (id …, папка …, модель …)]» — one launch as a fact. */
export const launchFactLine = (fact: LaunchFact): string => {
  const verb =
    fact.tool === "send_turn" || fact.tool === "chat_message" ? "отправлено в чат" : "запущен чат";
  const details = [
    fact.threadId === null ? null : `id ${shortId(fact.threadId)}`,
    fact.cwd === null ? null : `папка ${fact.cwd}`,
    fact.model === null ? null : `модель ${fact.model}`,
  ].filter((part): part is string => part !== null);
  const title = fact.title === null ? "" : ` «${fact.title}»`;
  return `[${verb}${title}${details.length > 0 ? ` (${details.join(", ")})` : ""}]`;
};

/** In place of a launch claim whose turn started nothing. */
export const NOT_LAUNCHED_FACT = "[чат не запускался — вызова chat_create не было]";

/**
 * The Uno chat's messages as a fresh session should hear them: each reply of
 * a turn that started chats leads with the facts of what it started (`fill`
 * may complete a fact from the read model — folder, model); a launch claim of
 * a turn that started nothing is replaced by {@link NOT_LAUNCHED_FACT}, so the
 * model never sees a bare "Принял, запустил" to copy.
 */
export function annotateDispatcherHistory<M extends HistoryMessage>(
  messages: ReadonlyArray<M>,
  activities: ReadonlyArray<LaunchActivity>,
  fill: (fact: LaunchFact) => LaunchFact = (fact) => fact,
): ReadonlyArray<M> {
  const lastOfTurn = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === "assistant" && message.turnId) lastOfTurn.set(message.turnId, index);
  });
  return messages.map((message, index) => {
    if (message.role !== "assistant" || !message.turnId) return message;
    const turnId = message.turnId;
    const facts = launchesOfTurn(activities, turnId);
    if (facts.length > 0) {
      // The facts once per turn, on its last reply.
      if (lastOfTurn.get(turnId) !== index) return message;
      const lines = facts.map((fact) => launchFactLine(fill(fact)));
      return { ...message, text: `${lines.join("\n")}\n${message.text.trim()}` };
    }
    const statusTurn = lookedAtChats(activities, turnId);
    if (claimsLaunch(message.text, { statusTurn })) {
      return { ...message, text: NOT_LAUNCHED_FACT };
    }
    return message;
  });
}
