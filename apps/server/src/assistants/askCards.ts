/**
 * Question cards for assistants on Hermes (`ask_user`, Misha 16.10: the
 * assistant sets itself up "like Grok's companions" — quiz cards with a few
 * answers, the person's own words, a short field, a Connect button).
 *
 * Hermes has no question events of its own, so the daemon plays both ends:
 * `ask_user` puts a `user-input.requested` activity into the assistant's
 * conversation (the same card Claude and Codex questions use), the
 * assistant ends its turn, and when the person answers the reactor
 * (`ProviderCommandReactor`) resolves the card and sends the answer to the
 * conversation as the person's next message — not to the provider, which
 * never knew the request.
 *
 * Pure: building the card, recognising its request id, turning the answer
 * into the message text.
 *
 * @module assistants/askCards
 */
import {
  ASSISTANT_ASK_REQUEST_PREFIX,
  type ManagerAskUserInput,
  type UserInputQuestion,
} from "@t3tools/contracts";

/** What the provider's own `TEAM_APP_NAME` would call it, for "Connect GitHub". */
const CONNECT_NAMES: Readonly<Record<string, string>> = {
  gmail: "Gmail & Calendar",
  "google-drive": "Google Drive",
  notion: "Notion",
  github: "GitHub",
  microsoft: "Outlook & Teams calendar",
  calls: "Join my calls",
};

/** The card's answer once "Join my calls" is on. */
export const ASK_CARD_CALLS_ON = "Joining your calls";

export const ASK_CARD_CONNECTED = "Connected";

export function isAskCardRequest(requestId: string): boolean {
  return requestId.startsWith(ASSISTANT_ASK_REQUEST_PREFIX);
}

export function newAskCardRequestId(): string {
  return `${ASSISTANT_ASK_REQUEST_PREFIX}${crypto.randomUUID()}`;
}

/** The card the person sees: one question, skippable, own words allowed. */
export function askCardQuestion(input: ManagerAskUserInput): UserInputQuestion {
  const connect =
    input.connect !== undefined
      ? {
          provider: input.connect,
          name: CONNECT_NAMES[input.connect] ?? input.connect,
          doneLabel: input.connect === "calls" ? ASK_CARD_CALLS_ON : ASK_CARD_CONNECTED,
        }
      : undefined;
  return {
    id: "answer",
    header: input.header,
    question: input.question,
    options: (input.options ?? []).map((option) => ({
      label: option.label,
      description: option.description ?? option.label,
    })),
    multiSelect: input.multiSelect ?? false,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    ...(input.input !== undefined ? { input: input.input } : {}),
    ...(connect !== undefined ? { connect } : {}),
    skippable: true,
  };
}

/** The question a card asked, from the conversation's activities (newest card wins). */
export function findAskCardQuestion(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
  requestId: string,
): UserInputQuestion | null {
  for (const activity of activities.toReversed()) {
    if (activity.kind !== "user-input.requested") continue;
    const payload = activity.payload as { requestId?: unknown; questions?: unknown } | null;
    if (payload?.requestId !== requestId || !Array.isArray(payload.questions)) continue;
    const first = payload.questions[0] as UserInputQuestion | undefined;
    return first ?? null;
  }
  return null;
}

/** "Skip" from the card, or an empty answer. */
export function isSkipAnswer(text: string): boolean {
  return /^\s*skip\s*$/i.test(text);
}

/**
 * The person's answer as the message the assistant gets (and the person
 * sees as their own bubble): "My job: Developer", "Apps: Skip".
 */
export function askCardAnswerText(
  question: Pick<UserInputQuestion, "header"> | null,
  answers: Readonly<Record<string, unknown>>,
): string {
  const values = Object.values(answers).flatMap((value) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : typeof value === "string"
        ? [value]
        : [],
  );
  const answer = values
    .map((value) => value.trim())
    .filter(Boolean)
    .join(", ");
  const said = answer.length === 0 ? "Skip" : answer.slice(0, 2_000);
  return question ? `${question.header}: ${said}` : said;
}
