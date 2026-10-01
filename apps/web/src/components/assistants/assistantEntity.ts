/**
 * "Assistants" as a person sees them (simplification 01.10): a bot that
 * answers in Telegram or Slack 24/7, created on purpose, with a name and a
 * line about what it does.
 *
 * Under the hood (v1) it is the computer's one assistant — the Hermes
 * "manager" in the `assistant` project, whose Telegram / Slack connectors and
 * memory already exist on every computer. The daemon can register more
 * assistant projects (`POST /api/manager/assistants`), but routing is not
 * ready for them: a private Telegram chat links only to the main assistant
 * (`connectorBindings.ts`, `TelegramConnector.linkChat`), and Uno's shared
 * bot has one relay per computer (connecting a second assistant would rotate
 * it away from the first). So: one assistant per computer for now, said in
 * the UI.
 *
 * What makes the assistant "exist" for the person is kept on the computer in
 * `settings.setup.answers` (plain strings, like the goal-first start — an
 * older daemon round-trips them):
 *
 * - `assistant_created_at` — set by "Create";
 * - `assistant_name`, `assistant_about` — step 1;
 * - `assistant_where` — step 2's choice.
 *
 * An assistant set up before this screen existed (onboarding's "My
 * assistant", or Telegram / Slack already connected) shows up too.
 *
 * Pure part only — no I/O.
 */
import type {
  ManagerSlackConnectorStatus,
  ManagerTelegramConnectorStatus,
  UnoSetupProgress,
} from "@t3tools/contracts";

import { slackChannelState, telegramChannelState } from "../../assistant/assistantChat.logic";
import { GOAL_KEY } from "../setup/goals";

export const ASSISTANT_CREATED_KEY = "assistant_created_at";
export const ASSISTANT_NAME_KEY = "assistant_name";
export const ASSISTANT_ABOUT_KEY = "assistant_about";
export const ASSISTANT_WHERE_KEY = "assistant_where";
export const ASSISTANT_DELETED = "deleted";

export const ASSISTANT_WHERE = ["telegram", "own_bot", "slack", "here"] as const;
export type AssistantWhere = (typeof ASSISTANT_WHERE)[number];

/** The name when the person gave none (the assistant has always been "Uno"). */
export const DEFAULT_ASSISTANT_NAME = "Uno";

export const ONE_ASSISTANT_NOTE = "One assistant per computer for now.";

export const ASSISTANT_NAME_MAX = 40;
export const ASSISTANT_ABOUT_MAX = 300;

export function parseAssistantWhere(value: unknown): AssistantWhere | null {
  return typeof value === "string" && (ASSISTANT_WHERE as ReadonlyArray<string>).includes(value)
    ? (value as AssistantWhere)
    : null;
}

export interface AssistantChannelsView {
  readonly telegram: ManagerTelegramConnectorStatus | null;
  readonly slack: ManagerSlackConnectorStatus | null;
}

export interface AssistantEntity {
  readonly name: string;
  readonly about: string | null;
  readonly where: AssistantWhere | null;
  readonly createdAt: string | null;
  /** Telegram linked to at least one chat and switched on. */
  readonly telegramOn: boolean;
  /** Telegram set up but switched off (Pause). */
  readonly telegramPaused: boolean;
  readonly telegramBot: string | null;
  readonly telegramShared: boolean;
  readonly slackOn: boolean;
  readonly slackPaused: boolean;
  /** Connected somewhere but everything is switched off. */
  readonly paused: boolean;
}

/** The assistant of this computer as the Assistants screen shows it; null = none yet. */
export function assistantEntity(
  progress: Pick<UnoSetupProgress, "answers">,
  channels: AssistantChannelsView,
): AssistantEntity | null {
  const answers = progress.answers ?? {};
  const rawCreatedAt = answers[ASSISTANT_CREATED_KEY] || null;
  const deleted = rawCreatedAt === ASSISTANT_DELETED;
  const createdAt = deleted ? null : rawCreatedAt;
  const telegram = channels.telegram;
  const slack = channels.slack;
  const telegramOn = telegram !== null && telegramChannelState(telegram) === "on";
  const telegramPaused =
    telegram !== null &&
    telegram.configured &&
    !telegram.enabled &&
    telegram.allowedChatIds.length > 0;
  const slackOn = slack !== null && slackChannelState(slack) === "on";
  const slackPaused =
    slack !== null && slack.configured && !slack.enabled && slack.allowedChannelIds.length > 0;
  const fromOnboarding = !deleted && answers[GOAL_KEY] === "assistant";
  const exists =
    createdAt !== null || fromOnboarding || telegramOn || telegramPaused || slackOn || slackPaused;
  if (!exists) return null;
  const name = (answers[ASSISTANT_NAME_KEY] ?? "").trim() || DEFAULT_ASSISTANT_NAME;
  const about = (answers[ASSISTANT_ABOUT_KEY] ?? "").trim() || null;
  return {
    name,
    about,
    where: parseAssistantWhere(answers[ASSISTANT_WHERE_KEY]),
    createdAt,
    telegramOn,
    telegramPaused,
    telegramBot: telegram?.botUsername ?? null,
    telegramShared: telegram?.shared === true,
    slackOn,
    slackPaused,
    paused: !telegramOn && !slackOn && (telegramPaused || slackPaused),
  };
}

