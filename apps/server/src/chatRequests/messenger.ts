/**
 * "A cloud chat asks to start a chat on the person's computer" in the
 * person's Telegram (Misha 20.11: "пусть это просто будет уведомление,
 * которое будет и там и там"). The request waits in Uno Work on that
 * computer (Needs you, the sidebar) and, at the same time, comes to their
 * Telegram as an approval: "<chat> wants to start a chat on <Mac>: <what>"
 * with Start / Decline.
 *
 * One place decides: the computer the chat would start on. A press here is
 * written there (outgoing.ts `decideFromMessenger`) and applied by the same
 * rules as its own button; whoever is first decides, the other hears
 * "already decided". That computer offline or Uno Work closed there: the
 * press is not kept to run later (a chat must not start on the Mac at a
 * moment nobody chose), the person hears so and the request goes on waiting
 * its 2 hours. Once it is decided, expired or refused, the message says so
 * and loses its buttons.
 *
 * The agent's words (title, gist, folder) are cut, one line, and set as
 * code: no formatting, no links, no link previews, and the message says
 * they are the agent's text.
 *
 * Texts and the press's answer are here, pure; the Telegram connector calls
 * {@link answerChatRequestPress} (it sits below this service, so the
 * decider is registered here at start, like `personApproval.ts`).
 *
 * @module chatRequests/messenger
 */
import type { ConnectorButton } from "../manager/connectorButtons.ts";
import type { ReplyLanguage } from "../manager/connectorReplyText.ts";
import type { MessengerDecision, OutRecord } from "./outgoing.ts";

/** The agent's words in a Telegram message, at most (title and gist together). */
export const AGENT_TEXT_MAX_CHARS = 160;
const FOLDER_MAX_CHARS = 80;

/** One line, cut, as code: Telegram renders no formatting or link in it and shows no preview. */
export function agentTextForMessenger(text: string, max: number = AGENT_TEXT_MAX_CHARS): string {
  // Backticks and control characters out: the agent can't close the code or draw lines.
  const visible = [...text]
    .map((char) => {
      const code = char.charCodeAt(0);
      return char === "`" || code < 32 || code === 127 ? " " : char;
    })
    .join("");
  const line = visible.replace(/\s+/g, " ").trim();
  const cut = line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
  return `\`${cut.length > 0 ? cut : "…"}\``;
}

