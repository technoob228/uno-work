/**
 * A flat process table → groups a person recognises: this app, that
 * container, the agent of a chat, a terminal, Uno Work itself, the system.
 *
 * Pure: the service reads the OS and the desktop scan, this decides who is
 * who and what may be quit. The same function answers the screen and checks
 * an action, so the screen never offers what the daemon would refuse.
 */
import type {
  UnoResourceGroup,
  UnoResourceGroupAction,
  UnoResourceGroupKind,
  UnoResourceProcess,
} from "@t3tools/contracts";

import { parseCgroupOwner } from "../machineApps/discoveryParsers.ts";
import { knownSoftware } from "../machineApps/machineAppsScan.ts";
import { macAppName, maskCommand, type RawProcess } from "./resourceParsers.ts";

export interface MeasuredProcess extends RawProcess {
  /** Share of the whole computer (0–100). */
  readonly cpuPct: number;
}

export interface ManifestAppRef {
  /** `UnoMachineApp.id` (`manifest:<id>`). */
  readonly appId: string;
  readonly name: string;
  readonly icon: string | null;
  /** The process listening on the app's port, when it runs. */
  readonly listenerPid: number | null;
}

export interface ContainerRef {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  /** `UnoMachineApp.id` when the container is on the desktop. */
  readonly machineAppId: string | null;
  readonly displayName: string | null;
}

export interface ServiceRef {
  readonly unit: string;
  readonly user: boolean;
  readonly machineAppId: string;
  readonly name: string;
  readonly icon: string | null;
}

export interface GroupingInput {
  readonly platform: NodeJS.Platform;
  readonly processes: ReadonlyArray<MeasuredProcess>;
  readonly selfPid: number;
  readonly selfUid: number;
  readonly manifestApps: ReadonlyArray<ManifestAppRef>;
  /** Containers by full id; null when docker can't be asked. */
  readonly containers: ReadonlyMap<string, ContainerRef> | null;
  readonly dockerAccess: boolean;
  readonly services: ReadonlyArray<ServiceRef>;
  /** Folder each chat agent runs in, by the agent's pid. */
  readonly cwdByPid: ReadonlyMap<number, string>;
  /** How many processes a group lists (heaviest first). */
  readonly processLimit?: number;
}

/** AI agents Uno Work starts for chats (by program name or command line). */
const AGENT_PATTERN =
  /\b(claude(-code|-agent-acp)?|codex|opencode|cursor-agent|hermes|gemini|qwen|amp|goose|aider|acp)\b/i;
