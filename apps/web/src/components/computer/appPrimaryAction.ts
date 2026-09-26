/**
 * One obvious button per app — "tap, and it goes". Wherever apps are listed
 * (Home's Apps widget, the desktop grid, the sidebar, the app's card) the app's
 * state picks exactly one primary action:
 *
 * | state                                              | button               |
 * |----------------------------------------------------|----------------------|
 * | installing                                         | Installing… (off)    |
 * | the computer is asleep                             | Asleep (off)         |
 * | failed / didn't install / status unknown, no address | Fix with Uno       |
 * | stopped                                            | Start                |
 * | running with a web address                         | Open                 |
 * | running, no web address (CLI app, custom app, …)   | Set up with Uno      |
 *
 * "Start" starts it right here when this computer can (a container, an app
 * Uno registered); otherwise it asks Uno to. "Set up with Uno" and "Fix with
 * Uno" start a chat with Uno that already says what to do. Everything else —
 * Stop, Remove, Open beside a chat, Pin — stays secondary.
 *
 * Pure, so the table above is tested directly.
 */
import type { ProgramTile } from "./programModel";

export type AppPrimaryKind = "open" | "start" | "setup" | "fix" | "installing" | "asleep";

export interface AppPrimaryAction {
  readonly kind: AppPrimaryKind;
  /** The button's words. */
  readonly label: string;
  /** Nothing to do yet (installing, asleep): the button is shown, turned off. */
  readonly disabled: boolean;
  /** `open`: the address. */
  readonly url: string | null;
  /** `start` on this computer: the program's id for `uno.computer.machineAppAction`. */
  readonly machineAppId: string | null;
  /** `setup` / `fix` / a `start` this computer can't do itself: what Uno is asked. */
  readonly prompt: string | null;
}

const LABEL: Record<AppPrimaryKind, string> = {
  open: "Open",
  start: "Start",
  setup: "Set up with Uno",
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

export function setupPrompt(tile: ProgramTile): string {
  return `Help me set up ${spokenName(tile)} on this computer. Ask me only what you need.`;
}

export function fixPrompt(tile: ProgramTile): string {
  return `${spokenName(tile)} isn't working. Find out why and fix it.`;
}

export function startPrompt(tile: ProgramTile): string {
  return `Start ${spokenName(tile)} on this computer and make sure it starts again after a restart.`;
}

export function appPrimaryAction(tile: ProgramTile): AppPrimaryAction {
  const app = tile.machineApp;
  switch (tile.status) {
    case "installing":
      return action("installing");
    case "asleep":
      return action("asleep");
    case "failed":
      return action("fix", { prompt: fixPrompt(tile) });
    case "stopped":
      return app?.canStart
        ? action("start", { machineAppId: app.id })
        : action("start", { prompt: startPrompt(tile) });
    case "running":
    case "unknown":
      break;
  }
  if (tile.openUrl) return action("open", { url: tile.openUrl });
  if (tile.status === "unknown") {
    // A program that says it can start is simply not running; anything else isn't answering.
    return app?.canStart
      ? action("start", { machineAppId: app.id })
      : action("fix", { prompt: fixPrompt(tile) });
  }
  return action("setup", { prompt: setupPrompt(tile) });
}
