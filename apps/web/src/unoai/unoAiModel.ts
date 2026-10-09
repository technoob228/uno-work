/**
 * The Uno AI transcript as the chat shows it. The server keeps OpenAI-style
 * messages (the same as the console's /ask: ask_user, show_plan, write_file,
 * publish_site, site_password, telegram_link, suggest_next, bot_setup); this
 * turns them into what a person sees — their messages, Uno's words, one
 * question with tappable answers, the plan, "your site is live", the next-step
 * offer, the free bot's card.
 * Pure and unit-tested.
 */
import type { AiChatMessage, AiSite, AiToolCall } from "./unoAiApi";

export interface AiQuestion {
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly recommended: string | null;
  /**
   * The options as answer cards, like the uno.place chat draws them (icon,
   * label, a line under it): same order as `options`, label === option.
   */
  readonly choices: ReadonlyArray<AiChoice>;
}

/** The icons an answer card may have — the uno.place chat's set (landingchat TileIcons). */
export const AI_CHOICE_ICONS = [
  "site",
  "bot",
  "agent",
  "team",
  "code",
  "server",
  "db",
  "form",
  "lock",
  "telegram",
  "mail",
  "calendar",
  "money",
  "clock",
  "chat",
  "store",
  "spark",
  "folder",
  "apps",
  "globe",
  "users",
  "edit",
] as const;
export type AiChoiceIcon = (typeof AI_CHOICE_ICONS)[number];

export interface AiChoice {
  readonly label: string;
  /** One short line under the label: what it means or what happens next. */
  readonly hint: string | null;
  readonly icon: AiChoiceIcon | null;
}

export type AiItem =
  | { readonly kind: "user"; readonly key: string; readonly text: string }
  | { readonly kind: "text"; readonly key: string; readonly text: string }
  | {
      readonly kind: "ask";
      readonly key: string;
      readonly questions: ReadonlyArray<AiQuestion>;
      /** The person already answered (a message of theirs came after it). */
      readonly answered: boolean;
    }
  | {
      readonly kind: "plan";
      readonly key: string;
      readonly title: string;
      readonly steps: ReadonlyArray<string>;
    }
  | {
      readonly kind: "building";
      readonly key: string;
      readonly files: number;
      readonly chars: number;
    }
  | {
      readonly kind: "site";
      readonly key: string;
      readonly url: string;
      readonly slug: string;
      readonly title: string | null;
    }
  | {
      readonly kind: "password";
      readonly key: string;
      readonly slug: string;
      readonly password: string | null;
    }
  | { readonly kind: "telegram"; readonly key: string; readonly url: string }
  | {
      readonly kind: "suggest";
      readonly key: string;
      readonly action: "computer" | "connect_agent" | "uno_work";
      readonly reason: string;
      /** Still the latest word in the chat (no message of the person after it). */
      readonly current: boolean;
    }
  | {
      /** bot_setup: the free Telegram bot (fishcode feat/free-bot-days). */
      readonly kind: "bot";
      readonly key: string;
      readonly name: string;
      /** The bot's state when Uno saved the settings — only a first guess; the card asks the account. */
      readonly state: BotState;
      /** Still the latest word in the chat (no message of the person after it). */
      readonly current: boolean;
      /** The bot was already live: these are new settings for it, not a new bot. */
      readonly update: boolean;
      /** What the tool result already knew (shown until the account answers). */
      readonly username: string | null;
      readonly url: string | null;
      readonly freeUntil: string | null;
      readonly freeDays: number | null;
    };

export type BotState = "none" | "draft" | "starting" | "live" | "failed" | "ended";

const BOT_STATES: ReadonlySet<string> = new Set<BotState>([
  "none",
  "draft",
  "starting",
  "live",
  "failed",
  "ended",
]);

export function botState(raw: unknown): BotState {
  return typeof raw === "string" && BOT_STATES.has(raw) ? (raw as BotState) : "draft";
}

