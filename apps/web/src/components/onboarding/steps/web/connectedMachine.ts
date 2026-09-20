import type { MachineKind } from "@t3tools/contracts";

import type { useServerConfig } from "~/rpc/serverState";

export interface ConnectedMachineSummary {
  readonly label: string;
  readonly platformLabel: string;
  readonly serverVersion: string | null;
  readonly workingDirectory: string | null;
}

/**
 * Human-readable facts about the machine this tab is connected to (the primary
 * environment), shared by the browser onboarding steps that show it.
 */
export function describeConnectedMachine(
  serverConfig: ReturnType<typeof useServerConfig>,
): ConnectedMachineSummary {
  const platform = serverConfig?.environment.platform;
  return {
    label: serverConfig?.environment.label ?? "your machine",
    platformLabel: platform ? `${platform.os}/${platform.arch}` : "connecting…",
    serverVersion: serverConfig?.environment.serverVersion ?? null,
    workingDirectory: serverConfig?.cwd ?? null,
  };
}

/**
 * What kind of machine this is, in the user's words. `null` when the daemon
 * predates the `machineKind` field — then the UI simply omits the row instead
 * of guessing.
 */
export function machineKindLabel(machineKind: MachineKind | undefined): string | null {
  switch (machineKind) {
    case "uno_box":
      return "Uno cloud box";
    case "computer":
      return "Personal computer";
    case "server":
      return "Server";
    default:
      return null;
  }
}
