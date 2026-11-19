/**
 * Which of the person's computers an app opens on.
 *
 * All computers of a workspace are one big computer (Misha 19.11): the same
 * app id can be registered on the Mac and on a cloud computer, and the app
 * window must not depend on which computer happens to be active. The window
 * asks every computer that is on for its apps and picks one instance:
 *
 *   1. the computer the link or the person named (`env`) — always;
 *   2. one where it runs, on a computer that stays on (a cloud computer)
 *      before a laptop, the active computer breaking a tie;
 *   3. one where it can be started, in the same order;
 *   4. otherwise the active computer, as before (it says "not here").
 *
 * An address `http://localhost:<port>/` means a port of some computer: the
 * one active, if the port answers there, else another computer where an app
 * runs on that port. Kept free of React so the rules are tested directly.
 */
import type { EnvironmentId, MachineKind, UnoMachineApp } from "@t3tools/contracts";
import { computerLocalPort } from "@t3tools/shared/portPreview";

export interface WorkspaceComputer {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly kind: MachineKind;
  /** Connected right now: its apps are known and it can show them. */
  readonly online: boolean;
  readonly apps: ReadonlyArray<Pick<UnoMachineApp, "id" | "status" | "port" | "canStart">>;
}

export interface AppInstance {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly kind: MachineKind;
  readonly online: boolean;
  readonly running: boolean;
}

export interface AppPlacement {
  /** The computer to open it on; null — no computer known at all. */
  readonly environmentId: EnvironmentId | null;
  /** Every computer the app is on, the chosen one first. */
  readonly instances: ReadonlyArray<AppInstance>;
}

function instanceOf(
  computer: WorkspaceComputer,
  app: WorkspaceComputer["apps"][number],
): AppInstance {
  return {
    environmentId: computer.environmentId,
    label: computer.label,
    kind: computer.kind,
    online: computer.online,
    running: computer.online && app.status === "running",
  };
}

/** Smaller is better, compared position by position. */
function rank(
  instance: AppInstance,
  canStart: boolean,
  active: EnvironmentId | null,
): readonly number[] {
  return [
    instance.running ? 0 : instance.online && canStart ? 1 : instance.online ? 2 : 3,
    // A laptop sleeps and travels; a cloud computer or a server stays on.
    instance.kind === "computer" ? 1 : 0,
    instance.environmentId === active ? 0 : 1,
  ];
}

function compareRanks(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Where to open `/app?app=<key>` (a tile key, e.g. `manifest:notes`) or
 * `/app?url=http://localhost:<port>/`; any other address is not a
 * computer's port and opens on the active computer.
 */
export function placeApp(input: {
  readonly key?: string | undefined;
  readonly url?: string | undefined;
  /** The computer named in the link (`env`) or picked by the person. */
  readonly explicit?: EnvironmentId | undefined;
  readonly active: EnvironmentId | null;
  readonly computers: ReadonlyArray<WorkspaceComputer>;
}): AppPlacement {
  const { active, computers, explicit } = input;
  const port = input.key ? null : input.url ? computerLocalPort(input.url) : null;
  if (!input.key && port === null) return { environmentId: active, instances: [] };

  const found: Array<{ instance: AppInstance; rank: readonly number[] }> = [];
  for (const computer of computers) {
    // A port belongs to an app only while something answers on it.
    const app = input.key
      ? computer.apps.find((candidate) => candidate.id === input.key)
      : computer.apps.find(
          (candidate) => candidate.port === port && candidate.status === "running",
        );
    if (!app) continue;
    const instance = instanceOf(computer, app);
    if (port !== null && !instance.running) continue;
    const base = rank(instance, app.canStart, active);
    // An address of a port meant the active computer's port: that one first, as before.
    found.push({
      instance,
      rank: port !== null ? [instance.environmentId === active ? 0 : 1, ...base] : base,
    });
  }
  const ordered = found
    .toSorted((a, b) => compareRanks(a.rank, b.rank))
    .map((entry) => entry.instance);

  // A named computer is always honoured — even one whose apps aren't known now.
  const chosen = explicit ? ordered.find((entry) => entry.environmentId === explicit) : ordered[0];
  return {
    environmentId: explicit ?? chosen?.environmentId ?? active,
    instances: chosen ? [chosen, ...ordered.filter((entry) => entry !== chosen)] : ordered,
  };
}
