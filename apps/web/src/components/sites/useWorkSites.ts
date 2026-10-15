/**
 * The person's sites on Uno Hosting, read by the computer's daemon
 * (`uno.sites.list`). One query for every place that lists them (Apps & sites,
 * the right panel's launcher), so they share the cache.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { ensureEnvironmentApi } from "../../environmentApi";

export function useWorkSites(environmentId: EnvironmentId | null) {
  return useQuery({
    queryKey: ["uno-sites", environmentId] as const,
    queryFn: () => ensureEnvironmentApi(environmentId!).unoComputer.workSites(),
    enabled: environmentId !== null,
    refetchInterval: 60_000,
  });
}
