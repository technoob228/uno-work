/**
 * Assistant presets — Full / Helper / Observer (decision 21.10: real, enforced
 * by the daemon, not the prompt). One table of what each preset may do, shared
 * by the daemon (which enforces it on every call) and the UI (which explains
 * it), so the two can't drift.
 *
 * The person sees two modes (Misha 23.10, "keep it simple"): "Does it itself"
 * (Full) and "Asks first" (Helper; an Observer from before reads as "Asks
 * first" too and keeps its read-only rules). "Asks first" is enforced by the
 * daemon: every outward-acting tool call of its chats waits for the person's
 * Allow (`asksFirstCategory`, `unoWork/tools.ts`, `assistant_create`).
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
  | "change-things"
  /** assistant_create: set up a helper (never wider than itself, checked separately) */
  | "create-assistant"
  /** the keys of its projects (Uno vault → the project's .env): Full and Helper, never Observer */
  | "read-project-keys";

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
    "create-assistant",
    "read-project-keys",
  ]),
  helper: new Set<AssistantAction>([
    "read-chats",
    "start-chat",
    "write-chat",
    "stop-chat",
    "remind",
    "change-things",
    "create-assistant",
    "read-project-keys",
  ]),
  observer: new Set<AssistantAction>(["read-chats", "remind"]),
};

/** The one decision: may an assistant with this preset do this? */
export function assistantPresetAllows(preset: AssistantPreset, action: AssistantAction): boolean {
  return ALLOWED[preset].has(action);
}

/**
 * The widest runtime mode a chat started or steered by this assistant may
 * run in. Helper ("Asks first", 23.10): the chats it starts edit files
 * without asking but ask before commands (`auto-accept-edits`) — it works on
 * files without nagging; what goes out asks anyway (`asksFirstCategory`). It
 * may not steer a chat that runs wider. Observer: `approval-required`.
 * Null = no ceiling beyond the caller's own mode.
 */
export function presetRuntimeCeiling(preset: AssistantPreset): RuntimeMode | null {
  switch (preset) {
    case "full":
      return null;
    case "helper":
      return "auto-accept-edits";
    case "observer":
      return "approval-required";
  }
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

const FULL_SCOPES: ReadonlyArray<ManagerScope> = [
  "threads:read",
  "threads:write",
  "threads:approve",
];

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
  return [...new Set<string>([ownProjectId, ...projects])] as unknown as ReadonlyArray<ProjectId>;
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

// ── The two modes the person sees (Misha 23.10) ──────────────────────────

export type AssistantMode = "itself" | "asks-first";

export const ASSISTANT_MODES: ReadonlyArray<AssistantMode> = ["itself", "asks-first"];

/** Full → "Does it itself"; Helper and Observer → "Asks first". */
export function assistantModeOf(preset: AssistantPreset): AssistantMode {
  return preset === "full" ? "itself" : "asks-first";
}

/**
 * The preset a mode stands for. "Asks first" is Helper; an Observer set up
 * before the two modes stays an Observer (it only reads) until the person
 * picks "Does it itself".
 */
export function presetForMode(mode: AssistantMode, current: AssistantPreset): AssistantPreset {
  if (mode === "itself") return "full";
  return current === "observer" ? "observer" : "helper";
}

/** Its outward-acting calls wait for the person's Allow (enforced by the daemon). */
export function presetAsksFirst(preset: AssistantPreset): boolean {
  return preset !== "full";
}

/** What an "Asks first" assistant asks before — exactly what the daemon checks. */
export type AsksFirstCategory =
  | "email"
  | "sites"
  | "internet"
  | "share"
  | "delete"
  | "create"
  | "connected-apps";

export const ASKS_FIRST_CATEGORY_LABEL: Readonly<Record<AsksFirstCategory, string>> = {
  email: "Sending email",
  sites: "Publishing, changing or taking down a site",
  internet: "Putting an app or a Spark on the internet",
  share: "Making a share link",
  delete: "Deleting apps or Sparks, or cleaning up files",
  create: "Creating databases, computers or other assistants",
  "connected-apps": "Changing things in your connected apps (Gmail, Drive, Notion, GitHub)",
};

export const ASKS_FIRST_CATEGORIES: ReadonlyArray<AsksFirstCategory> = [
  "email",
  "sites",
  "internet",
  "share",
  "delete",
  "create",
  "connected-apps",
];

/** `uno-work` tools (and `assistant_create`) that act outward, by category. */
const OUTWARD_TOOLS: Readonly<Record<string, AsksFirstCategory>> = {
  mail_send: "email",
  site_publish: "sites",
  site_unpublish: "sites",
  site_set_password: "sites",
  site_forms_set: "sites",
  app_deploy: "internet",
  app_show_on_internet: "internet",
  spark_deploy: "internet",
  file_share_link: "share",
  drive_share_link: "share",
  app_remove: "delete",
  spark_delete: "delete",
  db_create: "create",
  computer_create: "create",
  assistant_create: "create",
};

/**
 * The category an "Asks first" assistant asks before for this call, or null
 * when it runs on its own. `computer_cleanup` deletes only with `apply`.
 * Connector tools are judged by the caller (`connected-apps` for any that
 * changes something).
 */
export function asksFirstCategory(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): AsksFirstCategory | null {
  if (tool === "computer_cleanup") return args.apply === true ? "delete" : null;
  return OUTWARD_TOOLS[tool] ?? null;
}

/** What the person reads about a mode: a name, one line, and the details. */
export const ASSISTANT_MODE_COPY: Readonly<
  Record<
    AssistantMode,
    { readonly name: string; readonly line: string; readonly details: ReadonlyArray<string> }
  >
> = {
  itself: {
    name: "Does it itself",
    line: "Works on its own, like you in your own chats.",
    details: [
      "Starts and writes in chats; they run like your own.",
      "Can approve what those chats ask for.",
      "Sends email, publishes sites and deploys without asking.",
      "Still asks, like any chat: showing an app on the internet, deleting apps or Sparks, share links, new computers or databases.",
    ],
  },
  "asks-first": {
    name: "Asks first",
    line: "Works on files and chats by itself. Asks you before anything goes out or gets deleted.",
    details: [
      ...ASKS_FIRST_CATEGORIES.map((category) => ASKS_FIRST_CATEGORY_LABEL[category]),
      "Chats it starts edit files freely and ask before running commands.",
      "Doesn't approve anything for you.",
    ],
  },
};

/** What the person reads: a name and one plain line per preset. */
export const ASSISTANT_PRESET_COPY: Readonly<
  Record<
    AssistantPreset,
    { readonly name: string; readonly line: string; readonly details: ReadonlyArray<string> }
  >
> = {
  full: ASSISTANT_MODE_COPY.itself,
  helper: ASSISTANT_MODE_COPY["asks-first"],
  // Set up before the two modes: it keeps its read-only rules until the
  // person picks a mode.
  observer: {
    name: "Reads only",
    line: "Only reads chats in its projects and tells you what it sees. Changes nothing.",
    details: [
      "Reads chats and their status in the projects you pick.",
      "Doesn't start, write in, stop or approve chats.",
      "Apps: reading only, whatever level you set.",
      "Doesn't get your projects' keys.",
      "Its own schedule and reminders still work.",
    ],
  },
};

/** The honest line under every mode picker (decision 16.10, 21.10). */
export const ASSISTANT_PRESET_BOUNDARY_LINE =
  "On this computer: protection against accidents, not a wall. For a real boundary — its own computer.";
