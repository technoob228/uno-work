/**
 * Uno Drive queries. Keys live under ["files", "cloud", …] so everything that
 * refreshes Cloud storage (uploads, deletes in the browser) refreshes Drive.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { filesApi } from "../files/filesApi";

export const driveQueryKeys = {
  all: ["files", "cloud", "drive"] as const,
  state: (environmentId: EnvironmentId | null) =>
    ["files", "cloud", "drive", "state", environmentId] as const,
  recent: (environmentId: EnvironmentId | null) =>
    ["files", "cloud", "drive", "recent", environmentId] as const,
  search: (environmentId: EnvironmentId | null, query: string) =>
    ["files", "cloud", "drive", "search", environmentId, query] as const,
  shares: (environmentId: EnvironmentId | null) =>
    ["files", "cloud", "drive", "shares", environmentId] as const,
};

export function driveStateQueryOptions(environmentId: EnvironmentId | null) {
  return queryOptions({
    queryKey: driveQueryKeys.state(environmentId),
    queryFn: () => filesApi(environmentId).driveState(),
    enabled: environmentId !== null,
    staleTime: 15_000,
    retry: 1,
  });
}

export function driveRecentQueryOptions(environmentId: EnvironmentId | null, enabled: boolean) {
  return queryOptions({
    queryKey: driveQueryKeys.recent(environmentId),
    queryFn: () => filesApi(environmentId).driveRecent({ limit: 50 }),
    enabled: environmentId !== null && enabled,
    staleTime: 10_000,
    retry: 1,
  });
}

export function driveSearchQueryOptions(environmentId: EnvironmentId | null, query: string) {
  return queryOptions({
    queryKey: driveQueryKeys.search(environmentId, query),
    queryFn: () => filesApi(environmentId).driveSearch({ query }),
    enabled: environmentId !== null && query.trim().length > 0,
    staleTime: 10_000,
    retry: 1,
  });
}

export function driveSharesQueryOptions(environmentId: EnvironmentId | null, enabled: boolean) {
  return queryOptions({
    queryKey: driveQueryKeys.shares(environmentId),
    queryFn: () => filesApi(environmentId).driveShareList(),
    enabled: environmentId !== null && enabled,
    staleTime: 10_000,
    retry: 1,
  });
}

/** How long a new link lives, as offered in the share dialog. */
export const DRIVE_SHARE_DURATIONS: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 24, label: "1 day" },
  { hours: 24 * 7, label: "7 days" },
  { hours: 24 * 30, label: "30 days" },
  { hours: 24 * 90, label: "90 days" },
];

/** "/drive" search params. */
export type DriveTab = "files" | "recent" | "links" | "telegram";

export interface DriveRouteSearch {
  readonly tab?: DriveTab;
  /** Folder inside Drive, ending in "/". */
  readonly prefix?: string;
}

const TABS: ReadonlySet<string> = new Set(["files", "recent", "links", "telegram"]);

export function parseDriveRouteSearch(search: Record<string, unknown>): DriveRouteSearch {
  const tab = typeof search["tab"] === "string" && TABS.has(search["tab"]) ? search["tab"] : null;
  const prefix = typeof search["prefix"] === "string" ? search["prefix"] : "";
  return {
    ...(tab && tab !== "files" ? { tab: tab as DriveTab } : {}),
    ...(prefix && prefix.endsWith("/") && !prefix.includes("..") && !prefix.startsWith("/")
      ? { prefix }
      : {}),
  };
}

/** The folder a key sits in ("" for the root), ending in "/". */
export function driveFolderOf(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash < 0 ? "" : key.slice(0, slash + 1);
}
