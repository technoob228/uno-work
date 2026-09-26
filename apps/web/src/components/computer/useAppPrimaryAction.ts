/**
 * Runs an app's one primary action (`appPrimaryAction`): Open (already signed
 * in with Uno when the app can), Start, or a chat with Uno that sets it up or
 * fixes it. Shared by Home, the desktop grid, the sidebar and the app's card,
 * so the same button does the same thing everywhere.
 */
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import type { EnvironmentId, UnoMachineAppActionInput } from "@t3tools/contracts";
import { useCallback } from "react";

import { useOpenApp } from "../../navigation/useOpenApp";
import { toastManager } from "../ui/toast";
import { appPrimaryAction, type AppPrimaryAction } from "./appPrimaryAction";
import { appSignInApi, machineAppActionMutationOptions } from "./computerQueries";
import { openAppSignedIn } from "./openSignedIn";
import type { ProgramTile } from "./programModel";
import { useHomeLaunchers } from "./useHomeLaunchers";

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
  const boxId = input.boxId ?? null;
  const queryClient = useQueryClient();
  const { openHere } = useOpenApp();
  const launchers = useHomeLaunchers(environmentId);
  const start = useMutation(machineAppActionMutationOptions(environmentId, queryClient));
  const { sendToUno } = launchers;
  const startMutate = start.mutate;

  const run = useCallback(
    (tile: ProgramTile): AppPrimaryAction => {
      const action = appPrimaryAction(tile);
      switch (action.kind) {
        case "open": {
          const store = tile.storeApp;
          const url = action.url!;
          if (store?.sso && store.deploymentId !== null) {
            // Sign in with Uno: the app opens already signed in, in its own tab —
            // the Uno sign-in cookie can't work inside Uno Work's cross-site frame.
            const deploymentId = store.deploymentId;
            const signIn = appSignInApi(environmentId, boxId);
            void openAppSignedIn(() => signIn.openLink(deploymentId), url);
          } else {
            openHere({ url, name: tile.name, icon: tile.icon });
          }
          break;
        }
        case "start":
          if (action.machineAppId) {
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
        case "setup":
        case "fix":
          if (action.prompt) void sendToUno(action.prompt);
          break;
        case "installing":
        case "asleep":
          break;
      }
      return action;
    },
    [boxId, environmentId, openHere, sendToUno, startMutate],
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
