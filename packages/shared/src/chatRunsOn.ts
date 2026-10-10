/**
 * What a chat runs on, and so who pays for its AI: Uno AI (the plan's AI time
 * and premium credit), the person's own Claude / ChatGPT / Cursor
 * subscription, or a key they brought.
 *
 * One answer for every surface (decision 10.10): the chat header's line, the
 * signal the Uno assistant gets before it starts heavy work (`ai_status` of
 * uno-manager), and the daemon's pick for a chat the assistant starts without
 * naming a model.
 *
 * It follows what the daemon KNOWS about the harness — its driver and the
 * account its probe found (`ServerProvider.auth`) — never the harness's name
 * alone: Claude Code without a sign-in of its own runs on Uno AI
 * (`auth.type` "unoAi"), a Claude or Codex signed in with an API key is a
 * key, not a subscription, and a bare "authenticated" with no account behind
 * it is nothing at all.
 *
 * Pure: no I/O.
 */
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

import { readAssistantLlmProvider } from "./assistantLlm.ts";

export type ChatRunsOn =
  /** Uno AI: AI time for Smart and Fast, premium credit for Premium models. */
  | "uno-ai"
  /** The person's Claude Pro / Max (Team, Enterprise) subscription. */
  | "claude-plan"
  /** The person's ChatGPT subscription (Codex). */
  | "chatgpt-plan"
  /** The person's Cursor subscription. */
  | "cursor-plan"
  /** A key the person brought (Anthropic, OpenAI, xAI, OpenRouter, …). */
  | "own-key";

/** The part of a provider snapshot the answer depends on. */
export type RunsOnProvider = Pick<ServerProvider, "driver" | "auth">;

const AUTH_TYPE_UNO_AI = "unoAi";
const AUTH_TYPE_API_KEY = "apiKey";
/** Codex signed in with a ChatGPT account (`account.type` of its app-server). */
const AUTH_TYPE_CHATGPT = "chatgpt";

/**
 * What a chat on this harness runs on; null when the daemon can't tell (not
 * signed in, not probed yet, a custom harness) — say nothing then, a guess
 * about money is worse than no line.
 */
export function chatRunsOn(input: {
  readonly provider: RunsOnProvider | null | undefined;
  /** The chat's selection: a Hermes chat names where its AI comes from. */
  readonly modelSelection?: Pick<ModelSelection, "options"> | null | undefined;
}): ChatRunsOn | null {
  const provider = input.provider;
  if (!provider) return null;
  const { driver, auth } = provider;
  if (driver === "uno") return "uno-ai";
  if (driver === "hermes") {
    return readAssistantLlmProvider(input.modelSelection) === "uno" ? "uno-ai" : "own-key";
  }
  // `auth` is always there on a current daemon; an older one may omit it.
  if (auth?.status !== "authenticated") return null;
  switch (driver) {
    case "claudeAgent":
      if (auth.type === AUTH_TYPE_UNO_AI) return "uno-ai";
      if (auth.type === AUTH_TYPE_API_KEY) return "own-key";
      // "authenticated" alone is not a sign-in: on a computer without an Uno
      // key the Claude probe reports it as soon as the CLI starts, account or
      // not (ClaudeProvider). The plan the account carries is the evidence.
      return auth.type === undefined ? null : "claude-plan";
    case "codex":
      if (auth.type === AUTH_TYPE_API_KEY) return "own-key";
      return auth.type === AUTH_TYPE_CHATGPT ? "chatgpt-plan" : null;
    case "cursor":
      return "cursor-plan";
    default:
      return null;
  }
}

/** The chat header's words. */
export const CHAT_RUNS_ON_LABEL: Readonly<Record<ChatRunsOn, string>> = {
  "uno-ai": "Uno AI",
  "claude-plan": "Your Claude plan",
  "chatgpt-plan": "Your ChatGPT plan",
  "cursor-plan": "Your Cursor plan",
  "own-key": "Your own key",
};

/** One sentence under the label: who pays. */
export const CHAT_RUNS_ON_HINT: Readonly<Record<ChatRunsOn, string>> = {
  "uno-ai":
    "This chat runs on Uno AI: Smart and Fast use your AI time, Premium models your premium credit.",
  "claude-plan":
    "This chat runs on your Claude subscription. Uno doesn't charge for its AI; your Claude limits apply.",
  "chatgpt-plan":
    "This chat runs on your ChatGPT subscription. Uno doesn't charge for its AI; your ChatGPT limits apply.",
  "cursor-plan":
    "This chat runs on your Cursor subscription. Uno doesn't charge for its AI; your Cursor limits apply.",
  "own-key": "This chat runs on a key you added. Its provider bills you; Uno doesn't charge.",
};

export function chatRunsOnLabel(runsOn: ChatRunsOn | null): string | null {
  return runsOn === null ? null : CHAT_RUNS_ON_LABEL[runsOn];
}

/** True for the person's own Claude / ChatGPT subscription (not a key, not Uno AI). */
export function isOwnSubscription(runsOn: ChatRunsOn | null): boolean {
  return runsOn === "claude-plan" || runsOn === "chatgpt-plan";
}