function optString(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function parseArgs(call: AiToolCall): Record<string, unknown> {
  try {
    const value = JSON.parse(call.function.arguments || "{}") as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseResult(content: string | null): Record<string, unknown> {
  if (!content) return {};
  try {
    const value = JSON.parse(content) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const STAR = /\s*[★⭐✱*]+\s*$/u;
/** "(recommended)" the model sometimes writes into the option itself — the chat marks it already. */
const RECOMMENDED_NOTE =
  /\s*[([](?:recommended|recommend|рекомендую|советую|recomendado|recomendada|recomiendo)[)\]]\s*$/iu;

function choiceIcon(raw: unknown): AiChoiceIcon | null {
  return typeof raw === "string" && (AI_CHOICE_ICONS as ReadonlyArray<string>).includes(raw)
    ? (raw as AiChoiceIcon)
    : null;
}

/**
 * The icon for an answer the model sent as plain words (Uno AI's ask_user has
 * strings): the uno.place chat gets icons from its model, here the words pick
 * one. No match — no icon, the card is just the words.
 */
const ICON_WORDS: ReadonlyArray<readonly [RegExp, AiChoiceIcon]> = [
  [/telegram|телеграм/iu, "telegram"],
  [/e-?mail|inbox|почт|correo/iu, "mail"],
  [/password|only me|парол|contraseña|senha/iu, "lock"],
  [/\bbot\b|(?<![а-яё])бот/iu, "bot"],
  [/pay|price|stripe|paypal|\$|оплат|цен|pago|precio|preço/iu, "money"],
  [/book|schedule|calendar|class|appointment|slot|запис|распис|reserva|agenda/iu, "calendar"],
  [/form|request|lead|order|заявк|заказ|formulario|pedido/iu, "form"],
  [/edit|change|update|colou?r|text|измен|поменя|cambi|mudar/iu, "edit"],
  [/menu|shop|store|product|магазин|меню|tienda|loja/iu, "store"],
  [/page|site|landing|сайт|страниц|página/iu, "site"],
  [/time|hour|время|час|hora/iu, "clock"],
  [/chat|message|reply|answer|ответ|сообщ|mensaje/iu, "chat"],
  [/public|everyone|anyone|всем|публичн|todos/iu, "globe"],
  [/team|staff|group|client|customer|people|команд|групп|клиент|equipo|grupo|cliente/iu, "users"],
];

export function guessChoiceIcon(label: string): AiChoiceIcon | null {
  for (const [re, icon] of ICON_WORDS) if (re.test(label)) return icon;
  return null;
}

function normQuestion(raw: unknown): AiQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  const question = String(q["question"] ?? "").trim();
  if (!question) return null;
  let recommended = String(q["recommended"] ?? "")
    .replace(RECOMMENDED_NOTE, "")
    .replace(STAR, "")
    .trim();
  const raws = (Array.isArray(q["options"]) ? q["options"] : [])
    .map((o): { text: string; hint: string | null; icon: AiChoiceIcon | null } => {
      // An option may come as words or as {label|answer, hint, icon, recommended}
      // (the uno.place chat's shape): read the words, never print
      // "[object Object]" (icp3 09.10, n2/3).
      if (o && typeof o === "object") {
        const option = o as Record<string, unknown>;
        const text = String(
          option["label"] ?? option["answer"] ?? option["text"] ?? option["value"] ?? "",
        ).trim();
        if (text && option["recommended"] === true && !recommended) recommended = text;
        const hint = optString(option["hint"] ?? option["description"] ?? option["detail"]);
        return { text, hint, icon: choiceIcon(option["icon"]) };
      }
      return { text: String(o ?? "").trim(), hint: null, icon: null };
    })
    .filter((o) => o.text)
    .slice(0, 5)
    .map((o) => {
      const noted = RECOMMENDED_NOTE.test(o.text);
      const clean = o.text.replace(RECOMMENDED_NOTE, "").replace(STAR, "").trim();
      if (!recommended && noted) recommended = clean;
      if (!recommended && clean !== o.text) recommended = clean;
      o.text = clean;
      return o;
    })
    .filter((o) => o.text);
  const options = raws.map((o) => o.text);
  return {
    question,
    options,
    recommended: recommended && options.includes(recommended) ? recommended : null,
    choices: raws.map((o) => ({
      label: o.text,
      hint: o.hint ? o.hint.slice(0, 80) : null,
      icon: o.icon ?? guessChoiceIcon(o.text),
    })),
  };
}

/** A plan step: a string, or an object the model sometimes sends ({step} / {title, detail}). */
function stepText(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const head = [o["step"], o["title"], o["text"], o["name"]].find(
      (v) => typeof v === "string" && v.trim(),
    );
    const tail = [o["detail"], o["details"], o["description"]].find(
      (v) => typeof v === "string" && v.trim(),
    );
    return [head, tail].filter(Boolean).join(" — ").trim();
  }
  return raw === null || raw === undefined ? "" : String(raw);
}

/** One question (today's ask_user) or the older { questions: [...] } shape. */
export function askQuestions(args: Record<string, unknown>): ReadonlyArray<AiQuestion> {
  const list = args["questions"];
  if (Array.isArray(list)) return list.map(normQuestion).filter((q): q is AiQuestion => !!q);
  const one = normQuestion(args);
  return one ? [one] : [];
}

/** The transcript → what the chat shows, in order. */
export function transcriptItems(messages: ReadonlyArray<AiChatMessage>): ReadonlyArray<AiItem> {
  const results = new Map<string, Record<string, unknown>>();
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, parseResult(m.content));
    if (m.role === "user") lastUser = i;
  });
  const items: AiItem[] = [];
  let building: { files: Set<string>; chars: number; key: string } | null = null;
  const flushBuilding = () => {
    if (building) {
      items.push({
        kind: "building",
        key: building.key,
        files: building.files.size,
        chars: building.chars,
      });
      building = null;
    }
  };
  messages.forEach((m, i) => {
    if (m.role === "tool") return;
    if (m.role === "user") {
      flushBuilding();
      const text = (m.content ?? "").trim();
      if (text) items.push({ kind: "user", key: `u${i}`, text });
      return;
    }
    const text = (m.content ?? "").trim();
    if (text && text !== "…") {
      flushBuilding();
      items.push({ kind: "text", key: `t${i}`, text });
    }
    for (const call of m.tool_calls ?? []) {
      const result = results.get(call.id) ?? {};
      if (result["ok"] === false) continue; // refused / failed: the model deals with it
      const args = parseArgs(call);
      const key = `${call.function.name}:${call.id}`;
      switch (call.function.name) {
        case "write_file": {
          if (!building) building = { files: new Set(), chars: 0, key };
          const path = String(result["path"] ?? args["path"] ?? "index.html");
          building.files.add(path);
          const chars = Number(result["chars"] ?? 0);
          if (Number.isFinite(chars) && chars > 0) building.chars = Math.max(building.chars, chars);
          break;
        }
        case "ask_user": {
          flushBuilding();
          const questions = askQuestions(args);
          if (questions.length > 0) {
            items.push({ kind: "ask", key, questions, answered: lastUser > i });
          }
          break;
        }
        case "show_plan": {
          flushBuilding();
          const steps = Array.isArray(args["steps"])
            ? args["steps"].map(stepText).filter(Boolean)
            : [];
          items.push({ kind: "plan", key, title: String(args["title"] ?? "Plan"), steps });
          break;
        }
        case "publish_site": {
          flushBuilding();
          const url = String(result["url"] ?? "");
          if (url) {
            items.push({
              kind: "site",
              key,
              url,
              slug: String(result["slug"] ?? args["slug"] ?? ""),
              title: typeof args["title"] === "string" && args["title"] ? args["title"] : null,
            });
          }
          break;
        }
        case "site_password": {
          flushBuilding();
          const shown = result["shown_to_user"];
          items.push({
            kind: "password",
            key,
            slug: String(result["slug"] ?? args["slug"] ?? ""),
            password: typeof shown === "string" && shown ? shown : null,
          });
          break;
        }
        case "telegram_link": {
          flushBuilding();
          const url = String(result["url"] ?? "");
          if (url) items.push({ kind: "telegram", key, url });
          break;
        }
        case "suggest_next": {
          flushBuilding();
          const action = String(args["action"] ?? "");
          if (action === "computer" || action === "connect_agent" || action === "uno_work") {
            items.push({
              kind: "suggest",
              key,
              action,
              reason: String(args["reason"] ?? ""),
              current: lastUser < i,
            });
          }
          break;
        }
        case "bot_setup": {
          flushBuilding();
          const state = botState(result["state"]);
          const days = Number(result["free_days"]);
          items.push({
            kind: "bot",
            key,
            name: String(args["name"] ?? "").trim(),
            state,
            current: lastUser < i,
            update: state === "live",
            username: optString(result["bot_username"])?.replace(/^@/, "") ?? null,
            url: optString(result["bot_url"]),
            freeUntil: optString(result["free_until"]),
            freeDays: Number.isFinite(days) && days > 0 ? days : null,
          });
          break;
        }
      }
    }
  });
  flushBuilding();
  return items;
}

