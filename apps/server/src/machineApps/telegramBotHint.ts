/**
 * Is the app being registered a Telegram bot?
 *
 * The brief tells the agent to register a bot with `"type": "telegram-bot"`,
 * but models forget (0.0.105 smoke: the bot came out as a plain app with
 * "Stopped / Start" instead of "Waiting for token / Open in Telegram"). So
 * `app_register` looks itself: at what the agent wrote about the app and at
 * the app's folder (a Telegram library or api.telegram.org in its code), and
 * finds the variable its token is read from. Reads names only — never the
 * token's value.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const TEXT_HINT = /telegram|\btg[-_ ]?bot\b/i;

const CODE_HINT =
  /api\.telegram\.org|\btelegraf\b|\bgrammy\b|\baiogram\b|python-telegram-bot|\btelegram\.ext\b|\btelebot\b|pytelegrambotapi|node-telegram-bot-api|go-telegram-bot-api|telegram-bot-api|\btelethon\b|\bpyrogram\b|gopkg\.in\/telebot|\bteloxide\b/i;

const CODE_EXTENSIONS = new Set([
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".go",
  ".rb",
  ".php",
  ".rs",
  ".sh",
]);
const MANIFEST_FILES = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Gemfile",
  "Cargo.toml",
  "composer.json",
  "Pipfile",
]);
const ENV_EXAMPLE_FILES = new Set([".env.example", ".env.sample", ".env.template", "env.example"]);
const SOURCE_DIRS = ["src", "app", "bot"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist"]);

const MAX_FILES = 60;
const MAX_FILE_BYTES = 200_000;

/** `process.env.X`, `os.environ["X"]`, `os.getenv("X")`, `os.Getenv("X")`, `ENV["X"]`, `env("X")`. */
const ENV_READ =
  /(?:process\.env\.|process\.env\[\s*["'`]|os\.environ(?:\.get)?\s*[[(]\s*["']|getenv\(\s*["']|Getenv\(\s*"|ENV\[\s*["']|env::var\(\s*"|\benv\(\s*["'])([A-Za-z_][A-Za-z0-9_]*)/g;

/** What the agent wrote about the app says "Telegram". */
export function saysTelegramBot(record: Readonly<Record<string, unknown>>): boolean {
  return ["name", "description", "command", "cwd"].some(
    (key) => typeof record[key] === "string" && TEXT_HINT.test(record[key] as string),
  );
}

/** The best token variable among the names the code reads: `TELEGRAM_BOT_TOKEN` over `BOT_TOKEN` over `TOKEN`. */
export function pickTokenEnv(names: Iterable<string>): string | null {
  let best: { name: string; score: number } | null = null;
  for (const name of names) {
    const upper = name.toUpperCase();
    if (!upper.includes("TOKEN")) continue;
    const score =
      (/(TELEGRAM|(^|_)TG(_|$))/.test(upper) ? 4 : 0) + (upper.includes("BOT") ? 2 : 0) + 1;
    if (best === null || score > best.score) best = { name, score };
  }
  return best?.name ?? null;
}

export interface TelegramBotScan {
  /** The folder's code talks to Telegram. */
  readonly isBot: boolean;
  /** The variable the token is read from, when the code names one. */
  readonly tokenEnv: string | null;
}

/** Pure part of the scan: the text of the folder's files, already read. */
export function scanTelegramBotTexts(
  files: ReadonlyArray<{ readonly name: string; readonly text: string }>,
): TelegramBotScan {
  let isBot = false;
  const names = new Set<string>();
  for (const file of files) {
    if (CODE_HINT.test(file.text)) isBot = true;
    if (ENV_EXAMPLE_FILES.has(file.name)) {
      for (const line of file.text.split("\n")) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (match?.[1]) names.add(match[1]);
      }
      continue;
    }
    for (const match of file.text.matchAll(ENV_READ)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return { isBot, tokenEnv: isBot ? pickTokenEnv(names) : null };
}

async function collect(dir: string, depth: number, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (
        CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) ||
        MANIFEST_FILES.has(entry.name) ||
        ENV_EXAMPLE_FILES.has(entry.name)
      ) {
        out.push(full);
      }
    } else if (
      entry.isDirectory() &&
      depth === 0 &&
      SOURCE_DIRS.includes(entry.name) &&
      !SKIP_DIRS.has(entry.name)
    ) {
      await collect(full, depth + 1, out);
    }
  }
}

/** Looks at the app's folder (its top level and src/, app/, bot/). Never throws; never reads `.env`. */
export async function scanFolderForTelegramBot(cwd: string): Promise<TelegramBotScan> {
  const paths: string[] = [];
  await collect(cwd, 0, paths);
  const files: Array<{ name: string; text: string }> = [];
  for (const file of paths) {
    try {
      const info = await stat(file);
      if (info.size > MAX_FILE_BYTES) continue;
      files.push({ name: path.basename(file), text: await readFile(file, "utf8") });
    } catch {
      // unreadable: skip
    }
  }
  return scanTelegramBotTexts(files);
}
