/**
 * Plain-language vocabulary for the UI.
 *
 * Every concept the product exposes has one user-facing label and one
 * sentence that explains it in place. Screens read their labels, tooltips,
 * empty states and dialog copy from here so the same idea is never called two
 * different things in two places. Code identifiers and RPC names keep their
 * technical names — this table only governs what a person sees.
 *
 * The rule for technical words: mention the technical name in parentheses on
 * the first occurrence in a screen where it helps ("Instructions (AGENTS.md)"),
 * and never afterwards. `plainLabelWithTechnical` renders that first mention.
 *
 * Kept free of React so tests and non-component code can import it. The
 * inline `<Explain term="…" />` helper lives in `components/Explain.tsx`.
 *
 * @module plainLanguage
 */
import type { RuntimeMode, WorkspaceMachineKind } from "@t3tools/contracts";

export type PlainTerm =
  | "machine"
  | "project"
  | "chat"
  | "step"
  | "agent"
  | "model"
  | "permissions"
  | "instructions"
  | "projectFolder"
  | "snapshot"
  | "myMachines"
  | "agentSetup"
  | "settingsScopeApp"
  | "settingsScopeMachine";

export interface PlainTermEntry {
  /** What the UI calls the concept. */
  readonly label: string;
  /** Plural form, when a screen lists several. */
  readonly plural: string;
  /** One sentence that explains the concept to someone with no tech background. */
  readonly explanation: string;
  /**
   * The technical name the concept had (or still has in code / docs). Shown in
   * parentheses on first mention where it helps the user recognise it.
   */
  readonly technical?: string;
}

export const PLAIN_TERMS: Readonly<Record<PlainTerm, PlainTermEntry>> = {
  machine: {
    label: "Machine",
    plural: "Machines",
    explanation: "Where your files and agents actually run.",
    technical: "environment",
  },
  project: {
    label: "Project",
    plural: "Projects",
    explanation: "A folder the agent works in.",
  },
  chat: {
    label: "Chat",
    plural: "Chats",
    explanation: "One conversation about one task.",
    technical: "thread",
  },
  step: {
    label: "Step",
    plural: "Steps",
    explanation: "One message from you and the agent's reply.",
    technical: "turn",
  },
  agent: {
    label: "Agent",
    plural: "Agents",
    explanation: "The AI that does the work.",
    technical: "harness",
  },
  model: {
    label: "Model",
    plural: "Models",
    explanation: "The brain the agent uses.",
  },
  permissions: {
    label: "Permissions",
    plural: "Permissions",
    explanation: "How much the agent may do on its own before asking you.",
    technical: "runtime mode",
  },
  instructions: {
    label: "Instructions",
    plural: "Instructions",
    explanation: "A note the agent reads before every task in this project.",
    technical: "AGENTS.md",
  },
  projectFolder: {
    label: "Project folder",
    plural: "Project folders",
    explanation: "The agent's workspace on this machine.",
    technical: "cwd",
  },
  snapshot: {
    label: "Snapshot",
    plural: "Snapshots",
    explanation: "An undo point after each step.",
    technical: "checkpoint",
  },
  myMachines: {
    label: "My machines",
    plural: "My machines",
    explanation: "Every computer and box this app can send work to.",
    technical: "workspace registry",
  },
  agentSetup: {
    label: "Agent setup",
    plural: "Agent setups",
    explanation: "One agent with its own settings, keys and models.",
    technical: "provider instance",
  },
  settingsScopeApp: {
    label: "Everywhere",
    plural: "Everywhere",
    explanation:
      "Stored in this copy of Uno Work. It applies no matter which machine you are working on.",
    technical: "app scope",
  },
  settingsScopeMachine: {
    label: "On this machine",
    plural: "On this machine",
    explanation:
      "Stored on that one machine. Pick another machine at the top of Settings to change it there.",
    technical: "environment scope",
  },
};

export const PLAIN_TERM_KEYS = Object.keys(PLAIN_TERMS) as ReadonlyArray<PlainTerm>;

export function plainLabel(term: PlainTerm): string {
  return PLAIN_TERMS[term].label;
}

export function plainPlural(term: PlainTerm): string {
  return PLAIN_TERMS[term].plural;
}

export function plainExplanation(term: PlainTerm): string {
  return PLAIN_TERMS[term].explanation;
}

/**
 * The label with its technical name in parentheses — for the first mention on
 * a screen only. Terms without a technical name render the bare label.
 */
export function plainLabelWithTechnical(term: PlainTerm): string {
  const entry = PLAIN_TERMS[term];
  return entry.technical ? `${entry.label} (${entry.technical})` : entry.label;
}

/**
 * Permission levels, in the order they are offered. `consequence` is the one
 * line that tells the user what changes when they pick it.
 */
export interface PermissionModeEntry {
  readonly label: string;
  readonly consequence: string;
}

export const PERMISSION_MODES: Readonly<Record<RuntimeMode, PermissionModeEntry>> = {
  "approval-required": {
    label: "Ask before changes",
    consequence: "The agent asks you before editing files or running commands.",
  },
  "auto-accept-edits": {
    label: "Edit files freely",
    consequence: "The agent edits files on its own, but asks before running commands.",
  },
  "full-access": {
    label: "Full access",
    consequence: "The agent edits files and runs commands without asking.",
  },
};

export const PERMISSION_MODE_ORDER: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
];

export function permissionModeLabel(mode: RuntimeMode): string {
  return PERMISSION_MODES[mode].label;
}

export function permissionModeConsequence(mode: RuntimeMode): string {
  return PERMISSION_MODES[mode].consequence;
}

/** What kind of machine a row is, in the user's words. */
export const MACHINE_KIND_LABELS: Readonly<Record<WorkspaceMachineKind, string>> = {
  local: "This computer",
  uno_box: "Uno box",
  ssh: "Other machine",
};

export type MachineStatus = "online" | "offline" | "sleeping" | "unknown";

export const MACHINE_STATUS_LABELS: Readonly<Record<MachineStatus, string>> = {
  online: "Online",
  offline: "Offline",
  sleeping: "Sleeping",
  unknown: "Not seen yet",
};

/**
 * Where a new chat works: straight in the project folder, or in a separate
 * copy of it (a git worktree) so several chats can change files side by side.
 */
export const CHAT_WORKSPACE_MODE_LABELS = {
  local: "In the project folder",
  worktree: "In a separate copy",
} as const;

export const CHAT_WORKSPACE_MODE_EXPLANATIONS = {
  local: "Changes land straight in the project folder.",
  worktree:
    "The agent gets its own copy of the project (a git worktree), so other chats are not disturbed.",
} as const;
