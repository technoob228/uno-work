/**
 * Several assistants in one Slack workspace through ONE Uno app (decision
 * 02.10): the assistant that added the app holds this computer's relay; the
 * others' rows route through it (`unoroute:<holder>`, see `channelRelay.ts`).
 *
 * - every assistant answers in ITS channels (each channel belongs to one
 *   assistant of the computer: its row's `allowedChannelIds`);
 * - a direct message to the app first asks "who is this for?" — the answer
 *   (an assistant's name) sticks for that DM; anything else goes to the
 *   default assistant;
 * - each one writes under its own name and emoji (`chat.postMessage`
 *   `username` / `icon_emoji`, scope `chat:write.customize`); a workspace
 *   that added the app before that scope gets a "*Ana:*" prefix instead.
 *
 * Pure; `SlackConnector.ts` does the I/O.
 *
 * @module manager/slackAssistants
 */
import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";

/** A Slack DM conversation id (`D…`); channels are `C…`, private groups `G…`. */
export const isSlackDmChannel = (channelId: string): boolean => /^D[A-Z0-9]+$/.test(channelId);

export interface SlackAssistantChoice {
  readonly projectId: string;
  readonly title: string;
}

/** Whose channel this is: a routed assistant's that lists it, else the holder's. */
export function assistantForSlackChannel(input: {
  readonly channel: string;
  readonly holder: string;
  readonly routed: ReadonlyArray<{
    readonly projectId: string;
    readonly allowedChannelIds: ReadonlyArray<string>;
  }>;
}): string {
  return (
    input.routed.find((row) => row.allowedChannelIds.includes(input.channel))?.projectId ??
    input.holder
  );
}

/** The DM's default: the computer's own assistant when it shares the app, else the holder. */
export function defaultSlackAssistant(
  choices: ReadonlyArray<SlackAssistantChoice>,
  holder: string,
): string {
  return choices.some((choice) => choice.projectId === ASSISTANT_PROJECT_ID)
    ? ASSISTANT_PROJECT_ID
    : holder;
}

const normalizeName = (text: string) =>
  text
    .trim()
    .replace(/^@/, "")
    .replace(/[.!?,:;]+$/, "")
    .trim()
    .toLowerCase();

/** The assistant a DM message names, when the whole message is just its name. */
export function matchAssistantName(
  text: string,
  choices: ReadonlyArray<SlackAssistantChoice>,
): SlackAssistantChoice | null {
  const name = normalizeName(text);
  if (name.length === 0 || name.length > 60) return null;
  return choices.find((choice) => normalizeName(choice.title) === name) ?? null;
}

export function slackWhoIsThisFor(
  choices: ReadonlyArray<SlackAssistantChoice>,
  defaultTitle: string,
): string {
  const names = choices.map((choice) => choice.title).join(", ");
  return `Who is this for? Reply with a name: ${names}. Anything else goes to ${defaultTitle}. To switch later, send just a name.`;
}

export function slackNowAnswers(title: string): string {
  return `OK — ${title} answers here now. Send another assistant's name to switch.`;
}

const SLACK_EMOJI: Readonly<Record<string, string>> = {
  "🤖": ":robot_face:",
  "🗓️": ":spiral_calendar_pad:",
  "🗓": ":spiral_calendar_pad:",
  "📣": ":mega:",
  "🛡️": ":shield:",
  "🛡": ":shield:",
  "💬": ":speech_balloon:",
  "🦉": ":owl:",
  "🦊": ":fox_face:",
  "🐝": ":bee:",
  "🌱": ":seedling:",
  "⚡️": ":zap:",
  "⚡": ":zap:",
  "🎯": ":dart:",
  "🧭": ":compass:",
};

/** Slack wants a `:shortcode:`; an emoji we don't know becomes the robot. */
export function slackIconEmoji(emoji: string | null | undefined): string {
  if (!emoji) return ":robot_face:";
  if (/^:[a-z0-9_+-]+:$/.test(emoji)) return emoji;
  return SLACK_EMOJI[emoji.trim()] ?? ":robot_face:";
}

/**
 * "Channels Ana answers in": Ana's row gets exactly `channelIds` (its DMs
 * stay), and every other assistant of the computer loses them — a channel
 * belongs to one assistant.
 */
export function assignSlackChannels(
  rows: ReadonlyArray<{
    readonly projectId: string;
    readonly allowedChannelIds: ReadonlyArray<string>;
  }>,
  projectId: string,
  channelIds: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const picked = [...new Set(channelIds.filter((id) => !isSlackDmChannel(id)))];
  const pickedSet = new Set(picked);
  const out = new Map<string, ReadonlyArray<string>>();
  for (const row of rows) {
    if (row.projectId === projectId) {
      out.set(projectId, [...row.allowedChannelIds.filter(isSlackDmChannel), ...picked]);
    } else {
      const kept = row.allowedChannelIds.filter((id) => !pickedSet.has(id));
      if (kept.length !== row.allowedChannelIds.length) out.set(row.projectId, kept);
    }
  }
  if (!out.has(projectId)) out.set(projectId, picked);
  return out;
}

/** Whether Slack refused the custom name / icon (the workspace lacks the scope). */
export function isCustomizeRefused(cause: unknown): boolean {
  const error =
    (cause as { data?: { error?: unknown } } | null)?.data?.error ??
    (cause instanceof Error ? cause.message : String(cause));
  return /missing_scope|not_allowed_token_type|invalid_arguments/.test(String(error));
}
