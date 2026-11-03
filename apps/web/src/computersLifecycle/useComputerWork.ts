/**
 * "Bring your work?": the projects found on one of the person's computers (key
 * names only), and bringing the chosen ones over (contracts computers.ts,
 * CONTRACT.md §2). Polls only while something runs and the screen is open.
 *
 * Until the backend has it, the cloud computer answers "Not available yet.":
 * `unavailable` is true and the screen shows chats only.
 */
import type { ComputersBringWorkInput, ComputerWorkStatus } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { ensureEnvironmentApi } from "../environmentApi";
import { computersQueryKeys, isNotAvailableYet, useComputersHostId } from "./useComputers";

const WORK_POLL_MS = 1_500;

function busy(status: ComputerWorkStatus | undefined, scanAsked: boolean): boolean {
  if (status?.scan.state === "scanning" || status?.bring.state === "running") return true;
  // A status read can land after the scan request and still say "idle": keep
  // asking until the asked-for scan shows up.
  return scanAsked && status?.scan.state === "idle";
}

export function useComputerWork(computerId: string | null, options: { scan?: boolean } = {}) {
  const hostId = useComputersHostId();
  const queryClient = useQueryClient();
  const key = computersQueryKeys.work(hostId, computerId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => ensureEnvironmentApi(hostId!).computers.workStatus({ computerId: computerId! }),
    enabled: hostId !== null && computerId !== null,
    staleTime: 0,
    retry: false,
    refetchInterval: (current) =>
      busy(current.state.data, options.scan === true) ? WORK_POLL_MS : false,
    refetchIntervalInBackground: false,
  });
  const [scanFailed, setScanFailed] = useState<unknown>(null);

  const scan = useCallback(async () => {
    if (hostId === null || computerId === null) return;
    try {
      const next = await ensureEnvironmentApi(hostId).computers.workScan({ computerId });
      queryClient.setQueryData(key, next);
      setScanFailed(null);
    } catch (cause) {
      setScanFailed(cause);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, computerId, queryClient]);

  useEffect(() => {
    if (options.scan) void scan();
  }, [options.scan, scan]);

  const bring = useCallback(
    async (projects: ComputersBringWorkInput["projects"]) => {
      if (hostId === null || computerId === null) return;
      const next = await ensureEnvironmentApi(hostId).computers.bringWork({
        computerId,
        projects,
      });
      queryClient.setQueryData(key, next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hostId, computerId, queryClient],
  );

  const unavailable = isNotAvailableYet(query.error) || isNotAvailableYet(scanFailed);
  const failed = query.error !== null || scanFailed !== null;
  const scanState = query.data?.scan.state;
  return {
    status: query.data,
    unavailable,
    /** Still looking for projects: nothing answered yet, or the scan hasn't landed. */
    searching:
      !failed &&
      (scanState === undefined ||
        scanState === "scanning" ||
        (options.scan === true && scanState === "idle")),
    /** Asked and answered (or failed): an empty list is really empty. */
    settled: query.data !== undefined || query.error !== null || scanFailed !== null,
    scan,
    bring,
  };
}
