/**
 * The workspace as the account's API gives it (`GET /api/v1/workspace`,
 * proposed 10.11 — see reports/day_2026-11-10/workspace-vision/API.md):
 * the workspace (chats, assistants, apps, memory) lives in the account's
 * cloud; everything it runs on is its hardware — computers (cloud, local,
 * asleep), Spark functions, data, Drive, git, addresses. Pure: the screens
 * and their tests read these functions, nothing here fetches.
 */

export type ComputerState = "running" | "waking" | "asleep" | "offline";
export type ComputerKind = "cloud" | "local";

export interface WsComputer {
  readonly id: string;
  readonly name: string;
  readonly kind: ComputerKind;
  readonly state: ComputerState;
  /** "Plus · 16 GB", "MacBook Air", "Raspberry Pi 5". */
  readonly detail: string;
  /** Where it is: "Amsterdam", "Your desk". */
  readonly place: string;
  /** The Work environment that answers for it, when it is connected. */
  readonly environmentId: string | null;
  /** Just joined the workspace: the person hasn't said what it may do yet. */
  readonly isNew?: boolean;
}

export type PartKind = "spark" | "database" | "kv" | "drive" | "git" | "address";

/** Hardware that is not a computer. `on`: it lives on a computer (else in the workspace cloud). */
export interface WsPart {
  readonly id: string;
  readonly kind: PartKind;
  readonly name: string;
  readonly detail: string;
  readonly on: string | null;
}

export type UseRole = "runs" | "calls" | "stores" | "files" | "answers";

/** What an app needs: a part of the hardware and what for. */
export interface WsUse {
  readonly ref: string;
  readonly role: UseRole;
  /** ":3000", "/exports", "orders.uno4.me". */
  readonly detail?: string;
}

export interface WsApp {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly url: string;
  readonly uses: ReadonlyArray<WsUse>;
}

export interface WsAssistant {
  readonly id: string;
  readonly name: string;
  /** Computers it may work on (its hands). */
  readonly hands: ReadonlyArray<string>;
  /** Wakes a sleeping one of them when a task needs it. */
  readonly wakes: boolean;
  readonly telegram: boolean;
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  /** The workspace's own home: always on, holds chats, assistants, apps, memory. */
  readonly cloud: { readonly region: string };
  readonly computers: ReadonlyArray<WsComputer>;
  readonly parts: ReadonlyArray<WsPart>;
  readonly apps: ReadonlyArray<WsApp>;
  readonly assistants: ReadonlyArray<WsAssistant>;
}

export const PART_LABEL: Readonly<Record<PartKind, string>> = {
  spark: "Spark",
  database: "Database",
  kv: "KV",
  drive: "Drive",
  git: "Git",
  address: "Address",
};

export const ROLE_LABEL: Readonly<Record<UseRole, string>> = {
  runs: "Runs on",
  calls: "Calls",
  stores: "Keeps data in",
  files: "Files in",
  answers: "Answers at",
};

export function computerOf(ws: Workspace, id: string | null | undefined): WsComputer | null {
  return id ? (ws.computers.find((computer) => computer.id === id) ?? null) : null;
}

export function partOf(ws: Workspace, id: string): WsPart | null {
  return ws.parts.find((part) => part.id === id) ?? null;
}

/** A computer is up for work right now. */
export const isUp = (computer: WsComputer) => computer.state === "running";

/** It can be woken from here (a cloud computer asleep); a local one only by its owner. */
export const canWake = (computer: WsComputer) =>
  computer.kind === "cloud" && computer.state === "asleep";

/** The computer a use depends on: the one it runs on, or the one its part lives on. */
export function useComputer(ws: Workspace, use: WsUse): WsComputer | null {
  const computer = computerOf(ws, use.ref);
  if (computer) return computer;
  const part = partOf(ws, use.ref);
  return part ? computerOf(ws, part.on) : null;
}

export type Readiness =
  /** Everything it uses is up: opens at once. */
  | { readonly kind: "ready" }
  /** A cloud computer it needs sleeps (or is waking): opening wakes it. */
  | { readonly kind: "wakes"; readonly computer: WsComputer }
  /** A computer only its owner can bring back (a laptop, a Pi) is off. */
  | { readonly kind: "unavailable"; readonly computer: WsComputer };

/** Can the app open now, from any computer — and if not, what stops it. */
export function appReadiness(ws: Workspace, app: WsApp): Readiness {
  let wakes: WsComputer | null = null;
  for (const use of app.uses) {
    const computer = useComputer(ws, use);
    if (!computer || isUp(computer)) continue;
    if (computer.kind === "local" || computer.state === "offline")
      return { kind: "unavailable", computer };
    wakes ??= computer;
  }
  return wakes ? { kind: "wakes", computer: wakes } : { kind: "ready" };
}

/** Who uses a piece of hardware (a computer or a part): apps and assistants. */
export function usedBy(
  ws: Workspace,
  ref: string,
): { readonly apps: ReadonlyArray<WsApp>; readonly assistants: ReadonlyArray<WsAssistant> } {
  const onIt = new Set(ws.parts.filter((part) => part.on === ref).map((part) => part.id));
  return {
    apps: ws.apps.filter((app) => app.uses.some((use) => use.ref === ref || onIt.has(use.ref))),
    assistants: ws.assistants.filter((assistant) => assistant.hands.includes(ref)),
  };
}

/** Where an assistant can act right now: its hands that are up, the ones it may wake, the rest. */
export function assistantReach(ws: Workspace, assistant: WsAssistant) {
  const hands = assistant.hands
    .map((id) => computerOf(ws, id))
    .filter((computer): computer is WsComputer => computer !== null);
  return {
    up: hands.filter(isUp),
    wakeable: assistant.wakes ? hands.filter(canWake) : [],
    away: hands.filter((computer) => !isUp(computer) && !(assistant.wakes && canWake(computer))),
  };
}

/**
 * Where a chat's next turn runs: the picked computer, if it can take it (up,
 * or a cloud one that wakes on send); else the chat's own. `note` is what the
 * chip says about it.
 */
export function nextTurnPlace(
  ws: Workspace,
  picked: string | null,
  own: string | null,
): { readonly computer: WsComputer | null; readonly note: string | null } {
  const choice = computerOf(ws, picked) ?? computerOf(ws, own);
  if (!choice) return { computer: null, note: null };
  if (choice.state === "asleep" && choice.kind === "cloud")
    return { computer: choice, note: "wakes when you send" };
  if (choice.state === "waking") return { computer: choice, note: "waking" };
  if (!isUp(choice)) return { computer: choice, note: choice.state };
  return { computer: choice, note: null };
}

/** One quiet line for the top of the hardware: how many computers are up, asleep, away. */
export function hardwareSummary(ws: Workspace) {
  const count = (state: ComputerState) =>
    ws.computers.filter((computer) => computer.state === state).length;
  return {
    up: count("running") + count("waking"),
    asleep: count("asleep"),
    offline: count("offline"),
    parts: ws.parts.length,
  };
}

export const STATE_WORD: Readonly<Record<ComputerState, string>> = {
  running: "On",
  waking: "Waking",
  asleep: "Asleep",
  offline: "Offline",
};
