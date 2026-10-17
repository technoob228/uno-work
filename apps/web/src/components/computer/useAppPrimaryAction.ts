/**
 * Runs an app's one primary action (`appPrimaryAction`): Open (already signed
 * in with Uno when the app can; a web app only the computer reaches — in the
 * computer's own browser), Start and then open, Settings (⚙), or a chat with
 * Uno that fixes it. Shared by Home, the desktop grid, the sidebar and Apps &
 * sites, so a click does the same thing everywhere.
 */
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, UnoMachineAppActionInput } from "@t3tools/contracts";
import { useCallback } from "react";

import { openInNewTab, useOpenApp } from "../../navigation/useOpenApp";
import { toastManager } from "../ui/toast";
import { appPrimaryAction, type AppPrimaryAction } from "./appPrimaryAction";
import { machineAppActionMutationOptions } from "./computerQueries";
import type { ProgramTile } from "./programModel";
import { useHomeLaunchers } from "./useHomeLaunchers";

/**
 * "Show on the internet" is the person's own click, but the address is
 * public: say so before it happens.
 */
export function confirmShowOnInternet(name: string): boolean {
  return window.confirm(
    `Show ${name} on the internet?\n\nIt gets a public address you can open on any device. Anyone with the address can reach it, so do this for apps with their own sign-in or meant to be public. You can hide it again.`,
  );
}

/** A program with a page to show once it runs: a web port, or an address of its own. */
function hasWindow(tile: ProgramTile): boolean {
  const app = tile.machineApp;
  if (!app || app.telegramBot) return false;
  return app.url !== null || app.port !== null;
}

export interface AppPrimaryRunner {
  /** Do the tile's primary action. Returns the action it ran. */
  readonly run: (tile: ProgramTile) => AppPrimaryAction;
  /** The program being started right now, by machine app id; null when none. */
  readonly startingId: string | null;
}

export function useAppPrimaryAction(input: {
  readonly environmentId: EnvironmentId | null;
  /** Another cloud computer picked on Home; null = this machine. */
  readonly boxId?: number | null;
}): AppPrimaryRunner {
  const { environmentId } = input;
  const queryClient = useQueryClient();
  const { openHere, openComputerApp } = useOpenApp();
  const navigate = useNavigate();
  const launchers = useHomeLaunchers(environmentId);
  const start = useMutation(machineAppActionMutationOptions(environmentId, queryClient));
  const { sendToUno } = launchers;
  const startMutate = start.mutate;

  const run = useCallback(
    (tile: ProgramTile): AppPrimaryAction => {
      const action = appPrimaryAction(tile);
      switch (action.kind) {
        case "open": {
          // Sign in with Uno apps too: inside Uno Work, already signed in — the
          // window loads the app's one-time sign-in link first (AppView), and the
          // console keeps that sign-in in Uno Work's partition (Misha 17.10:
          // "inside Work the app opens without its password").
          openHere({ url: action.url!, name: tile.name, icon: tile.icon });
          break;
        }
        case "openOnComputer":
          openComputerApp({ key: tile.key, name: tile.name, icon: tile.icon });
          break;
        case "settings":
          void navigate({ to: "/computer", search: { app: tile.key } });
          break;
        case "start":
          if (action.machineAppId) {
            // Something to look at (a web page): its window says "Starting…"
            // and shows the app once it answers. A program without one starts
            // in place — the tile says "Starting…".
            if (hasWindow(tile)) {
              // The window starts it (AppView), so a reload there starts it too.
              openComputerApp({ key: tile.key, name: tile.name, icon: tile.icon });
              break;
            }
            startMutate(
              { appId: action.machineAppId, action: "start" },
              {
                onError: (error) =>
                  toastManager.add({
                    type: "error",
                    title: `${tile.name} didn't start`,
                    description: error instanceof Error ? error.message : String(error),
                  }),
              },
            );
          } else if (action.prompt) {
            void sendToUno(action.prompt);
          }
          break;
        case "telegram":
          if (action.url) openInNewTab(action.url);
          break;
        case "token":
        case "fix":
          if (action.prompt) void sendToUno(action.prompt);
          break;
        case "installing":
        case "asleep":
          break;
      }
      return action;
    },
    [navigate, openComputerApp, openHere, sendToUno, startMutate],
  );

  return {
    run,
    startingId: start.isPending ? (start.variables?.appId ?? null) : null,
  };
}

/**
 * The program some Start is starting right now (from any surface — a tile, the
 * sidebar, the app's card), by machine app id; null when none.
 */
export function useStartingAppId(): string | null {
  const starting = useMutationState({
    filters: { mutationKey: ["uno-computer", "app-action"], status: "pending" },
    select: (mutation) => mutation.state.variables as UnoMachineAppActionInput | undefined,
  });
  return starting.find((input) => input?.action === "start")?.appId ?? null;
}