/** The computer's name as the person called it, without markup. */
const plainName = (name: string) =>
  name
    .replace(/[`*_[\]<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "your computer";

/** "1 h 40 min" left of its 2 hours. */
export function timeLeftLabel(expiresAt: string, nowMs: number, language: ReplyLanguage): string {
  const minutes = Math.max(1, Math.round((Date.parse(expiresAt) - nowMs) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const [h, min] = language === "ru" ? ["ч", "мин"] : ["h", "min"];
  if (hours === 0) return `${rest} ${min}`;
  return rest === 0 ? `${hours} ${h}` : `${hours} ${h} ${rest} ${min}`;
}

/**
 * The message (under the chat's own "💬 <title>" line, which the connector
 * adds): "wants to start a chat on <Mac>: `<title> — <gist>`".
 */
export function chatRequestMessageText(
  record: Pick<OutRecord, "computerName" | "expiresAt" | "request">,
  language: ReplyLanguage,
  nowMs: number,
  withButtons = true,
): string {
  const mac = plainName(record.computerName);
  const what = agentTextForMessenger(`${record.request.title} — ${record.request.gist}`);
  const folder = record.request.cwd
    ? agentTextForMessenger(record.request.cwd, FOLDER_MAX_CHARS)
    : null;
  const left = timeLeftLabel(record.expiresAt, nowMs, language);
  if (language === "ru") {
    return [
      `хочет запустить чат на ${mac}: ${what}`,
      folder === null ? null : `Папка: ${folder}`,
      `Это текст агента, не Uno Work. Ждёт ещё ${left}; ${
        withButtons ? "ответьте здесь или" : "ответить можно"
      } в Uno Work на ${mac}.`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }
  return [
    `wants to start a chat on ${mac}: ${what}`,
    folder === null ? null : `Folder: ${folder}`,
    `That is the agent's text, not Uno Work's. It waits ${left}; answer ${
      withButtons ? "here or " : ""
    }in Uno Work on ${mac}.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function chatRequestButtons(
  requestId: string,
  language: ReplyLanguage,
): ReadonlyArray<ReadonlyArray<ConnectorButton>> {
  return [
    [
      {
        label: language === "ru" ? "▶ Запустить" : "▶ Start",
        action: { kind: "chat-request", requestId, decision: "start" },
        style: "success",
      },
      {
        label: language === "ru" ? "✖ Отклонить" : "✖ Decline",
        action: { kind: "chat-request", requestId, decision: "decline" },
      },
    ],
  ];
}

/** The message's last line once it no longer waits. */
export function chatRequestSettledLine(
  record: Pick<OutRecord, "status" | "computerName" | "decidedVia">,
  language: ReplyLanguage,
): string {
  const mac = plainName(record.computerName);
  const ru = language === "ru";
  const via = record.decidedVia;
  switch (record.status) {
    case "started": {
      const where =
        via === "telegram"
          ? ru
            ? " (из Telegram)"
            : " (from Telegram)"
          : via === "here"
            ? ru
              ? " (нажали там)"
              : " (pressed there)"
            : "";
      return ru ? `✔ Запущен на ${mac}${where}` : `✔ Started on ${mac}${where}`;
    }
    case "declined": {
      const where =
        via === "telegram"
          ? ru
            ? " в Telegram"
            : " in Telegram"
          : via === "here"
            ? ru
              ? ` на ${mac}`
              : ` on ${mac}`
            : "";
      return ru ? `✖ Отклонён${where}` : `✖ Declined${where}`;
    }
    case "expired":
      return ru ? "⌛ Истёк: за 2 часа не ответили" : "⌛ Expired: no answer within 2 hours";
    case "refused":
      return ru ? `✖ Не принят на ${mac}` : `✖ Refused on ${mac}`;
    default:
      return ru ? "✔ Уже решено" : "✔ Already answered";
  }
}

export interface ChatRequestPressReply {
  /** The pop-up under the press (≤ 200 characters). */
  readonly toast: string;
  /** The message's last line, its buttons gone; null: the buttons stay. */
  readonly finalLine: string | null;
}

/** What the person sees after pressing Start / Decline in Telegram. */
export function chatRequestPressReply(
  outcome: MessengerDecision | { readonly kind: "failed" },
  decision: "start" | "decline",
  language: ReplyLanguage,
  nowMs: number,
): ChatRequestPressReply {
  const ru = language === "ru";
  switch (outcome.kind) {
    case "gone":
      return {
        toast: ru ? "Запрос уже не ждёт ответа." : "This request is no longer waiting.",
        finalLine: ru ? "✔ Уже решено" : "✔ Already answered",
      };
    case "failed":
      return {
        toast: ru
          ? "Не получилось передать ответ. Попробуйте ещё раз или ответьте в Uno Work."
          : "Couldn't pass the answer on. Try again, or answer in Uno Work.",
        finalLine: null,
      };
    case "decided": {
      const line = chatRequestSettledLine(outcome.record, language);
      return {
        toast: `${ru ? "Уже решено" : "Already decided"}: ${line.slice(2)}`,
        finalLine: line,
      };
    }
    case "offline": {
      const mac = plainName(outcome.record.computerName);
      const left = timeLeftLabel(outcome.record.expiresAt, nowMs, language);
      return {
        toast: ru
          ? `${mac} не на связи. Запрос подождёт ещё ${left}: нажмите снова, когда он проснётся, или ответьте на нём.`
          : `${mac} is offline. The request waits ${left} more: press again once it's back, or answer there.`,
        finalLine: null,
      };
    }
    case "closed": {
      const mac = plainName(outcome.record.computerName);
      const left = timeLeftLabel(outcome.record.expiresAt, nowMs, language);
      return {
        toast: ru
          ? `Uno Work не открыт на ${mac}. Запрос подождёт ещё ${left}: откройте Uno Work там и нажмите снова.`
          : `Uno Work isn't open on ${mac}. The request waits ${left} more: open Uno Work there and press again.`,
        finalLine: null,
      };
    }
    case "sent": {
      const mac = plainName(outcome.record.computerName);
      return {
        toast:
          decision === "start"
            ? ru
              ? `Отправлено на ${mac}: чат запустится там через пару секунд.`
              : `Sent to ${mac}: the chat starts there in a few seconds.`
            : ru
              ? `Отправлено на ${mac}.`
              : `Sent to ${mac}.`,
        finalLine: null,
      };
    }
  }
}

// ── The decider, registered by the service at start ─────────────────────

type Decider = (input: {
  readonly requestId: string;
  readonly decision: "start" | "decline";
}) => Promise<MessengerDecision>;

let decider: Decider | null = null;

/** The sending side of this computer (ChatRequests.ts); null when it stops. */
export function setChatRequestDecider(next: Decider | null): void {
  decider = next;
}

/** A press of Start / Decline in Telegram (TelegramConnector.ts). */
export async function answerChatRequestPress(
  action: { readonly requestId: string; readonly decision: "start" | "decline" },
  language: ReplyLanguage,
  nowMs: number = Date.now(),
): Promise<ChatRequestPressReply> {
  const outcome =
    decider === null
      ? ({ kind: "gone" } as const)
      : await decider(action).catch(() => ({ kind: "failed" }) as const);
  return chatRequestPressReply(outcome, action.decision, language, nowMs);
}
