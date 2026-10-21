/**
 * Assistant presets — Full / Helper / Observer (decision 21.10: real, enforced
 * by the daemon, not the prompt). One table of what each preset may do, shared
 * by the daemon (which enforces it on every call) and the UI (which explains
 * it), so the two can't drift.
 *
 * The daemon stores an assistant's access as its capability token's
 * `scopes` / `projectAllowlist` / `autoApprove`; the preset is what those
 * scopes say (`presetOfScopes`), and a preset change rewrites them
 * (`presetTokenAccess`).
 *
 * On a shared computer every assistant runs as the same system user: this is
 * protection against accidents (a tricked or confused assistant), not a wall.
 * A real boundary is an assistant on its own computer.
 *
 * Pure: no I/O, no Effect.
 */
import type {
  AssistantAppLevel,
  AssistantPreset,
  ManagerProjectAllowlist,
  ManagerScope,
  ProjectId,
  RuntimeMode,
} from "@t3tools/contracts";

export const ASSISTANT_PRESETS: ReadonlyArray<AssistantPreset> = ["full", "helper", "observer"];

/** Uno and every assistant made before presets existed (no behaviour change). */
export const DEFAULT_ASSISTANT_PRESET: AssistantPreset = "full";

/** What an assistant tries to do; each preset allows a subset. */
export type AssistantAction =
  /** list / status / read / wait for chats in its projects */
  | "read-chats"
  /** create_thread, chat_create */
  | "start-chat"
  /** send_turn, chat_message */
  | "write-chat"
  /** interrupt_turn — stopping is always safer than running */
  | "stop-chat"
  /** respond_to_request: approve or deny another chat's tool request */
  | "answer-requests"
  /** resolve_proposal: approve a pending manager action */
  | "resolve-proposals"
  /** reminders to the person's own messenger */
  | "remind"
  /** uno-work tools that change something (deploy, save to Drive, …) */
  | "change-things";

const ALLOWED: Readonly<Record<AssistantPreset, ReadonlySet<AssistantAction>>> = {
  full: new Set<AssistantAction>([
    "read-chats",
    "start-chat",
    "write-chat",
    "stop-chat",
    "answer-requests",
    "resolve-proposals",
    "remind",
    "change-things",
  ]),
  helper: new Set<AssistantAction>([
    "read-chats",
    "start-chat",
    "write-chat",
    "stop-chat",
    "remind",
    "change-things",
  ]),
  observer: new Set<AssistantAction>(["read-chats", "remind"]),
};

/** The one decision: may an assistant with this preset do this? */
export function assistantPresetAllows(preset: AssistantPreset, action: AssistantAction): boolean {
  return ALLOWED[preset].has(action);
}

/**
 * The widest runtime mode a chat started or steered by this assistant may
 * run in. Helper: every chat it starts asks the person before edits and
 * commands (`approval-required`); it may not steer a chat that runs wider.
 * Null = no ceiling beyond the caller's own mode.
 */
export function presetRuntimeCeiling(preset: AssistantPreset): RuntimeMode | null {
  return preset === "full" ? null : "approval-required";
}

const RUNTIME_RANK: Readonly<Record<RuntimeMode, number>> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  "full-access": 2,
};

/** `mode` narrowed to the preset's ceiling. */
export function capRuntimeToPreset(mode: RuntimeMode, preset: AssistantPreset): RuntimeMode {
  const ceiling = presetRuntimeCeiling(preset);
  return ceiling !== null && RUNTIME_RANK[mode] > RUNTIME_RANK[ceiling] ? ceiling : mode;
}

/** The highest app (connector) level the preset allows: Observer only reads. */
export function presetConnectorCeiling(preset: AssistantPreset): AssistantAppLevel {
  return preset === "observer" ? "read" : "write";
}

const LEVEL_RANK: Readonly<Record<AssistantAppLevel, number>> = { none: 0, read: 1, write: 2 };

