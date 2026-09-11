/**
 * The "My machines" list, as data.
 *
 * Three sources describe machines, and none of them alone is the truth a
 * person expects to see:
 *
 *   - the workspace registry (machines adopted into it, with presence),
 *   - this client's saved connections (machines it can talk to right now),
 *   - the Uno control plane (boxes on the account, with power state).
 *
 * This module folds them into one row per machine, so the panel can show
 * "label · kind · online/offline/sleeping · projects" without the user
 * knowing which system each fact came from. Kept free of React so it can be
 * unit-tested with plain objects.
 *
 * @module components/settings/machineRows
 */
import {
  deriveMachineMonogram,
  type EnvironmentConnectionState,
  type EnvironmentId,
  type UnoBox,
  type WorkspaceMachine,
  type WorkspaceMachineKind,
} from "@t3tools/contracts";

import type { MachineIdentity } from "../../machineIdentity";
import { type MachineStatus } from "../../plainLanguage";

export interface MachineRow {
  readonly key: string;
  /** Null for a box on the account that nothing has connected to yet. */
  readonly environmentId: EnvironmentId | null;
  readonly label: string;
  readonly kind: WorkspaceMachineKind;
  readonly status: MachineStatus;
  /** One short line under the label: specs, last-seen, or why it is not live. */
  readonly detail: string;
  /** Names of the projects that live on this machine. */
  readonly projects: ReadonlyArray<string>;
  /** The control-plane box, when this machine is one — enables Wake / Sleep. */
  readonly box: UnoBox | null;
  readonly inRegistry: boolean;
  readonly isSavedConnection: boolean;
  /** The daemon serving this UI. Cannot be removed from its own list. */
  readonly isPrimary: boolean;
  readonly identity: MachineIdentity;
}

export interface MachineRowSources {
  readonly primaryEnvironmentId: EnvironmentId;
  /** Label of the daemon serving this UI, for when it is in no other source yet. */
  readonly primaryLabel?: string | undefined;
  readonly registryMachines: ReadonlyArray<WorkspaceMachine>;
  readonly savedEnvironments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly lastConnectedAt: string | null;
  }>;
  readonly connectionStateById: Readonly<Partial<Record<string, EnvironmentConnectionState>>>;
  readonly boxes: ReadonlyArray<UnoBox>;
  readonly projectNamesByEnvironmentId: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly now: number;
}

const LIVE_WINDOW_MS = 2 * 60_000;

export function registryIdForBox(boxId: number): EnvironmentId {
  return `uno-box-${boxId}` as EnvironmentId;
}

export function formatRelativeTime(iso: string | null, now: number): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "unknown";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** Power state of a box, in the user's words. Unknown strings degrade to offline. */
export function boxStatus(box: UnoBox): MachineStatus {
  const status = box.status.trim().toLowerCase();
  if (status === "running" || status === "active" || status === "on") return "online";
  if (
    status === "stopped" ||
    status === "sleeping" ||
    status === "suspended" ||
    status === "paused" ||
    status === "off"
  ) {
    return "sleeping";
  }
  return "offline";
}

function connectionStatus(state: EnvironmentConnectionState | undefined): MachineStatus | null {
  if (state === "connected") return "online";
  if (state === "disconnected" || state === "error") return "offline";
  if (state === "connecting" || state === "reconnecting") return "offline";
  return null;
}

function presenceStatus(lastSeenAt: string | null, now: number): MachineStatus {
  if (!lastSeenAt) return "unknown";
  const age = now - new Date(lastSeenAt).getTime();
  if (!Number.isFinite(age)) return "unknown";
  return age < LIVE_WINDOW_MS ? "online" : "offline";
}

function boxSpecs(box: UnoBox): string {
  const parts: string[] = [];
  if (box.vcpu > 0) parts.push(`${box.vcpu} vCPU`);
  if (box.ramMb > 0) parts.push(`${Math.round(box.ramMb / 1024)} GB`);
  if (box.diskGb > 0) parts.push(`${box.diskGb} GB disk`);
  return parts.join(" · ");
}

function connectionDetail(state: EnvironmentConnectionState | undefined): string | null {
  if (state === "connecting") return "Connecting…";
  if (state === "reconnecting") return "Reconnecting…";
  if (state === "error") return "Connection error";
  return null;
}

/**
 * Fold the sources into one row per machine. Order: this computer first, then
 * everything else by label, so the list is stable across refreshes.
 */