/** The bot card that stays interactive: the latest one in the chat (older ones are one quiet line). */
export function latestBotKey(items: ReadonlyArray<AiItem>): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "bot") return item.key;
  }
  return null;
}

/** The question waiting for an answer right now, if any. */
export function pendingQuestion(items: ReadonlyArray<AiItem>): AiQuestion | null {
  const last = items.at(-1);
  if (!last || last.kind !== "ask" || last.answered) return null;
  return last.questions[0] ?? null;
}

/** The latest published site of the chat (what the right panel shows). */
export function latestSite(
  items: ReadonlyArray<AiItem>,
  sites: ReadonlyArray<AiSite> | null | undefined,
): { url: string; slug: string; title: string | null } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "site") return { url: item.url, slug: item.slug, title: item.title };
  }
  const site = sites?.at(-1);
  return site ? { url: site.url, slug: site.slug, title: site.title ?? null } : null;
}

export type AiChatLanguage = "ru" | "es" | "pt" | "en";

/** The chat's language, from the question (the model asks in the person's). */
export function chatLanguage(text: string): AiChatLanguage {
  if (/[а-яё]/i.test(text)) return "ru";
  if (/[ãõç]/i.test(text)) return "pt";
  if (/[ñ¿¡]/i.test(text) || /\b(qué|cómo|dónde|cuál)\b/i.test(text)) return "es";
  return "en";
}

