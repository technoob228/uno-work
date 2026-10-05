/**
 * Plain words around `request_secret`, shared by the daemon (Inbox title, the
 * late answer it sends into the chat) and the client (the masked-field card,
 * how that late answer reads in the chat).
 *
 * The late answer is a message to the agent ("(Uno Work) The person entered
 * TELEGRAM_BOT_TOKEN — it is saved in …"). The person saw it as their own
 * chat bubble, raw (live walkthrough 05.10.2026); the client now recognises it
 * with {@link parseUnoWorkNote} and shows one quiet line instead.
 */

/** Marks a message the computer (not the person) put into a chat for its agent. */
export const UNO_WORK_NOTE_PREFIX = "(Uno Work) ";

const KNOWN_WORDS: Readonly<Record<string, string>> = {
  API: "API",
  AI: "AI",
  ID: "ID",
  URL: "URL",
  OPENAI: "OpenAI",
  OPENROUTER: "OpenRouter",
  ANTHROPIC: "Anthropic",
  TELEGRAM: "Telegram",
  TG: "Telegram",
  GITHUB: "GitHub",
  STRIPE: "Stripe",
  SLACK: "Slack",
  DISCORD: "Discord",
  GOOGLE: "Google",
  NOTION: "Notion",
  WHATSAPP: "WhatsApp",
};

/**
 * The assistant's own Telegram bot (assistant_connect, decision 05.10: the
 * assistant lives in the person's own bot from @BotFather, not in Uno's shared
 * bot, which also carries payments, the course and support). The value goes
 * into the assistant's Telegram settings, never into an env file.
 */
export const ASSISTANT_BOT_TOKEN_NAME = "ASSISTANT_TELEGRAM_BOT_TOKEN";

/** The card over the composer for {@link ASSISTANT_BOT_TOKEN_NAME}. */
export const ASSISTANT_BOT_CARD = {
  title: "Create your assistant's bot",
  note: "It stays on your computer: only your assistant uses it.",
  placeholder: "Paste the token here",
} as const;

/**
 * Plain words for an env name: `TELEGRAM_BOT_TOKEN` → "Telegram bot token",
 * `OPENAI_API_KEY` → "OpenAI API key". Unknown shapes keep the name.
 */
export function humanSecretLabel(name: string): string {
  if (name === ASSISTANT_BOT_TOKEN_NAME) return "assistant's Telegram bot token";
  const parts = name
    .split("_")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return name;
  const tail = parts[parts.length - 1]!.toUpperCase();
  if (!["TOKEN", "KEY", "SECRET", "PASSWORD", "PASS", "PWD"].includes(tail)) return name;
  return parts
    .map((part) => KNOWN_WORDS[part.toUpperCase()] ?? part.toLowerCase())
    .map((word) => (word === "pwd" || word === "pass" ? "password" : word))
    .join(" ");
}

export interface SecretHelp {
  /** The button: "Open @BotFather". */
  readonly label: string;
  readonly url: string;
  /** Short steps, in order, shown under the field. */
  readonly steps: ReadonlyArray<string>;
}

/** A Telegram bot's token: the name says Telegram (or TG) and bot/token. */
export function isTelegramBotTokenName(name: string): boolean {
  const upper = name.toUpperCase();
  return /(^|_)(TELEGRAM|TG)(_|$)/.test(upper) && /(^|_)(BOT|TOKEN)(_|$)/.test(upper);
}

/**
 * Where the person gets this secret, when Uno knows it: a Telegram bot token
 * comes from @BotFather — the one step Telegram never lets anyone do for them.
 */
export function secretHelp(name: string): SecretHelp | null {
  if (name === ASSISTANT_BOT_TOKEN_NAME) {
    return {
      label: "Open @BotFather",
      url: "https://t.me/BotFather",
      steps: ["Send /newbot.", "Name it.", "Paste the token here."],
    };
  }
  if (isTelegramBotTokenName(name)) {
    return {
      label: "Open @BotFather",
      url: "https://t.me/BotFather",
      steps: [
        "Open @BotFather in Telegram and send /newbot.",
        "Give the bot a name and a username ending in “bot”.",
        "Copy the token it sends and paste it here.",
      ],
    };
  }
  return null;
}

/** The message the chat gets when the person answers a queued request (to the agent). */
export function lateSecretMessage(input: {
  readonly name: string;
  readonly cwd: string;
  readonly outcome: {
    readonly ok: boolean;
    readonly name?: string;
    readonly file?: string;
    readonly error?: string;
    readonly botUsername?: string;
  };
}): string {
  if (input.outcome.ok && input.name === ASSISTANT_BOT_TOKEN_NAME) {
    const bot = input.outcome.botUsername ? `@${input.outcome.botUsername}` : "its bot";
    return `${UNO_WORK_NOTE_PREFIX}The person connected the assistant's own Telegram bot ${bot}. The token is in the assistant's settings, not in a file. The Connect Telegram window shows them Open ${bot} → Start; when they press Start, the bot says hello there. Don't ask for the token again: tell them in one line to press Start, and finish setting up what they asked.`;
  }
  if (input.outcome.ok) {
    const file = input.outcome.file ?? ".env";
    return `${UNO_WORK_NOTE_PREFIX}The person entered ${input.name} — it is saved in ${input.cwd}/${file}. Read it from there (never print it) and continue where you stopped.`;
  }
  return `${UNO_WORK_NOTE_PREFIX}The person didn't give ${input.name} (${input.outcome.error ?? "declined"}). Don't ask again right away — tell them what it is needed for and how to add it later.`;
}

export type UnoWorkNote =
  | { readonly kind: "assistant-bot-connected"; readonly text: string }
  | { readonly kind: "secret-saved"; readonly name: string; readonly text: string }
  | { readonly kind: "secret-declined"; readonly name: string; readonly text: string }
  | { readonly kind: "other"; readonly text: string };

/**
 * A message the computer wrote for the agent, in the person's words; null for
 * anything the person (or another agent) wrote.
 */
export function parseUnoWorkNote(text: string): UnoWorkNote | null {
  if (!text.startsWith(UNO_WORK_NOTE_PREFIX)) return null;
  const body = text.slice(UNO_WORK_NOTE_PREFIX.length);
  const bot =
    /^The person connected the assistant's own Telegram bot (@[A-Za-z0-9_]+|its bot)\./.exec(body);
  if (bot) {
    const name = bot[1] === "its bot" ? "your assistant's bot" : bot[1]!;
    return {
      kind: "assistant-bot-connected",
      text: `You connected ${name}. Press Start in Telegram: your assistant says hi there.`,
    };
  }
  const saved = /^The person entered ([A-Za-z_][A-Za-z0-9_]*) —/.exec(body);
  if (saved) {
    const name = saved[1]!;
    return {
      kind: "secret-saved",
      name,
      text: `You saved the ${humanSecretLabel(name)}. It stays on your computer, not in the chat.`,
    };
  }
  const declined = /^The person didn't give ([A-Za-z_][A-Za-z0-9_]*) /.exec(body);
  if (declined) {
    const name = declined[1]!;
    return {
      kind: "secret-declined",
      name,
      text: `You skipped the ${humanSecretLabel(name)}. You can add it later.`,
    };
  }
  return { kind: "other", text: "Uno Work updated this chat." };
}
