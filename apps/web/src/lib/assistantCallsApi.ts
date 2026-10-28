/**
 * "Join my calls" (assistants/assistantCallsHttp.ts on the daemon): an
 * assistant sends the Notetaker to the person's calls.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentFetchJson } from "~/environments/http/target";

export interface CallItem {
  readonly key: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly platform: string;
  readonly platformName: string;
  readonly join: boolean;
  readonly why: string;
  readonly choice: "join" | "skip" | "";
  readonly session: { readonly status: string; readonly detail: string } | null;
}

export interface CallStatusItem {
  readonly key: string;
  readonly session: string;
  readonly title: string;
  readonly status: string;
  readonly reason: string;
  readonly text: string;
  readonly at: number;
}

export interface AssistantCallsView {
  readonly enabled: boolean;
  readonly projectId: string | null;
  readonly assistantName: string;
  readonly botName: string;
  readonly cloud: boolean;
  readonly google: {
    readonly connected: boolean;
    readonly needsReconnect: boolean;
    readonly account: string | null;
  } | null;
  readonly notetaker: {
    readonly state: "running" | "installing" | "failed" | "missing" | "unknown";
    readonly deploymentId: number | null;
  };
  readonly next: CallItem | null;
  readonly upcoming: ReadonlyArray<CallItem>;
  readonly upcomingAt: number | null;
  readonly problem: CallStatusItem | null;
  readonly recent: ReadonlyArray<CallStatusItem>;
  readonly notes: ReadonlyArray<{
    readonly meetingId: string;
    readonly title: string;
    readonly start: string;
    readonly actionItems: number;
    readonly at: number;
  }>;
}

export type EnableCallsResult =
  | { readonly ok: true; readonly view: AssistantCallsView }
  | {
      readonly ok: false;
      readonly needs: "google" | "computer" | "memory" | "assistant";
      readonly message: string;
      readonly view: AssistantCallsView;
    };

interface Scoped {
  readonly environmentId: EnvironmentId;
}

export function getAssistantCalls(input: Scoped): Promise<AssistantCallsView> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/calls",
  });
}

export function enableAssistantCalls(
  input: Scoped & { readonly projectId: string; readonly allowLowMemory?: boolean },
): Promise<EnableCallsResult> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/calls/enable",
    method: "POST",
    body: { projectId: input.projectId, allowLowMemory: input.allowLowMemory === true },
  });
}

export function disableAssistantCalls(input: Scoped): Promise<AssistantCallsView> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/calls/disable",
    method: "POST",
    body: {},
  });
}

export function setAssistantCallChoice(
  input: Scoped & { readonly key: string; readonly choice: "join" | "skip" | "" },
): Promise<AssistantCallsView> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: `/api/manager/assistant/calls/meetings/${encodeURIComponent(input.key)}`,
    method: "PUT",
    body: { choice: input.choice },
  });
}