/** The two answers every question gets, in the question's language. */
export function standardAnswers(lang: AiChatLanguage): {
  youDecide: string;
  justBuild: string;
  recommended: string;
  /** Under the answer cards (the uno.place chat's words). */
  ownWords: string;
} {
  switch (lang) {
    case "ru":
      return {
        youDecide: "Решай сам",
        justBuild: "Хватит вопросов — делай",
        recommended: "Советую",
        ownWords: "Или ответьте своими словами",
      };
    case "es":
      return {
        youDecide: "Decide tú",
        justBuild: "Basta de preguntas, hazlo",
        recommended: "Recomendado",
        ownWords: "O responde con tus palabras",
      };
    case "pt":
      return {
        youDecide: "Decida você",
        justBuild: "Chega de perguntas, faça",
        recommended: "Recomendado",
        ownWords: "Ou responda com suas palavras",
      };
    default:
      return {
        youDecide: "You decide",
        justBuild: "Just build it",
        recommended: "Recommended",
        ownWords: "Or answer in your own words",
      };
  }
}

/** What Uno is doing right now, in plain words (the line under the answer being written). */
export function liveActivity(tool: string, chars: number): string | null {
  switch (tool) {
    case "":
      return null;
    case "write_file":
      return chars > 0
        ? `Writing the site… ${Math.round(chars / 100) / 10}k characters`
        : "Writing the site…";
    case "publish_site":
      return "Putting it online…";
    case "show_plan":
      return "Making a plan…";
    case "ask_user":
      return "Thinking of a question…";
    case "site_password":
      return "Setting the password…";
    case "telegram_link":
      return "Connecting Telegram…";
    case "bot_setup":
      return "Setting up your bot…";
    default:
      return "Working…";
  }
}

/** A chat title for the list. */
export function chatTitle(title: string | null | undefined): string {
  const t = (title ?? "").trim();
  return t && t !== "New chat" ? t : "New chat";
}
