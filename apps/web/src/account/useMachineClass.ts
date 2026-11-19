/**
 * The account's machine class for a new computer (account/machineClass.ts),
 * read from the console as the signed-in person. Under `["workspace", …]`:
 * signing in refreshes it with the rest of the account.
 */
import { queryOptions, useQuery } from "@tanstack/react-query";

import { type MachineClassSettings, parseMachineClassSettings } from "./machineClass";
import { accountRequest, accountTransport } from "./unoAccount";

export const machineClassQueryKey = ["workspace", "machineClass"] as const;

/** No answer (an older console, signed out, a refusal) = no choice to show. */
export async function fetchMachineClassSettings(): Promise<MachineClassSettings | null> {
  try {
    return parseMachineClassSettings(await accountRequest("GET", "/api/v1/account/machine-class"));
  } catch {
    return null;
  }
}

export const machineClassQuery = () =>
  queryOptions({
    queryKey: machineClassQueryKey,
    queryFn: fetchMachineClassSettings,
    enabled: accountTransport() !== "none",
    staleTime: 60_000,
  });

/** The settings when the console offers the choice; null hides it. */
export function useMachineClassSettings(): MachineClassSettings | null {
  const settings = useQuery(machineClassQuery()).data ?? null;
  return settings?.enabled ? settings : null;
}