/** "Telegram · @get_uno_bot", "Slack", "Only here" — where it answers, in one line. */
export function assistantWhereLine(entity: AssistantEntity): string {
  const parts: string[] = [];
  if (entity.telegramOn || entity.telegramPaused) {
    parts.push(entity.telegramBot ? `Telegram · @${entity.telegramBot}` : "Telegram");
  }
  if (entity.slackOn || entity.slackPaused) parts.push("Slack");
  if (parts.length === 0) {
    return entity.where === "telegram" || entity.where === "own_bot"
      ? "Telegram · not linked yet"
      : entity.where === "slack"
        ? "Slack · not connected yet"
        : "Only here, in Uno Work";
  }
  return parts.join(" · ");
}

/** Step 1 saved: the assistant exists from now on (the first "Create" keeps its date). */
export function withAssistantProfile(
  progress: UnoSetupProgress,
  input: { readonly name: string; readonly about: string; readonly now: string },
): UnoSetupProgress {
  const name = input.name.trim().slice(0, ASSISTANT_NAME_MAX);
  const about = input.about.trim().slice(0, ASSISTANT_ABOUT_MAX);
  return {
    ...progress,
    answers: {
      ...progress.answers,
      [ASSISTANT_CREATED_KEY]:
        progress.answers[ASSISTANT_CREATED_KEY] &&
        progress.answers[ASSISTANT_CREATED_KEY] !== ASSISTANT_DELETED
          ? progress.answers[ASSISTANT_CREATED_KEY]
          : input.now,
      [ASSISTANT_NAME_KEY]: name,
      [ASSISTANT_ABOUT_KEY]: about,
    },
  };
}

export function withAssistantWhere(
  progress: UnoSetupProgress,
  where: AssistantWhere,
): UnoSetupProgress {
  if (progress.answers[ASSISTANT_WHERE_KEY] === where) return progress;
  return { ...progress, answers: { ...progress.answers, [ASSISTANT_WHERE_KEY]: where } };
}

/**
 * Delete: the assistant leaves the list. The onboarding goal "assistant" is
 * kept for history but no longer counts once the person deleted it — the
 * marker `assistant_created_at` = "deleted" (ASSISTANT_DELETED) says so.
 */
export function withoutAssistant(progress: UnoSetupProgress): UnoSetupProgress {
  const answers: Record<string, string> = { ...progress.answers };
  delete answers[ASSISTANT_NAME_KEY];
  delete answers[ASSISTANT_ABOUT_KEY];
  delete answers[ASSISTANT_WHERE_KEY];
  answers[ASSISTANT_CREATED_KEY] = ASSISTANT_DELETED;
  return { ...progress, answers };
}

/**
 * The block the assistant's AGENTS.md carries for its name and job, between
 * markers so it can be replaced without touching the rest of the file.
 */
const PROFILE_START = "<!-- uno:assistant-profile -->";
const PROFILE_END = "<!-- /uno:assistant-profile -->";

export function withAgentsProfile(
  agentsMd: string,
  input: { readonly name: string; readonly about: string },
): string {
  const name = input.name.trim() || DEFAULT_ASSISTANT_NAME;
  const about = input.about.trim();
  const block = [
    PROFILE_START,
    "## Who you are",
    "",
    `Your name is ${name}.`,
    ...(about ? [`What you do: ${about}`] : []),
    PROFILE_END,
  ].join("\n");
  const start = agentsMd.indexOf(PROFILE_START);
  const end = agentsMd.indexOf(PROFILE_END);
  if (start !== -1 && end > start) {
    return `${agentsMd.slice(0, start)}${block}${agentsMd.slice(end + PROFILE_END.length)}`;
  }
  const trimmed = agentsMd.replace(/\s+$/, "");
  return trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}
