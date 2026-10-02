/**
 * The console side of assistants (MVP contract §1–§3), called as the signed-in
 * person (`accountRequest`): which computers are assistants, their connector
 * permissions, their schedules.
 *
 * The console (fishcode 567d969, knowledge/assistants-mvp.md) has these behind
 * its `ASSISTANTS_MVP` flag: `/auth/me` lists `assistants_mvp` in `features`
 * for an account that has it; without it the permission routes answer 404 —
 * "not on your account yet", not an error: the screens say so and keep working.
 *
 * `VITE_ASSISTANTS_DEMO=1` builds swap all of it for an in-memory account
 * (`assistantsDemo.ts`) so the flow can be walked on a local stand.
 */
import { controlPlaneErrorStatus } from "@t3tools/shared/unoCloud";

import { accountRequest } from "../account/unoAccount";
import {
  CONNECTOR_PROVIDERS,
  findTemplate,
  isConnectorLevel,
  promptFromCommand,
  type AssistantLabel,
  type ConnectorLevel,
  type ConnectorPermissions,
  type ConnectorProvider,
} from "../components/assistants/assistantTemplates";
import { assistantsDemo, isAssistantsDemo } from "./assistantsDemo";

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 404/405: the console doesn't have this route (yet, or the flag is off). */
export function isRouteMissing(cause: unknown): boolean {
  const status = controlPlaneErrorStatus(cause);
  return status === 404 || status === 405 || status === 501;
}

// ── Assistant computers ──────────────────────────────────────────────

export interface AssistantComputer {
  readonly boxId: number;
  readonly boxName: string;
  readonly status: string;
  readonly label: AssistantLabel;
  readonly createdAt: string | null;
  /**
   * Deleted and kept until `purgeAt` (7 days, console decision 02.10): its
   * disk waits in an archive and Restore brings it back. Null = live.
   */
  readonly deletedAt: string | null;
  readonly purgeAt: string | null;
}

/** Deleted assistants stay this long before they are gone for good. */
export const ASSISTANT_KEEP_DAYS = 7;

