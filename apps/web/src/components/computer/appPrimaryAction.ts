/**
 * One obvious action per app — a click opens it, like an app on a PC (Misha
 * 16.10: "a click offers to set it up instead of opening it — nonsense").
 * Wherever apps are listed (Home's Apps widget, the desktop grid, the sidebar,
 * Apps & sites) the app's state picks exactly one primary action:
 *
 * | state                                              | click                |
 * |----------------------------------------------------|----------------------|
 * | installing                                         | Installing… (off)    |
 * | the computer is asleep                             | Asleep (off)         |
 * | a Telegram bot waiting for its token (even stopped) | Add the token       |
 * | stopped / failed / unknown, and it can start here  | Start, then open     |
 * | failed / unknown, can't start here                 | Fix with Uno         |
 * | stopped, can't start here                          | Start (asks Uno)     |
 * | a Telegram bot with a username                     | Open in Telegram     |
 * | running with a web address this browser reaches    | Open                 |
 * | a web app only the computer itself reaches         | Open — in the computer's own browser |
 * | running, nothing to open (CLI app, script, …)      | Settings (⚙)         |
 *
 * "Start" starts it right here and the app's window shows "Starting…" until it
 * answers (AppView). Settings — address, internet, start/stop, remove — is the
 * ⚙ on the tile and its right-click; "Show on the internet" lives there, never
 * on a click.
 *
 * Pure, so the table above is tested directly.
 */
import type { ProgramTile } from "./programModel";

export type AppPrimaryKind =
  | "open"
  | "openOnComputer"
  | "settings"
  | "telegram"
  | "token"
  | "start"
  | "fix"
  | "installing"
  | "asleep";

export interface AppPrimaryAction {
  readonly kind: AppPrimaryKind;
  /** The button's words. */
  readonly label: string;
  /** Nothing to do yet (installing, asleep): the button is shown, turned off. */
  readonly disabled: boolean;
  /** `open` / `openOnComputer`: the address (for `openOnComputer`, `localhost` on the computer). */
  readonly url: string | null;
  /** `start` / `openOnComputer` / `settings`: the program's id on this computer. */
  readonly machineAppId: string | null;
  /** `token` / `fix` / a `start` this computer can't do itself: what Uno is asked. */
  readonly prompt: string | null;
}

const LABEL: Record<AppPrimaryKind, string> = {
  open: "Open",
  openOnComputer: "Open",
  settings: "Settings",
  telegram: "Open in Telegram",
  token: "Add token",
  start: "Start",
  fix: "Fix with Uno",
  installing: "Installing…",
  asleep: "Asleep",
};

function action(
  kind: AppPrimaryKind,
  patch: Partial<Pick<AppPrimaryAction, "url" | "machineAppId" | "prompt">> = {},
): AppPrimaryAction {
  return {
    kind,
    label: LABEL[kind],
    disabled: kind === "installing" || kind === "asleep",
    url: patch.url ?? null,
    machineAppId: patch.machineAppId ?? null,
    prompt: patch.prompt ?? null,
  };
}

/** The app as Uno should hear it: "Files & documents (Nextcloud)". */
function spokenName(tile: ProgramTile): string {
  return tile.product ? `${tile.name} (${tile.product})` : tile.name;
}

export function fixPrompt(tile: ProgramTile): string {
  return `${spokenName(tile)} isn't working. Find out why and fix it.`;
}

export function startPrompt(tile: ProgramTile): string {
  return `Start ${spokenName(tile)} on this computer and make sure it starts again after a restart.`;
}

export function tokenPrompt(tile: ProgramTile): string {
  return `${spokenName(tile)} is waiting for its Telegram token. Ask me for it with the secure field (I'll copy it from @BotFather), then start the bot and check it answers.`;
}

/** Where a web app answers inside its computer — only that computer's browser can open it. */
export function computerLocalUrl(tile: ProgramTile): string | null {
  const app = tile.machineApp;
  if (!app?.http) return null;
  return app.localUrl ?? (app.port !== null ? `http://localhost:${app.port}/` : null);
}

export function appPrimaryAction(tile: ProgramTile): AppPrimaryAction {
  const app = tile.machineApp;
  // A Telegram bot that waits for its token needs the token, whatever its
  // process does meanwhile: most bots exit without one, and "Start" (or "Fix")
  // would only crash it again (0.0.105 showed "Stopped / Start" here).
  if (
    app?.telegramBot?.tokenReady === false &&
    tile.status !== "installing" &&
    tile.status !== "asleep"
  ) {
    return action("token", { prompt: tokenPrompt(tile) });
  }
  switch (tile.status) {
    case "installing":
      return action("installing");
    case "asleep":
      return action("asleep");
    case "failed":
      // Like a PC: clicking an app that quit starts it again.
      return app?.canStart
        ? action("start", { machineAppId: app.id })
        : action("fix", { prompt: fixPrompt(tile) });
    case "stopped":
      return app?.canStart
        ? action("start", { machineAppId: app.id })
        : action("start", { prompt: startPrompt(tile) });
    case "running":
    case "unknown":
      break;
  }
  const bot = app?.telegramBot;
  if (bot) {
    if (bot.tokenReady === false) return action("token", { prompt: tokenPrompt(tile) });
    if (bot.link) return action("telegram", { url: bot.link });
  }
  if (tile.openUrl) return action("open", { url: tile.openUrl });
  if (tile.status === "unknown") {
    // A program that says it can start is simply not running; anything else isn't answering.
    return app?.canStart
      ? action("start", { machineAppId: app.id })
      : action("fix", { prompt: fixPrompt(tile) });
  }
  const local = computerLocalUrl(tile);
  if (local && app && !app.telegramBot) {
    return action("openOnComputer", { url: local, machineAppId: app.id });
  }
  // Nothing to open: the click is the app's settings.
  return action("settings", { machineAppId: app?.id ?? null });
}