export function buildMachineRows(sources: MachineRowSources): ReadonlyArray<MachineRow> {
  const rows: MachineRow[] = [];
  const seenEnvironmentIds = new Set<string>();
  const boxesById = new Map(sources.boxes.map((box) => [box.id, box] as const));
  const boxesByName = new Map(sources.boxes.map((box) => [box.name.trim().toLowerCase(), box]));
  const claimedBoxIds = new Set<number>();

  const projectsFor = (environmentId: EnvironmentId | null): ReadonlyArray<string> =>
    environmentId ? (sources.projectNamesByEnvironmentId.get(environmentId) ?? []) : [];

  for (const machine of sources.registryMachines) {
    seenEnvironmentIds.add(machine.environmentId);
    const isPrimary = machine.environmentId === sources.primaryEnvironmentId;
    const connection = sources.connectionStateById[machine.environmentId];
    const box =
      machine.kind === "uno_box" && machine.unoBoxId != null
        ? (boxesById.get(machine.unoBoxId) ?? null)
        : (boxesByName.get(machine.label.trim().toLowerCase()) ?? null);
    if (box) claimedBoxIds.add(box.id);

    const status: MachineStatus = isPrimary
      ? "online"
      : (connectionStatus(connection) ??
        (box ? boxStatus(box) : presenceStatus(machine.lastSeenAt, sources.now)));

    const detail =
      connectionDetail(connection) ??
      (box
        ? boxSpecs(box) || `seen ${formatRelativeTime(machine.lastSeenAt, sources.now)}`
        : isPrimary
          ? "The machine this app is running on"
          : `seen ${formatRelativeTime(machine.lastSeenAt, sources.now)}`);

    rows.push({
      key: machine.environmentId,
      environmentId: machine.environmentId,
      label: machine.label,
      kind: box ? "uno_box" : machine.kind,
      status,
      detail,
      projects: projectsFor(machine.environmentId),
      box,
      inRegistry: true,
      isSavedConnection: sources.savedEnvironments.some(
        (record) => record.environmentId === machine.environmentId,
      ),
      isPrimary,
      identity: {
        environmentId: machine.environmentId,
        label: machine.label,
        monogram: machine.monogram,
        colorSlot: machine.colorSlot,
        isMonogramOverridden: true,
      },
    });
  }

  for (const record of sources.savedEnvironments) {
    if (seenEnvironmentIds.has(record.environmentId)) continue;
    seenEnvironmentIds.add(record.environmentId);
    const isPrimary = record.environmentId === sources.primaryEnvironmentId;
    const connection = sources.connectionStateById[record.environmentId];
    const box = boxesByName.get(record.label.trim().toLowerCase()) ?? null;
    if (box) claimedBoxIds.add(box.id);

    const status: MachineStatus = isPrimary
      ? "online"
      : (connectionStatus(connection) ?? (box ? boxStatus(box) : "unknown"));
    const detail =
      connectionDetail(connection) ??
      (box
        ? boxSpecs(box)
        : isPrimary
          ? "The machine this app is running on"
          : record.lastConnectedAt
            ? `connected ${formatRelativeTime(record.lastConnectedAt, sources.now)}`
            : "never connected");

    rows.push({
      key: record.environmentId,
      environmentId: record.environmentId,
      label: record.label,
      kind: box ? "uno_box" : isPrimary ? "local" : "ssh",
      status,
      detail,
      projects: projectsFor(record.environmentId),
      box,
      inRegistry: false,
      isSavedConnection: true,
      isPrimary,
      identity: {
        environmentId: record.environmentId,
        label: record.label,
        monogram: deriveMachineMonogram(record.label),
        colorSlot: 0,
        isMonogramOverridden: false,
      },
    });
  }

  for (const box of sources.boxes) {
    if (claimedBoxIds.has(box.id)) continue;
    const registryId = registryIdForBox(box.id);
    rows.push({
      key: `box:${box.id}`,
      environmentId: null,
      label: box.name,
      kind: "uno_box",
      status: boxStatus(box),
      detail: boxSpecs(box) || "Not connected yet",
      projects: [],
      box,
      inRegistry: false,
      isSavedConnection: false,
      isPrimary: false,
      identity: {
        environmentId: registryId,
        label: box.name,
        monogram: deriveMachineMonogram(box.name),
        colorSlot: 0,
        isMonogramOverridden: false,
      },
    });
  }

  // A fresh daemon is in no registry and no saved list, yet it is the one
  // machine the person certainly has. Never let the list say "no machines"
  // while the UI is literally being served by one.
  if (!seenEnvironmentIds.has(sources.primaryEnvironmentId)) {
    const label = sources.primaryLabel?.trim() || "This computer";
    rows.push({
      key: sources.primaryEnvironmentId,
      environmentId: sources.primaryEnvironmentId,
      label,
      kind: "local",
      status: "online",
      detail: "The machine this app is running on",
      projects: projectsFor(sources.primaryEnvironmentId),
      box: null,
      inRegistry: false,
      isSavedConnection: false,
      isPrimary: true,
      identity: {
        environmentId: sources.primaryEnvironmentId,
        label,
        monogram: deriveMachineMonogram(label),
        colorSlot: 0,
        isMonogramOverridden: false,
      },
    });
  }

  return rows.toSorted((left, right) => {
    if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}
