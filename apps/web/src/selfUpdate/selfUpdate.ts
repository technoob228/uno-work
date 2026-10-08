/**
 * "A new version of Uno Work is ready · Update" — the cloud computer updates
 * its own Uno Work when its owner presses the button.
 * Server side: apps/server/src/selfUpdate.ts (+ the root updater in deploy/install.sh).
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { environmentFetchJson, isEnvironmentHttpError } from "../environments/http/target";

/** Mirrors `SelfUpdateStatus` in apps/server/src/selfUpdate.ts. */
export interface SelfUpdateStatus {
  readonly supported: boolean;
  readonly canUpdate: boolean;
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  readonly available: boolean;
  readonly state: "idle" | "updating" | "done" | "failed";
  readonly step: string | null;
  readonly error: string | null;
  readonly fromVersion: string | null;
  readonly toVersion: string | null;
  readonly rolledBack: boolean;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export async function fetchSelfUpdateStatus(
  environmentId: EnvironmentId,
): Promise<SelfUpdateStatus | null> {
  try {
    return await environmentFetchJson<SelfUpdateStatus>({
      environmentId,
      pathname: "/api/self-update/status",
    });
  } catch (error) {
    // A computer on Uno Work before 0.0.113 has no such route: nothing to show.
    if (isEnvironmentHttpError(error) && error.status === 404) return null;
    throw error;
  }
}

export function requestSelfUpdate(environmentId: EnvironmentId): Promise<SelfUpdateStatus> {
  return environmentFetchJson<SelfUpdateStatus>({
    environmentId,
    pathname: "/api/self-update/start",
    method: "POST",
    body: { confirm: "update" },
  });
}

export const selfUpdateQueryKey = (environmentId: EnvironmentId | null) =>
  ["self-update", environmentId] as const;

const IDLE_REFETCH_MS = 30 * 60_000;
const UPDATING_REFETCH_MS = 2_000;

export function selfUpdateQueryOptions(environmentId: EnvironmentId | null) {
  return queryOptions({
    queryKey: selfUpdateQueryKey(environmentId),
    queryFn: () => (environmentId ? fetchSelfUpdateStatus(environmentId) : null),
    enabled: environmentId !== null,
    staleTime: 60_000,
    // While it updates the daemon restarts: requests fail for a moment and the
    // last answer ("updating") keeps the fast polling going until it is back.
    refetchInterval: (query) =>
      query.state.data?.state === "updating" ? UPDATING_REFETCH_MS : IDLE_REFETCH_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

/** A finished run is news for a day, not forever. */
const RESULT_FRESH_MS = 24 * 60 * 60_000;

export type SelfUpdateView =
  | {
      readonly kind: "available";
      readonly version: string;
      readonly canUpdate: boolean;
      readonly key: string;
    }
  | { readonly kind: "updating"; readonly version: string | null; readonly step: string }
  | {
      readonly kind: "done";
      readonly version: string;
      readonly needsReload: boolean;
      readonly key: string;
    }
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly canRetry: boolean;
      readonly version: string | null;
      readonly key: string;
    };

function isFresh(finishedAt: string | null, now: number): boolean {
  const at = finishedAt ? Date.parse(finishedAt) : Number.NaN;
  return Number.isFinite(at) && now - at < RESULT_FRESH_MS;
}

/**
 * What the app shows about updates of this computer's Uno Work, or null.
 * `key` identifies the notice for "dismissed" bookkeeping.
 */
export function resolveSelfUpdateView(input: {
  readonly status: SelfUpdateStatus | null | undefined;
  readonly clientVersion: string;
  readonly now: number;
}): SelfUpdateView | null {
  const status = input.status;
  if (!status?.supported) return null;
  if (status.state === "updating") {
    return {
      kind: "updating",
      version: status.toVersion ?? status.latestVersion,
      step: status.step ?? "Updating",
    };
  }
  if (status.state === "failed" && (status.finishedAt === null || isFresh(status.finishedAt, input.now))) {
    return {
      kind: "failed",
      message: status.error ?? "The update didn't finish.",
      canRetry: status.available && status.canUpdate,
      version: status.latestVersion,
      key: `failed:${status.finishedAt ?? status.startedAt ?? "now"}`,
    };
  }
  if (status.available && status.latestVersion) {
    return {
      kind: "available",
      version: status.latestVersion,
      canUpdate: status.canUpdate,
      key: `available:${status.latestVersion}`,
    };
  }
  if (status.state === "done" && status.toVersion && isFresh(status.finishedAt, input.now)) {
    return {
      kind: "done",
      version: status.toVersion,
      // The page was loaded from the previous version: it needs the new one.
      needsReload: input.clientVersion !== status.currentVersion,
      key: `done:${status.finishedAt}`,
    };
  }
  return null;
}

export const SELF_UPDATE_COPY = {
  availableTitle: "A new version of Uno Work is ready",
  availableBody: (version: string) =>
    `Version ${version}. Updating takes about two minutes; your chats and files stay as they are.`,
  notOwner: "The owner of this computer can update it from Uno Work.",
  update: "Update",
  later: "Later",
  confirmTitle: (version: string) => `Update Uno Work to ${version}?`,
  confirmBody:
    "It takes about two minutes. Your chats and files stay as they are. Uno Work restarts once: anything an agent is doing right now stops, and you can continue it after the update.",
  confirmSafety:
    "If the new version doesn't start, this computer goes back to the current one by itself.",
  confirm: "Update now",
  updatingTitle: (version: string | null) =>
    version ? `Updating Uno Work to ${version}…` : "Updating Uno Work…",
  updatingBody: (step: string) =>
    `${step}. About two minutes — this page comes back by itself. Your chats and files are safe.`,
  doneTitle: (version: string) => `Uno Work is updated to ${version}`,
  doneReload: "Reload this page to see the new version.",
  reload: "Reload",
  failedTitle: "Uno Work wasn't updated",
  tryAgain: "Try again",
} as const;

const DISMISSED_STORAGE_KEY = "uno:self-update-dismissed:v1";

function readDismissed(): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DISMISSED_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function isSelfUpdateNoticeDismissed(
  environmentId: EnvironmentId | null,
  key: string,
): boolean {
  return readDismissed().includes(`${environmentId}:${key}`);
}

export function dismissSelfUpdateNotice(environmentId: EnvironmentId | null, key: string): void {
  try {
    const next = [...readDismissed().filter((item) => item !== `${environmentId}:${key}`)];
    next.push(`${environmentId}:${key}`);
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(next.slice(-20)));
  } catch {
    // Best-effort UI state.
  }
}