/** A user's session manager: what it starts are separate programs, not "systemd". */
const SESSION_ROOTS = new Set([
  "systemd",
  "launchd",
  "init",
  "sshd",
  "(sd-pam)",
  "tmux: server",
  "screen",
]);
const SHELL_NAMES = new Set(["bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "login"]);
/** The Uno Work desktop app on a Mac (Electron), found above the daemon. */
const DESKTOP_APP_PATTERN = /uno ?work|electron|t3 ?code/i;

const PROTECTED_SELF = "This is Uno Work itself.";
const PROTECTED_DESKTOP = "This is the Uno Work app — closing it would close this screen.";
const PROTECTED_OTHER_USER = "It belongs to the system, so only an admin can stop it.";
const PROTECTED_AGENT =
  "This is a chat's AI agent. Stop it from the chat, so the conversation isn't cut off mid-way.";
const PROTECTED_CONTAINER = "Stop the whole container instead.";

interface Assignment {
  readonly key: string;
  readonly kind: UnoResourceGroupKind;
  readonly name: string;
  readonly detail: string | null;
  readonly icon: string | null;
  readonly machineAppId: string | null;
  /** Pid whose folder names the chat. */
  readonly anchorPid: number | null;
}

function isShell(p: RawProcess): boolean {
  return SHELL_NAMES.has(p.name.replace(/^-/, ""));
}

function looksLikeAgent(p: RawProcess): boolean {
  return AGENT_PATTERN.test(p.name) || (p.command !== null && AGENT_PATTERN.test(p.command));
}

function agentName(p: RawProcess): string {
  const text = `${p.name} ${p.command ?? ""}`.toLowerCase();
  if (/claude/.test(text)) return "Claude Code";
  if (/codex/.test(text)) return "Codex";
  if (/opencode/.test(text)) return "OpenCode";
  if (/cursor-agent/.test(text)) return "Cursor";
  if (/hermes/.test(text)) return "Hermes";
  if (/gemini/.test(text)) return "Gemini";
  return "AI agent";
}

function containerIdOf(p: RawProcess): string | null {
  if (!p.cgroup) return null;
  const owner = parseCgroupOwner(p.cgroup);
  return owner?.kind === "docker" ? owner.containerId : null;
}

function serviceUnitOf(p: RawProcess): string | null {
  if (!p.cgroup) return null;
  const owner = parseCgroupOwner(p.cgroup);
  return owner?.kind === "service" ? owner.unit : null;
}

export interface GroupingResult {
  readonly groups: UnoResourceGroup[];
  /** Why each pid can't be quit (absent = it can). */
  readonly protectedReason: ReadonlyMap<number, string>;
  readonly groupOfPid: ReadonlyMap<number, string>;
}

export function groupProcesses(input: GroupingInput): GroupingResult {
  const limit = input.processLimit ?? 30;
  const byPid = new Map(input.processes.map((p) => [p.pid, p]));
  const children = new Map<number, number[]>();
  for (const p of input.processes) {
    if (p.pid === p.ppid) continue;
    const list = children.get(p.ppid) ?? [];
    list.push(p.pid);
    children.set(p.ppid, list);
  }

  // The daemon's ancestors (its launcher, the desktop app) are never quit from here.
  const ancestors = new Set<number>();
  for (let pid = byPid.get(input.selfPid)?.ppid; pid !== undefined && pid > 1; ) {
    if (ancestors.has(pid)) break;
    ancestors.add(pid);
    pid = byPid.get(pid)?.ppid;
  }
  // On a Mac the daemon runs inside the desktop app: its whole tree is Uno Work.
  let desktopRoot: number | null = null;
  for (const pid of ancestors) {
    const p = byPid.get(pid);
    if (p && p.uid === input.selfUid && DESKTOP_APP_PATTERN.test(`${p.exe ?? ""} ${p.name}`)) {
      desktopRoot = pid;
    }
  }

  // A registered app is the process on its port plus a wrapper shell above it.
  const manifestRoots = new Map<number, ManifestAppRef>();
  for (const app of input.manifestApps) {
    if (app.listenerPid === null) continue;
    let root = app.listenerPid;
    for (let i = 0; i < 6; i++) {
      const parent = byPid.get(byPid.get(root)?.ppid ?? -1);
      if (
        !parent ||
        parent.pid <= 1 ||
        parent.pid === input.selfPid ||
        !isShell(parent) ||
        (children.get(parent.pid)?.length ?? 0) > 1
      ) {
        break;
      }
      root = parent.pid;
    }
    if (byPid.has(root)) manifestRoots.set(root, app);
  }
  const servicesByUnit = new Map(input.services.map((s) => [s.unit, s]));

  const assignments = new Map<number, Assignment>();
  const protectedReason = new Map<number, string>();

  const own = (p: RawProcess) => p.uid === input.selfUid;

  const programAssignment = (p: RawProcess): Assignment => {
    const app = input.platform === "darwin" ? macAppName(p.exe) : null;
    const label = app ?? p.name;
    const known = knownSoftware(label);
    return {
      key: `program:${label}`,
      kind: "program",
      name: label,
      detail: app ? "App" : "Program",
      icon: known?.icon ?? null,
      machineAppId: null,
      anchorPid: null,
    };
  };

  const systemAssignment: Assignment = {
    key: "system",
    kind: "system",
    name: "System",
    detail: "What the computer runs for itself",
    icon: null,
    machineAppId: null,
    anchorPid: null,
  };

  /** A rule that claims this process (and, by default, what it starts). */
  const ownRule = (p: RawProcess, parent: Assignment | null): Assignment | null => {
    const containerId = containerIdOf(p);
    if (containerId) {
      const ref = input.containers?.get(containerId) ?? null;
      const name = ref?.displayName ?? ref?.name ?? `Container ${containerId.slice(0, 12)}`;
      const known = knownSoftware(`${ref?.image ?? ""} ${ref?.name ?? ""}`);
      return {
        key: `docker:${ref?.name ?? containerId.slice(0, 12)}`,
        kind: "docker",
        name,
        detail: ref ? `Docker · ${ref.image.replace(/@sha256:.*$/, "").slice(0, 60)}` : "Docker",
        icon: known?.icon ?? "🐳",
        machineAppId: ref?.machineAppId ?? null,
        anchorPid: null,
      };
    }
    const manifest = manifestRoots.get(p.pid);
    if (manifest) {
      return {
        key: `app:${manifest.appId.replace(/^manifest:/, "")}`,
        kind: "app",
        name: manifest.name,
        detail: "App on this computer",
        icon: manifest.icon,
        machineAppId: manifest.appId,
        anchorPid: null,
      };
    }
    const unit = serviceUnitOf(p);
    if (unit && parent?.kind !== "service") {
      const service = servicesByUnit.get(unit);
      if (service) {
        return {
          key: `service:${service.user ? "user:" : ""}${unit}`,
          kind: "service",
          name: service.name,
          detail: `Service · ${unit}`,
          icon: service.icon,
          machineAppId: service.machineAppId,
          anchorPid: null,
        };
      }
    }
    if (p.pid === input.selfPid) {
      return {
        key: "unowork",
        kind: "unowork",
        name: "Uno Work",
        detail: "The background part of Uno Work and its helpers",
        icon: null,
        machineAppId: null,
        anchorPid: null,
      };
    }
    if (p.ppid === input.selfPid) {
      if (looksLikeAgent(p)) {
        return {
          key: `chat:${p.pid}`,
          kind: "chat",
          name: agentName(p),
          detail: "Chat agent",
          icon: null,
          machineAppId: null,
          anchorPid: p.pid,
        };
      }
      if (isShell(p)) {
        return {
          key: `terminal:${p.pid}`,
          kind: "terminal",
          name: "Terminal",
          detail: "A terminal opened in Uno Work",
          icon: null,
          machineAppId: null,
          anchorPid: p.pid,
        };
      }
    }
    if (desktopRoot !== null && p.pid === desktopRoot) {
      return {
        key: "unowork",
        kind: "unowork",
        name: "Uno Work",
        detail: "The Uno Work app and its background part",
        icon: null,
        machineAppId: null,
        anchorPid: null,
      };
    }
    return null;
  };

  const INHERITED: ReadonlySet<UnoResourceGroupKind> = new Set([
    "app",
    "docker",
    "service",
    "chat",
    "terminal",
    "unowork",
    "program",
  ]);

  const assign = (pid: number, parent: Assignment | null, depth: number) => {
    const p = byPid.get(pid);
    if (!p || assignments.has(pid) || depth > 200) return;
    const parentName = byPid.get(p.ppid)?.name ?? "";
    let assignment = ownRule(p, parent);
    if (!assignment) {
      if (p.kernelThread || !own(p)) {
        assignment = parent?.kind === "docker" ? parent : systemAssignment;
      } else if (parent && INHERITED.has(parent.kind) && !SESSION_ROOTS.has(parentName)) {
        assignment = parent;
      } else {
        assignment = programAssignment(p);
      }
    }
    assignments.set(pid, assignment);
    for (const child of children.get(pid) ?? []) assign(child, assignment, depth + 1);
  };

  const roots = input.processes.filter((p) => !byPid.has(p.ppid) || p.ppid === p.pid);
  for (const root of roots) assign(root.pid, null, 0);
  // Cycles or orphans the walk above missed.
  for (const p of input.processes) assign(p.pid, null, 0);

  // Who may be quit from here.
  for (const p of input.processes) {
    const a = assignments.get(p.pid)!;
    let reason: string | null = null;
    if (p.pid === input.selfPid) reason = PROTECTED_SELF;
    else if (ancestors.has(p.pid))
      reason = desktopRoot !== null ? PROTECTED_DESKTOP : PROTECTED_SELF;
    else if (!own(p) || p.kernelThread) reason = PROTECTED_OTHER_USER;
    else if (a.kind === "unowork")
      reason = desktopRoot !== null ? PROTECTED_DESKTOP : PROTECTED_SELF;
    // Another copy of the Uno Work app (the installed app next to a dev build).
    else if (a.kind === "program" && DESKTOP_APP_PATTERN.test(a.name)) reason = PROTECTED_DESKTOP;
    else if (a.kind === "chat" && a.anchorPid === p.pid) reason = PROTECTED_AGENT;
    else if (a.kind === "docker") reason = PROTECTED_CONTAINER;
    else if (p.pid <= 1) reason = PROTECTED_OTHER_USER;
    if (reason) protectedReason.set(p.pid, reason);
  }

  // Assemble.
  const grouped = new Map<string, { a: Assignment; members: MeasuredProcess[] }>();
  const groupOfPid = new Map<number, string>();
  for (const p of input.processes) {
    const a = assignments.get(p.pid)!;
    const entry = grouped.get(a.key) ?? { a, members: [] };
    entry.members.push(p);
    grouped.set(a.key, entry);
    groupOfPid.set(p.pid, a.key);
  }

  const groups: UnoResourceGroup[] = [];
  for (const { a, members } of grouped.values()) {
    const cpuPct = members.reduce((sum, p) => sum + p.cpuPct, 0);
    const memMb = members.reduce((sum, p) => sum + p.memMb, 0);
    const sorted = members.toSorted((x, y) => y.cpuPct * 40 + y.memMb - (x.cpuPct * 40 + x.memMb));
    const processes: UnoResourceProcess[] = sorted.slice(0, limit).map((p) => {
      const reason = protectedReason.get(p.pid) ?? null;
      return {
        pid: p.pid,
        startToken: p.startToken,
        name: p.name,
        command: own(p) && p.command ? maskCommand(p.command) : null,
        cpuPct: round1(p.cpuPct),
        memMb: Math.round(p.memMb),
        own: own(p),
        canQuit: reason === null,
        protectedReason: reason,
      };
    });
    const { actions, blocked } = groupActions(a, members, protectedReason, input);
    groups.push({
      id: a.key,
      kind: a.kind,
      name: a.name,
      detail: a.detail,
      icon: a.icon,
      cpuPct: round1(Math.min(100, cpuPct)),
      memMb: Math.round(memMb),
      processes,
      processCount: members.length,
      cwd: a.anchorPid !== null ? (input.cwdByPid.get(a.anchorPid) ?? null) : null,
      machineAppId: a.machineAppId,
      actions,
      actionsBlockedReason: blocked,
    });
  }
  groups.sort((x, y) => y.cpuPct * 40 + y.memMb - (x.cpuPct * 40 + x.memMb));
  return { groups, protectedReason, groupOfPid };
}

function groupActions(
  a: Assignment,
  members: ReadonlyArray<MeasuredProcess>,
  protectedReason: ReadonlyMap<number, string>,
  input: GroupingInput,
): { actions: UnoResourceGroupAction[]; blocked: string | null } {
  switch (a.kind) {
    case "app":
      return { actions: ["stop", "restart"], blocked: null };
    case "docker":
      return input.dockerAccess && input.containers !== null
        ? { actions: ["stop", "restart"], blocked: null }
        : {
            actions: [],
            blocked:
              "Uno Work isn't allowed to control containers on this computer, so stop it from the app itself or ask an admin.",
          };
    case "service":
      return a.key.startsWith("service:user:")
        ? { actions: ["stop", "restart"], blocked: null }
        : {
            actions: [],
            blocked: "It's a system service, so only an admin can stop it.",
          };
    case "terminal":
    case "program": {
      const quittable = members.some((p) => !protectedReason.has(p.pid));
      const anyProtected = members.some((p) => protectedReason.has(p.pid));
      if (quittable && !anyProtected) return { actions: ["stop"], blocked: null };
      return {
        actions: [],
        blocked: anyProtected
          ? (protectedReason.get(members.find((p) => protectedReason.has(p.pid))!.pid) ?? null)
          : null,
      };
    }
    case "chat":
      return { actions: [], blocked: PROTECTED_AGENT };
    case "unowork":
      return { actions: [], blocked: PROTECTED_SELF };
    case "system":
      return { actions: [], blocked: PROTECTED_OTHER_USER };
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
