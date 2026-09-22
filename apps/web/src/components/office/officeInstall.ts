/**
 * "Install Office" — asks the daemon serving this page to download the office
 * engine from Uno's host (checksum-pinned) and polls its progress.
 * Server side: apps/server/src/officeEngineInstall.ts.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentFetchResponse } from "../../environments/http/target";

export interface OfficeEngineInstallStatus {
  readonly installed: boolean;
  readonly state: "idle" | "installing" | "installed" | "error";
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly error: string | null;
}

export async function fetchOfficeEngineStatus(
  environmentId: EnvironmentId,
): Promise<OfficeEngineInstallStatus> {
  const response = await environmentFetchResponse({
    environmentId,
    pathname: "/api/office-engine/status",
  });
  return (await response.json()) as OfficeEngineInstallStatus;
}

export async function requestOfficeEngineInstall(
  environmentId: EnvironmentId,
): Promise<OfficeEngineInstallStatus> {
  const response = await environmentFetchResponse({
    environmentId,
    pathname: "/api/office-engine/install",
    method: "POST",
  });
  return (await response.json()) as OfficeEngineInstallStatus;
}

export function installProgressLabel(status: OfficeEngineInstallStatus | undefined): string {
  if (!status || status.state !== "installing") return "Installing…";
  const total = Math.max(status.totalBytes, 1);
  const percent = Math.min(99, Math.floor((status.receivedBytes / total) * 100));
  return status.receivedBytes >= total ? "Unpacking…" : `Downloading… ${percent}%`;
}