/** A connector level as the preset lets it be (what the person picked, at most the ceiling). */
export function capAppLevel(level: AssistantAppLevel, preset: AssistantPreset): AssistantAppLevel {
  const ceiling = presetConnectorCeiling(preset);
  return LEVEL_RANK[level] > LEVEL_RANK[ceiling] ? ceiling : level;
}

const FULL_SCOPES: ReadonlyArray<ManagerScope> = ["threads:read", "threads:write", "threads:approve"];

export interface AssistantTokenAccess {
  readonly scopes: ReadonlyArray<ManagerScope>;
  readonly projectAllowlist: ManagerProjectAllowlist;
  readonly autoApprove: boolean;
}

/**
 * "Only these projects" never locks an assistant out of its own workspace
 * (its conversations, notes and skills live there).
 */
export function withOwnWorkspace(
  projects: ManagerProjectAllowlist,
  ownProjectId: string,
): ManagerProjectAllowlist {
  if (projects === "all") return "all";
  return [...new Set([ownProjectId, ...projects])] as ReadonlyArray<ProjectId>;
}

/**
 * The token a preset stands for. Helper keeps `autoApprove` so the chats it
 * starts begin at once (they ask the person themselves), but has no
 * `threads:approve`: it can't answer other chats' requests.
 */
export function presetTokenAccess(
  preset: AssistantPreset,
  projects: ManagerProjectAllowlist,
  ownProjectId: string,
): AssistantTokenAccess {
  const projectAllowlist = withOwnWorkspace(projects, ownProjectId);
  switch (preset) {
    case "full":
      return { scopes: FULL_SCOPES, projectAllowlist, autoApprove: true };
    case "helper":
      return { scopes: ["threads:read", "threads:write"], projectAllowlist, autoApprove: true };
    case "observer":
      return { scopes: ["threads:read"], projectAllowlist, autoApprove: false };
  }
}

/**
 * The preset a token's scopes say. Approve → Full (also a Full that the
 * technical page set to "ask first"); write without approve → Helper; read
 * only → Observer.
 */
export function presetOfScopes(scopes: ReadonlyArray<ManagerScope>): AssistantPreset {
  if (scopes.includes("threads:write")) {
    return scopes.includes("threads:approve") ? "full" : "helper";
  }
  return "observer";
}

/** The project is one the allowlist (plus its own workspace) reaches. */
export function allowlistReaches(
  allowlist: ManagerProjectAllowlist,
  projectId: string,
  ownProjectId: string,
): boolean {
  return (
    projectId === ownProjectId ||
    allowlist === "all" ||
    (allowlist as ReadonlyArray<string>).includes(projectId)
  );
}

/** What the person reads: a name and one plain line per preset. */
export const ASSISTANT_PRESET_COPY: Readonly<
  Record<
    AssistantPreset,
    { readonly name: string; readonly line: string; readonly details: ReadonlyArray<string> }
  >
> = {
  full: {
    name: "Full",
    line: "Does everything by itself, except spending money and deleting computers.",
    details: [
      "Starts and writes in chats in its projects; they run like your own.",
      "Can approve what those chats ask for.",
      "Opens your apps at the levels you set.",
    ],
  },
  helper: {
    name: "Helper",
    line: "Works in the projects you pick. Chats it starts ask you before risky steps.",
    details: [
      "Starts and writes in chats only in the projects you pick.",
      "Those chats ask you before editing files or running commands.",
      "Can't approve anything for you, and can't write in a chat that runs freer than that.",
      "Opens your apps at the levels you set.",
    ],
  },
  observer: {
    name: "Observer",
    line: "Reads chats in the projects you pick and tells you what it sees. Changes nothing.",
    details: [
      "Reads chats and their status in the projects you pick.",
      "Doesn't start, write in, stop or approve chats.",
      "Apps: reading only, whatever level you set.",
      "Its own schedule and reminders still work.",
    ],
  },
};

/** The honest line under every preset picker (decision 16.10, 21.10). */
export const ASSISTANT_PRESET_BOUNDARY_LINE =
  "On this computer: protection against accidents. For a real boundary — its own computer.";