/** "Kept until Oct 9" under a deleted assistant (local date). */
export function keptUntilText(purgeAt: string | null): string {
  const at = purgeAt ? new Date(purgeAt) : null;
  if (!at || Number.isNaN(at.getTime())) return `Kept for ${ASSISTANT_KEEP_DAYS} days`;
  return `Kept until ${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

/** A box of `GET /api/v1/boxes` that is an assistant's home, or null. */
export function parseAssistantComputer(raw: unknown): AssistantComputer | null {
  const r = rec(raw);
  if (!r) return null;
  const boxId = typeof r["id"] === "number" ? r["id"] : -1;
  const status = str(r["status"]) || "unknown";
  if (boxId <= 0 || status === "deleted") return null;
  const meta = rec(r["assistant"]);
  if (str(r["computer_role"]).toLowerCase() !== "assistant" && !meta) return null;
  const label: AssistantLabel = {
    name: str(meta?.["name"]).trim() || str(r["name"]) || `assistant-${boxId}`,
    emoji: str(meta?.["emoji"]) || "🤖",
    template: findTemplate(str(meta?.["template"]))?.id ?? null,
  };
  return {
    boxId,
    boxName: str(r["name"]) || `box-${boxId}`,
    status,
    label,
    createdAt: str(meta?.["created_at"]) || str(r["created_at"]) || null,
    deletedAt: str(meta?.["deleted_at"]) || null,
    purgeAt: str(meta?.["purge_at"]) || null,
  };
}

/** Assistants on their own computers are switched on for this account. */
export async function fetchAssistantsEnabled(): Promise<boolean> {
  if (isAssistantsDemo) return true;
  const me = rec(await accountRequest("GET", "/auth/me"));
  const features = me?.["features"];
  return Array.isArray(features) && features.includes("assistants_mvp");
}

export async function listAssistantComputers(): Promise<ReadonlyArray<AssistantComputer>> {
  if (isAssistantsDemo) return assistantsDemo.listComputers();
  const raw = await accountRequest("GET", "/api/v1/boxes");
  const list = Array.isArray(raw) ? raw : (rec(raw)?.["boxes"] ?? []);
  return (Array.isArray(list) ? list : [])
    .map(parseAssistantComputer)
    .filter((computer): computer is AssistantComputer => computer !== null);
}

/**
 * Delete an assistant: the console keeps it for ASSISTANT_KEEP_DAYS (its disk
 * goes to an archive) and then deletes the computer for good.
 */
export async function deleteAssistantComputer(boxId: number): Promise<void> {
  if (isAssistantsDemo) return assistantsDemo.deleteComputer(boxId);
  await accountRequest("DELETE", `/api/v1/boxes/${boxId}`);
}

/** Bring a deleted assistant back (within ASSISTANT_KEEP_DAYS). */
export async function restoreAssistantComputer(boxId: number): Promise<void> {
  if (isAssistantsDemo) return assistantsDemo.restoreComputer(boxId);
  await accountRequest("POST", `/api/v1/boxes/${boxId}/assistant/restore`);
}

// ── Connector permissions (contract §2) ──────────────────────────────

export type ConnectorPermissionsState =
  | { readonly supported: false }
  | {
      readonly supported: true;
      /** The console limits this computer's apps; false = it reaches every app (no rows). */
      readonly restricted: boolean;
      readonly permissions: ConnectorPermissions;
    };

export function parseConnectorPermissions(raw: unknown): ConnectorPermissionsState {
  const r = rec(raw);
  const map = rec(r?.["permissions"]) ?? {};
  const fallback = isConnectorLevel(r?.["default"]) ? (r!["default"] as ConnectorLevel) : "write";
  const permissions = {} as Record<ConnectorProvider, ConnectorLevel>;
  for (const provider of CONNECTOR_PROVIDERS) {
    const level = map[provider];
    permissions[provider] = isConnectorLevel(level) ? level : fallback;
  }
  return { supported: true, restricted: r?.["restricted"] === true, permissions };
}

export async function getConnectorPermissions(boxId: number): Promise<ConnectorPermissionsState> {
  if (isAssistantsDemo) return assistantsDemo.getPermissions(boxId);
  try {
    return parseConnectorPermissions(
      await accountRequest("GET", `/api/v1/boxes/${boxId}/work/connector-permissions`),
    );
  } catch (cause) {
    if (isRouteMissing(cause)) return { supported: false };
    throw cause;
  }
}

/**
 * The whole computer at once: a provider left out becomes `none` on the
 * console, so this always sends all four. False when the console can't store
 * them yet (route missing).
 */
export async function putConnectorPermissions(
  boxId: number,
  permissions: ConnectorPermissions,
): Promise<boolean> {
  if (isAssistantsDemo) return assistantsDemo.putPermissions(boxId, permissions);
  try {
    await accountRequest("PUT", `/api/v1/boxes/${boxId}/work/connector-permissions`, {
      permissions,
    });
    return true;
  } catch (cause) {
    if (isRouteMissing(cause)) return false;
    throw cause;
  }
}

// ── Schedules (contract §3) ──────────────────────────────────────────

export interface AssistantSchedule {
  readonly id: number;
  readonly name: string;
  readonly cron: string;
  readonly timezone: string;
  /** What the assistant is asked each time; null for a plain command. */
  readonly prompt: string | null;
  readonly command: string;
  readonly state: string;
  readonly nextRunAt: string | null;
}

export function parseSchedules(raw: unknown, boxId: number): ReadonlyArray<AssistantSchedule> {
  const list = rec(raw)?.["tasks"];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const t = rec(entry);
    if (!t || t["box_id"] !== boxId || typeof t["id"] !== "number") return [];
    const command = str(t["command"]);
    return [
      {
        id: t["id"],
        name: str(t["name"]),
        cron: str(t["cron_expr"]),
        timezone: str(t["timezone"]) || "UTC",
        prompt: promptFromCommand(command),
        command,
        state: str(t["state"]) || "active",
        nextRunAt: str(t["next_run_at"]) || null,
      },
    ];
  });
}

export async function listAssistantSchedules(
  boxId: number,
): Promise<ReadonlyArray<AssistantSchedule>> {
  if (isAssistantsDemo) return assistantsDemo.listSchedules(boxId);
  return parseSchedules(await accountRequest("GET", "/api/v1/scheduled-tasks"), boxId);
}

export async function deleteAssistantSchedule(id: number): Promise<void> {
  if (isAssistantsDemo) return assistantsDemo.deleteSchedule(id);
  await accountRequest("DELETE", `/api/v1/scheduled-tasks/${id}`);
}

export async function createAssistantSchedule(input: {
  readonly boxId: number;
  readonly name: string;
  readonly cron: string;
  readonly command: string;
}): Promise<void> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (isAssistantsDemo) return assistantsDemo.createSchedule({ ...input, timezone });
  await accountRequest("POST", "/api/v1/scheduled-tasks", {
    name: input.name,
    box_id: input.boxId,
    cron_expr: input.cron,
    timezone,
    command: input.command,
    // Default policy: the computer goes back to sleep after the run.
    on_finish: "hibernate",
  });
}
