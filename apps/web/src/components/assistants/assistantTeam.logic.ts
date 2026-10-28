/**
 * The person's team of assistants (Misha 14.10, strategy/ASSISTANT_SETUP_FLOW.md):
 * Uno and the "buddies" it or the person set up — each a teammate that takes
 * tasks only from its owner, with its own face, role, rights and AI.
 *
 * An assistant is a folder (`assistant-*` project) on one of the person's
 * computers; its chats are the threads in that folder. What the person chose
 * in the setup (where to talk, access, preset, AI, who it is, who made it)
 * is its profile (`assistantTeamStore.ts`).
 *
 * Pure part only — no I/O, no React.
 */
import { ASSISTANT_PROJECT_ID, isAssistantProjectId } from "@t3tools/contracts";
import { ASSISTANT_PRESET_COPY } from "@t3tools/shared/assistantPreset";

// ── What the person picks in the setup ───────────────────────────────────

/** Step 3 "What it may do". */
export type AssistantPreset = "observer" | "helper" | "full";
/** Step 4 "What it runs on". */
export type AssistantBrain = "uno" | "claude" | "chatgpt" | "key";
/** Step 1 "Where you talk to it". */
export type AssistantChannel = "uno-bot" | "own-bot" | "slack";

/** Decision 14.10 (2): full access by default; Helper and Observer are offered. */
export const DEFAULT_PRESET: AssistantPreset = "full";
/** Decision 14.10 (1): Uno's second bot, linked by a `?start=` link. */
export const DEFAULT_CHANNEL: AssistantChannel = "uno-bot";

/**
 * The presets as the mock's setup chat offers them. The names and lines are
 * the shared ones (Misha 23.10: "Autonomous" / "Cautious"; an old
 * Observer reads "Reads only") — the same words the real page shows, and
 * nothing the daemon doesn't enforce (no payments: there is no payment tool).
 */
export const PRESETS: ReadonlyArray<{
  readonly id: AssistantPreset;
  readonly name: string;
  readonly line: string;
  /** Two or three things it would do, so the preset reads concretely (critics 16.10). */
  readonly examples: string;
}> = [
  {
    id: "full",
    name: ASSISTANT_PRESET_COPY.full.name,
    line: ASSISTANT_PRESET_COPY.full.line,
    examples: "Starts chats in your projects, pushes a fix, sends the morning plan.",
  },
  {
    id: "helper",
    name: ASSISTANT_PRESET_COPY.helper.name,
    line: ASSISTANT_PRESET_COPY.helper.line,
    examples: "Writes the fix in a chat — asks you before it emails anyone or publishes a site.",
  },
  {
    id: "observer",
    name: ASSISTANT_PRESET_COPY.observer.name,
    line: ASSISTANT_PRESET_COPY.observer.line,
    examples: "“What moved today” every evening; never writes anywhere.",
  },
];

export const PRESET_NAME: Readonly<Record<AssistantPreset, string>> = {
  observer: ASSISTANT_PRESET_COPY.observer.name,
  helper: ASSISTANT_PRESET_COPY.helper.name,
  full: ASSISTANT_PRESET_COPY.full.name,
};

export const BRAIN_NAME: Readonly<Record<AssistantBrain, string>> = {
  uno: "Uno AI",
  claude: "Claude plan",
  chatgpt: "ChatGPT plan",
  key: "Own key",
};

export const CHANNEL_NAME: Readonly<Record<AssistantChannel, string>> = {
  "uno-bot": "Telegram · Uno bot",
  "own-bot": "Telegram · own bot",
  slack: "Slack",
};

/** The areas (Misha 21.10): what an assistant takes off the person's plate. */
export const ROLE_CHIPS = [
  "Personal assistant",
  "Finance",
  "Sales",
  "Dev",
  "YouTube & content",
] as const;

export const CHARACTER_CHIPS = [
  "Calm and brief",
  "Friendly",
  "Straight to the point",
  "Playful",
] as const;

/** Skills offered on step 5, the ones of the picked roles first. */
export const SKILLS_BY_ROLE: Readonly<Record<string, ReadonlyArray<string>>> = {
  "Personal assistant": ["Morning plan", "Reminders", "Pay invoices (asks first)", "Inbox digest"],
  Finance: ["Invoices into a sheet", "What's due", "Subscriptions", "Monthly summary"],
  Sales: ["Leads in Notion", "Follow-up drafts", "Who to answer today"],
  Dev: ["Code review", "Run tests", "Fix CI", "Release notes"],
  "YouTube & content": ["Video ideas", "Scripts", "Titles and descriptions", "Content plan"],
};

/** Names offered to a new teammate (critics 16.10: the name comes filled in). */
export const SUGGESTED_NAMES = ["Ada", "Scout", "Builder", "Juno", "Milo", "Echo", "Iris"] as const;

export function suggestName(taken: ReadonlyArray<string>): string {
  const lower = new Set(taken.map((name) => name.trim().toLowerCase()));
  return SUGGESTED_NAMES.find((name) => !lower.has(name.toLowerCase())) ?? uniqueName("Ada", taken);
}

/** Only the skills of the picked roles (critics 16.10), in role order. */
export function roleSkills(roles: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(roles.flatMap((role) => SKILLS_BY_ROLE[role] ?? []))];
}

/** Picking a role turns its first two skills on; dropping it drops them. */
export function toggleRole(
  draft: Pick<AssistantDraft, "roles" | "skills">,
  role: string,
): Pick<AssistantDraft, "roles" | "skills"> {
  if (draft.roles.includes(role)) {
    const roles = draft.roles.filter((item) => item !== role);
    const keep = new Set(roleSkills(roles));
    return { roles, skills: draft.skills.filter((skill) => keep.has(skill)) };
  }
  const added = (SKILLS_BY_ROLE[role] ?? []).slice(0, 2);
  return { roles: [...draft.roles, role], skills: [...new Set([...draft.skills, ...added])] };
}

export function skillsFor(roles: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (skill: string) => {
    if (!seen.has(skill)) {
      seen.add(skill);
      out.push(skill);
    }
  };
  for (const role of roles) for (const skill of SKILLS_BY_ROLE[role] ?? []) add(skill);
  for (const skills of Object.values(SKILLS_BY_ROLE)) for (const skill of skills) add(skill);
  return out;
}

/** Faces the "Shuffle" on step 5 picks from (emoji + a background tone). */
export const AVATARS: ReadonlyArray<{ readonly emoji: string; readonly tone: AvatarTone }> = [
  { emoji: "🛠️", tone: "amber" },
  { emoji: "🔭", tone: "teal" },
  { emoji: "🦊", tone: "orange" },
  { emoji: "🐙", tone: "violet" },
  { emoji: "🚀", tone: "sky" },
  { emoji: "🌿", tone: "emerald" },
  { emoji: "🧠", tone: "rose" },
  { emoji: "🛡️", tone: "slate" },
];

export type AvatarTone =
  | "amber"
  | "teal"
  | "orange"
  | "violet"
  | "sky"
  | "emerald"
  | "rose"
  | "slate";

export function nextAvatar(current: string | null, seed: number): (typeof AVATARS)[number] {
  const others = AVATARS.filter((avatar) => avatar.emoji !== current);
  return others[Math.abs(seed) % others.length]!;
}

// ── The profile ───────────────────────────────────────────────────────────

/** "env:project" — a project id is unique per computer, not across them. */
export type AssistantKey = string;

export function assistantKeyOf(environmentId: string, projectId: string): AssistantKey {
  return `${environmentId}:${projectId}`;
}

export interface AssistantProfile {
  readonly environmentId: string;
  readonly projectId: string;
  readonly name: string;
  /** null: Uno's own face. */
  readonly emoji: string | null;
  /**
   * Its picture's file name on its computer (`.uno/avatar-<ms>.webp`), shown
   * instead of the emoji; null / absent: the emoji (Misha 23.10).
   */
  readonly avatar?: string | null;
  readonly tone: AvatarTone;
  readonly roles: ReadonlyArray<string>;
  readonly character: string;
  readonly skills: ReadonlyArray<string>;
  readonly preset: AssistantPreset;
  readonly brain: AssistantBrain;
  readonly channel: AssistantChannel;
  /** Telegram / Slack handle once linked ("@misha", "#growth"). */
  readonly channelHandle: string | null;
  /** Project names it may open; "all" = every project, new ones too. */
  readonly projects: "all" | ReadonlyArray<string>;
  /** Computers (environment ids) it may start chats on. */
  readonly computers: ReadonlyArray<string>;
  /** The assistant that set this one up; null = the person did. */
  readonly createdBy: AssistantKey | null;
  readonly createdAt: string;
  /** The setup was finished (or skipped with "Later"). */
  readonly setUpAt: string | null;
  readonly revokedAt: string | null;
  /** Uno isn't revoked, it's paused: scheduled tasks and the bot wait (critics track 3). */
  readonly pausedAt?: string | null;
  /**
   * What it can use beyond projects and computers (track 3, Misha 16.10):
   * connectors, the browser and its logins, the vault, skills. Absent = full
   * access to this computer (Uno's default; decision 14.10 (2)).
   */
  readonly access?: AssistantAccess;
  /**
   * Decision 16.10 (Misha): limited rights hold only on a computer of its own
   * (on a shared one every assistant can read the others' files). The label
   * of that computer; absent = it lives next to you (full access only).
   */
  readonly ownComputer?: string | null;
  /** What it did that its chats don't show (set up a teammate, lost access). */
  readonly activity?: ReadonlyArray<AssistantActivityEntry>;
  /** Its repeating tasks, as its page lists them (from its schedule). */
  readonly schedule?: ReadonlyArray<{ readonly name: string; readonly when: string }>;
}

/** The setup's answers before "Create". */
export interface AssistantDraft {
  readonly channel: AssistantChannel;
  readonly projects: "all" | ReadonlyArray<string>;
  readonly computers: ReadonlyArray<string>;
  readonly preset: AssistantPreset;
  readonly brain: AssistantBrain;
  readonly name: string;
  readonly emoji: string | null;
  readonly tone: AvatarTone;
  readonly roles: ReadonlyArray<string>;
  readonly character: string;
  readonly skills: ReadonlyArray<string>;
  readonly access: AssistantAccess;
  /**
   * With limited rights: the computer it lives on — the label of one you
   * have, or null for a new Lite one named `ownComputerName` (decision 16.10).
   */
  readonly ownComputer: string | null;
}

/**
 * The setup starts filled in (Misha: "absurdly simple"): Uno's bot, every
 * project, this computer, full access, Uno AI. A first assistant is "Uno".
 */
export function defaultDraft(input: {
  readonly thisComputer: string | null;
  readonly existing: ReadonlyArray<Pick<AssistantProfile, "name" | "emoji">>;
  /** Setting up Uno itself (first click on Uno). */
  readonly forUno?: boolean;
}): AssistantDraft {
  const avatar = nextAvatar(null, input.existing.length + 1);
  return {
    channel: DEFAULT_CHANNEL,
    projects: "all",
    computers: input.thisComputer ? [input.thisComputer] : [],
    preset: DEFAULT_PRESET,
    brain: "uno",
    name: input.forUno ? "Uno" : suggestName(input.existing.map((profile) => profile.name)),
    emoji: input.forUno ? null : avatar.emoji,
    tone: input.forUno ? "violet" : avatar.tone,
    roles: input.forUno ? ["Personal assistant"] : [],
    character: "Calm and brief",
    skills: input.forUno ? ["Morning plan", "Reminders"] : [],
    access: input.forUno ? FULL_ACCESS : NEW_TEAMMATE_ACCESS,
    ownComputer: null,
  };
}

/** A name nobody on the team has yet ("Scout", "Scout 2"). */
export function uniqueName(name: string, taken: ReadonlyArray<string>): string {
  const base = name.trim() || "Assistant";
  const lower = new Set(taken.map((entry) => entry.trim().toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/** Its folder: `assistant-scout` (the daemon makes the real one). */
export function assistantProjectIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `assistant-${slug || "new"}`;
}

/** One line under the name: "Developer · Claude plan · Helper". */
export function profileLine(profile: Pick<AssistantProfile, "roles" | "brain" | "preset">): string {
  return [profile.roles[0], BRAIN_NAME[profile.brain], PRESET_NAME[profile.preset]]
    .filter(Boolean)
    .join(" · ");
}

/** "every project" / "fishcode, uno-work-app". */
export function projectsLine(projects: AssistantProfile["projects"]): string {
  if (projects === "all") return "every project";
  if (projects.length === 0) return "no projects";
  return projects.join(", ");
}

// ── Rights: a child never gets more than its parent ───────────────────────

const PRESET_RANK: Readonly<Record<AssistantPreset, number>> = {
  observer: 0,
  helper: 1,
  full: 2,
};

/**
 * Decision 14.10 (3): an assistant sets up another one by itself, without
 * asking, only within its own rights — the daemon checks this, not a prompt.
 * Returns what goes beyond the parent (empty = within).
 */
export function rightsBeyondParent(
  parent: Pick<AssistantProfile, "preset" | "projects" | "computers">,
  child: Pick<AssistantProfile, "preset" | "projects" | "computers">,
): ReadonlyArray<string> {
  const beyond: string[] = [];
  if (PRESET_RANK[child.preset] > PRESET_RANK[parent.preset]) {
    beyond.push(`${PRESET_NAME[child.preset]} is more than ${PRESET_NAME[parent.preset]}`);
  }
  if (parent.projects !== "all") {
    if (child.projects === "all") beyond.push("every project");
    else {
      const allowed = new Set(parent.projects);
      for (const project of child.projects) if (!allowed.has(project)) beyond.push(project);
    }
  }
  const computers = new Set(parent.computers);
  for (const computer of child.computers) if (!computers.has(computer)) beyond.push(computer);
  return beyond;
}

/**
 * Decision 16.10 (Misha): cutting an assistant's rights cuts everything it
 * set up, automatically — each child keeps only what is within its parent.
 * Returns the child as it becomes and, in plain words, what it loses.
 */
export function clampToParent(
  parent: Pick<AssistantProfile, "preset" | "projects" | "computers" | "access">,
  child: AssistantProfile,
): { readonly child: AssistantProfile; readonly lost: ReadonlyArray<string> } {
  const lost: string[] = [];
  let next: AssistantProfile = child;
  if (PRESET_RANK[child.preset] > PRESET_RANK[parent.preset]) {
    lost.push(`${PRESET_NAME[child.preset]} → ${PRESET_NAME[parent.preset]}`);
    next = { ...next, preset: parent.preset };
  }
  if (parent.projects !== "all") {
    const allowed = parent.projects;
    if (child.projects === "all") {
      lost.push("projects beyond " + allowed.join(", "));
      next = { ...next, projects: allowed };
    } else {
      for (const id of child.projects) if (!allowed.includes(id)) lost.push(id);
      next = { ...next, projects: child.projects.filter((id) => allowed.includes(id)) };
    }
  }
  const parentAccess = accessOf(parent);
  const childAccess = accessOf(child);
  const browser =
    BROWSER_RANK[childAccess.browser] > BROWSER_RANK[parentAccess.browser]
      ? parentAccess.browser
      : childAccess.browser;
  if (browser !== childAccess.browser) lost.push("using the browser freely");
  const access: AssistantAccess = {
    ...childAccess,
    browser,
    connectors: clampConnectors(parentAccess.connectors, childAccess.connectors, lost),
    logins: clampPicks(parentAccess.logins, childAccess.logins, "login", lost),
    secrets: clampPicks(parentAccess.secrets, childAccess.secrets, "key", lost),
    projectSkills: childAccess.projectSkills && parentAccess.projectSkills,
  };
  if (childAccess.projectSkills && !access.projectSkills) lost.push("project skills");
  if (child.access !== undefined || !isFullAccess(access)) next = { ...next, access };
  return { child: next, lost };
}

/**
 * "Uses your ChatGPT plan · shared with Uno" / "Uno AI · from your plan's AI
 * hours" — whose subscription and limit it spends (decision 16.10).
 */
export function brainLine(
  profile: Pick<AssistantProfile, "brain" | "name">,
  team: ReadonlyArray<Pick<AssistantProfile, "brain" | "name">>,
  /** The computer whose sign-in it uses (a plan is signed in per computer). */
  signedInOn?: string,
): string {
  const others = team
    .filter((other) => other.name !== profile.name && other.brain === profile.brain)
    .map((other) => other.name);
  const shared = others.length > 0 ? ` · shared with ${others.join(", ")}` : "";
  const where = signedInOn ? ` (signed in on ${signedInOn})` : "";
  switch (profile.brain) {
    case "uno":
      return `Uno AI · from your plan's AI hours${shared}`;
    case "claude":
      return `Your Claude plan${where} · one limit with your own chats${shared}`;
    case "chatgpt":
      return `Your ChatGPT plan${where} · one limit with your own chats${shared}`;
    case "key":
      return `Your own key · billed by its provider${shared}`;
  }
}

export interface RightsLoss {
  readonly key: AssistantKey;
  readonly name: string;
  readonly lost: ReadonlyArray<string>;
}

/**
 * Applies a change of rights to one assistant and cuts everything it set up
 * down to the new rights, all the way down. `losses` names who loses what —
 * the warning before, the Inbox card after.
 */
export function cascadeRights(
  profiles: Readonly<Record<AssistantKey, AssistantProfile>>,
  key: AssistantKey,
  patch: Partial<
    Pick<AssistantProfile, "preset" | "projects" | "computers" | "access" | "ownComputer">
  >,
): {
  readonly profiles: Record<AssistantKey, AssistantProfile>;
  readonly losses: ReadonlyArray<RightsLoss>;
} {
  const next: Record<AssistantKey, AssistantProfile> = { ...profiles };
  const current = next[key];
  if (!current) return { profiles: next, losses: [] };
  next[key] = { ...current, ...patch };
  const losses: RightsLoss[] = [];
  const queue: AssistantKey[] = [key];
  const seen = new Set<AssistantKey>(queue);
  while (queue.length > 0) {
    const parentKey = queue.shift()!;
    const parent = next[parentKey]!;
    for (const [childKey, child] of Object.entries(next)) {
      if (child.createdBy !== parentKey || seen.has(childKey) || child.revokedAt !== null) continue;
      seen.add(childKey);
      const { child: clamped, lost } = clampToParent(parent, child);
      next[childKey] = clamped;
      if (lost.length > 0) losses.push({ key: childKey, name: child.name, lost });
      queue.push(childKey);
    }
  }
  return { profiles: next, losses };
}

/** "Scout will lose: Google Drive, login github." */
export function lossLine(losses: ReadonlyArray<RightsLoss>, future = true): string {
  return losses
    .map((loss) => `${loss.name} ${future ? "will lose" : "lost"}: ${loss.lost.join(", ")}`)
    .join(" · ");
}

/**
 * Decision 16.10: limited rights hold only on a computer of its own — on a
 * shared one any assistant can read the others' files. Uno lives with you.
 */
export function needsOwnComputer(
  profile: Pick<AssistantProfile, "preset" | "ownComputer">,
  isUno: boolean,
): boolean {
  return !isUno && profile.preset !== "full" && !profile.ownComputer;
}

/** "scout-box" — the name its own computer gets. */
export function ownComputerName(name: string): string {
  return `${assistantProjectIdFor(name).replace(/^assistant-/, "")}-box`;
}

// ── What it did ───────────────────────────────────────────────────────────

/** Kinds the Inbox also gets (decision 16.10): money, deleting, a deploy, a new teammate. */
export type ActivityKind =
  | "chat"
  | "money"
  | "delete"
  | "deploy"
  | "teammate"
  | "access"
  | "note"
  /** A call to a connected app (GitHub, Drive…). */
  | "connector"
  /** Signed in to a site with a saved login. */
  | "login"
  /** Used a key or token in a command. */
  | "key"
  /** Stopped by its rights — what it wanted and couldn't. */
  | "denied";

export interface AssistantActivityEntry {
  readonly at: string;
  readonly kind: ActivityKind;
  readonly text: string;
  /** "you": you said yes to it; "auto": its rights let it, nobody asked. */
  readonly by?: "you" | "auto";
}

export const IMPORTANT_ACTIVITY: ReadonlySet<ActivityKind> = new Set([
  "money",
  "delete",
  "deploy",
  "teammate",
  "access",
]);

/** Its own log and the chats it started or talked in, newest first. */
export function activityFeed(
  own: ReadonlyArray<AssistantActivityEntry>,
  chats: ReadonlyArray<{ readonly title: string; readonly at: string }>,
): ReadonlyArray<
  Omit<AssistantActivityEntry, "by"> & {
    readonly by: "you" | "auto" | null;
    readonly important: boolean;
  }
> {
  return [
    ...own,
    ...chats.map((chat) => ({ at: chat.at, kind: "chat" as const, text: chat.title })),
  ]
    .toSorted((a, b) => b.at.localeCompare(a.at))
    .map((entry) => ({
      at: entry.at,
      kind: entry.kind,
      text: entry.text,
      by: "by" in entry && entry.by ? entry.by : null,
      important: IMPORTANT_ACTIVITY.has(entry.kind),
    }));
}

// ── Who set up whom ───────────────────────────────────────────────────────

export interface AssistantTreeNode<T> {
  readonly item: T;
  readonly children: ReadonlyArray<AssistantTreeNode<T>>;
}

/** The team as a tree: the person's assistants at the root, the ones they set up below. */
export function buildAssistantTree<T extends { key: AssistantKey; createdBy: AssistantKey | null }>(
  items: ReadonlyArray<T>,
): ReadonlyArray<AssistantTreeNode<T>> {
  const keys = new Set(items.map((item) => item.key));
  const childrenOf = new Map<AssistantKey | null, T[]>();
  for (const item of items) {
    // A parent that is gone: the child shows at the root.
    const parent = item.createdBy !== null && keys.has(item.createdBy) ? item.createdBy : null;
    const list = childrenOf.get(parent) ?? [];
    list.push(item);
    childrenOf.set(parent, list);
  }
  const build = (parent: AssistantKey | null, seen: Set<AssistantKey>): AssistantTreeNode<T>[] =>
    (childrenOf.get(parent) ?? [])
      .filter((item) => !seen.has(item.key))
      .map((item) => {
        const next = new Set(seen).add(item.key);
        return { item, children: build(item.key, next) };
      });
  return build(null, new Set());
}

/** Revoking one revokes everything it set up, all the way down. */
export function descendantKeys(
  items: ReadonlyArray<{ key: AssistantKey; createdBy: AssistantKey | null }>,
  key: AssistantKey,
): ReadonlyArray<AssistantKey> {
  const out: AssistantKey[] = [];
  const queue = [key];
  const seen = new Set<AssistantKey>([key]);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const item of items) {
      if (item.createdBy === parent && !seen.has(item.key)) {
        seen.add(item.key);
        out.push(item.key);
        queue.push(item.key);
      }
    }
  }
  return out;
}

// ── Its chats in the sidebar ──────────────────────────────────────────────

export interface TeamThread {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly archivedAt: string | null;
  readonly assistantRole?: "chat" | "spawned" | null | undefined;
  readonly spawnedByThreadId?: string | null | undefined;
}

/**
 * A conversation with an assistant: a chat in its folder that it didn't
 * start for work (`spawned`) and no agent started (`spawnedByThreadId`).
 */
export function isTeamConversation(
  thread: Omit<TeamThread, "id" | "environmentId" | "archivedAt">,
): boolean {
  if (thread.assistantRole === "chat") return true;
  return (
    isAssistantProjectId(thread.projectId) &&
    thread.assistantRole !== "spawned" &&
    (thread.spawnedByThreadId ?? null) === null
  );
}

export type AssistantActivity = "working" | "waiting" | "idle";

export const ACTIVITY_LABEL: Readonly<Record<AssistantActivity, string>> = {
  working: "Working",
  waiting: "Waiting for you",
  idle: "Idle",
};

export interface TeamChats<T> {
  /** Conversations with it, newest first. */
  readonly conversations: ReadonlyArray<T>;
  /** Chats it started for work (anywhere), newest first. */
  readonly work: ReadonlyArray<T>;
}

/**
 * Its conversations (threads in its folder on its computer) and the chats it
 * started: the ones started from its conversations, and — for Uno, the
 * computer's default assistant — the ones the daemon marks `spawned`.
 */
export function chatsOfAssistant<T extends TeamThread>(
  threads: ReadonlyArray<T>,
  assistant: { readonly environmentId: string; readonly projectId: string },
  activityMs: (thread: T) => number,
): TeamChats<T> {
  const live = threads.filter((thread) => thread.archivedAt === null);
  const conversations = live.filter(
    (thread) =>
      thread.environmentId === assistant.environmentId &&
      thread.projectId === assistant.projectId &&
      isTeamConversation(thread),
  );
  const ids = new Set(conversations.map((thread) => thread.id));
  const isHome = assistant.projectId === ASSISTANT_PROJECT_ID;
  const work = live.filter((thread) => {
    if (ids.has(thread.id)) return false;
    if (thread.spawnedByThreadId != null) return ids.has(thread.spawnedByThreadId);
    return (
      isHome &&
      thread.assistantRole === "spawned" &&
      thread.environmentId === assistant.environmentId
    );
  });
  const newest = (a: T, b: T) => activityMs(b) - activityMs(a);
  return { conversations: conversations.toSorted(newest), work: work.toSorted(newest) };
}

/** Its dot: something waits for the person › something runs › free. */
export function assistantActivity<T>(
  chats: ReadonlyArray<T>,
  statusOf: (thread: T) => "approval" | "input" | "working" | "failed" | "ready",
): AssistantActivity {
  let working = false;
  for (const thread of chats) {
    const status = statusOf(thread);
    if (status === "approval" || status === "input") return "waiting";
    if (status === "working") working = true;
  }
  return working ? "working" : "idle";
}

/** How many chats show under an unfolded assistant before "Show N more". */
export const ASSISTANT_CHATS_PREVIEW = 3;

/** The first few, the open one always among them. */
export function previewChats<T>(
  chats: ReadonlyArray<T>,
  input: {
    readonly showAll: boolean;
    readonly isOpen: (thread: T) => boolean;
    readonly limit?: number;
  },
): { readonly visible: ReadonlyArray<T>; readonly hiddenCount: number } {
  const limit = input.limit ?? ASSISTANT_CHATS_PREVIEW;
  if (input.showAll || chats.length <= limit) return { visible: chats, hiddenCount: 0 };
  const head = chats.slice(0, limit);
  const open = chats.slice(limit).find(input.isOpen);
  const visible = open ? [...head, open] : head;
  return { visible, hiddenCount: chats.length - visible.length };
}

/** A click on the row: its latest conversation (null = start one). */
export function latestConversation<T>(chats: TeamChats<T>): T | null {
  return chats.conversations[0] ?? null;
}

/** `t.me/<bot>?start=<code>` — the one-tap link of Uno's assistant bot. */
export function telegramStartLink(bot: string, code: string): string {
  return `https://t.me/${bot.replace(/^@/, "")}?start=${encodeURIComponent(code)}`;
}

// ── What it can use: connectors, browser, keys, skills (track 3) ──────────

/** Reads pages only (Observer) sits between Off and Careful (critics track 3). */
export type BrowserUse = "off" | "read" | "safe" | "full";

/**
 * A connector's level for one assistant — the daemon's `AssistantAppLevel`
 * (localAssistantStore.ts: `read` lets only the tools that change nothing
 * through), checked on every call.
 */
export type AppLevel = "none" | "read" | "write";

/** Every connected app at one level ("All" / "None"), or a level per app ("Pick"). */
export type ConnectorAccess = AppLevel | Readonly<Record<string, AppLevel>>;

/** Saved logins or keys: all, none, or the ticked ones. */
export type Picks = "all" | "none" | ReadonlyArray<string>;

export type PickMode = "all" | "pick" | "none";

export interface AssistantAccess {
  /**
   * The four apps of the Uno account, by provider id. Servers you added
   * yourself (`settings.mcpServers`) reach every chat on the computer and
   * can't be limited per assistant yet — they are not in here.
   */
  readonly connectors: ConnectorAccess;
  readonly browser: BrowserUse;
  /** Saved logins (vault entries with a site) it may sign in with. */
  readonly logins: Picks;
  /** Keys and tokens from the vault it may use in commands. */
  readonly secrets: Picks;
  /** The skills that live in its projects' folders. */
  readonly projectSkills: boolean;
  /** Skills of its own (catalog ids). */
  readonly personalSkills: ReadonlyArray<string>;
}

export const FULL_ACCESS: AssistantAccess = {
  connectors: "write",
  browser: "full",
  logins: "all",
  secrets: "all",
  projectSkills: true,
  personalSkills: [],
};

/** A new teammate (decision 16.10): no logins or keys until you tick them. */
export const NEW_TEAMMATE_ACCESS: AssistantAccess = {
  connectors: "write",
  browser: "safe",
  logins: [],
  secrets: [],
  projectSkills: true,
  personalSkills: [],
};

const APP_LEVELS: ReadonlySet<string> = new Set(["none", "read", "write"]);

/** Reads what an older mock saved ("all", a list of ids) as today's shape. */
export function normalizeAccess(raw: AssistantAccess): AssistantAccess {
  const connectors = raw.connectors as unknown;
  let normalized: ConnectorAccess;
  if (connectors === "all") normalized = "write";
  else if (typeof connectors === "string" && APP_LEVELS.has(connectors))
    normalized = connectors as AppLevel;
  else if (Array.isArray(connectors))
    normalized = Object.fromEntries(
      (connectors as string[])
        .filter((id) => !id.startsWith("mcp:"))
        .map((id) => [id, "write" as AppLevel]),
    );
  else if (connectors && typeof connectors === "object")
    normalized = connectors as Record<string, AppLevel>;
  else normalized = "write";
  return { ...raw, connectors: normalized };
}

export function accessOf(profile: Pick<AssistantProfile, "access">): AssistantAccess {
  return profile.access ? normalizeAccess(profile.access) : FULL_ACCESS;
}

/** Uno's default — "Full access to this computer", nothing to read further. */
export function isFullAccess(access: AssistantAccess): boolean {
  return (
    access.connectors === "write" &&
    access.browser === "full" &&
    access.logins === "all" &&
    access.secrets === "all" &&
    access.projectSkills
  );
}

export const BROWSER_USE: ReadonlyArray<{
  readonly id: BrowserUse;
  readonly name: string;
  readonly line: string;
}> = [
  { id: "full", name: "Like you", line: "Opens pages, clicks and fills forms by itself." },
  {
    id: "safe",
    name: "Careful",
    line: "Opens pages and fills forms; asks you before Buy, Send or Delete.",
  },
  { id: "read", name: "Reads", line: "Only opens and reads pages — clicks nothing." },
  { id: "off", name: "Off", line: "Doesn't use the browser." },
];

// ── Connectors: All / Pick / None, and a level per app ────────────────────

export const APP_LEVEL_NAME: Readonly<Record<AppLevel, string>> = {
  none: "No",
  read: "Reads",
  write: "Reads & changes",
};

export function connectorMode(access: ConnectorAccess): PickMode {
  if (access === "none") return "none";
  return typeof access === "string" ? "all" : "pick";
}

export function connectorLevel(access: ConnectorAccess, id: string): AppLevel {
  return typeof access === "string" ? access : (access[id] ?? "none");
}

/** Switching the mode keeps what it can: All → Pick ticks every app at the same level. */
export function setConnectorMode(
  access: ConnectorAccess,
  mode: PickMode,
  appIds: ReadonlyArray<string>,
): ConnectorAccess {
  if (mode === "none") return "none";
  if (mode === "all") return access === "read" ? "read" : "write";
  return Object.fromEntries(appIds.map((id) => [id, connectorLevel(access, id)]));
}

export function setConnectorLevel(
  access: ConnectorAccess,
  id: string,
  level: AppLevel,
  appIds: ReadonlyArray<string>,
): ConnectorAccess {
  const base = typeof access === "string" ? setConnectorMode(access, "pick", appIds) : access;
  return { ...(base as Record<string, AppLevel>), [id]: level };
}

/** "GitHub — reads and changes · Google Drive — reads only" / "Every connected app — reads only". */
export function connectorsLine(
  access: ConnectorAccess,
  apps: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): string {
  if (apps.length === 0) return "Nothing connected yet.";
  if (access === "none") return "No apps.";
  if (access === "write") return `Every connected app — reads and changes (${apps.length}).`;
  if (access === "read") return `Every connected app — reads only (${apps.length}).`;
  const parts = apps
    .filter((app) => connectorLevel(access, app.id) !== "none")
    .map(
      (app) =>
        `${app.name} — ${connectorLevel(access, app.id) === "write" ? "reads and changes" : "reads only"}`,
    );
  return parts.length === 0 ? "No apps." : `${parts.join(" · ")}.`;
}

// ── Logins and keys: All / Pick / None ────────────────────────────────────

export function picksMode(picks: Picks): PickMode {
  return picks === "all" ? "all" : picks === "none" ? "none" : "pick";
}

/** Switching to Pick starts from what it has now ("all" → everything ticked). */
export function setPicksMode(picks: Picks, mode: PickMode, allIds: ReadonlyArray<string>): Picks {
  if (mode === "all" || mode === "none") return mode;
  if (picks === "all") return allIds;
  return picks === "none" ? [] : picks;
}

/** "all" / "none" / a picked list, read against what exists now. */
export function pickedOf<T extends { readonly id: string }>(
  picked: Picks,
  items: ReadonlyArray<T>,
): ReadonlyArray<T> {
  if (picked === "all") return items;
  if (picked === "none") return [];
  const ids = new Set(picked);
  return items.filter((item) => ids.has(item.id));
}

/** Ticks or unticks one (from "all": everything but this one). */
export function togglePicked(
  picked: Picks,
  id: string,
  allIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const current = picked === "all" ? allIds : picked === "none" ? [] : picked;
  return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
}

/** One plain line for picks: "every saved key (3)", "GitHub, Notion", or the none-words. */
export function pickedLine(
  picked: Picks,
  names: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  words: { readonly all: string; readonly none: string },
): string {
  const items = pickedOf(picked, names);
  if (names.length === 0) return words.none;
  if (picked === "all") return `${words.all} (${names.length})`;
  if (items.length === 0) return words.none;
  const shown = items.slice(0, 3).map((item) => item.name);
  return items.length > 3 ? `${shown.join(", ")} +${items.length - 3}` : shown.join(", ");
}

// ── Presets set the blocks; a hand edit makes it "Custom" ─────────────────

/**
 * What a preset means for the blocks (critics track 3): Observer reads apps
 * and pages only, uses no logins or keys; Helper and Full change things
 * (Helper asks first). Logins and keys a teammate was given stay — those are
 * picked one by one; Uno has them all.
 */
export function presetAccess(
  preset: AssistantPreset,
  current: AssistantAccess,
  isUno: boolean,
): AssistantAccess {
  switch (preset) {
    case "observer":
      return { ...current, connectors: "read", browser: "read", logins: "none", secrets: "none" };
    case "helper":
      return {
        ...current,
        connectors: "write",
        browser: "safe",
        logins: isUno ? "all" : current.logins === "none" ? [] : current.logins,
        secrets: isUno ? "all" : current.secrets === "none" ? [] : current.secrets,
      };
    case "full":
      return {
        ...current,
        connectors: "write",
        browser: "full",
        logins: isUno ? "all" : current.logins === "none" ? [] : current.logins,
        secrets: isUno ? "all" : current.secrets === "none" ? [] : current.secrets,
      };
  }
}

const samePicks = (a: Picks, b: Picks) =>
  typeof a === "string" || typeof b === "string"
    ? a === b
    : a.length === b.length && a.every((id) => b.includes(id));

const sameConnectors = (a: ConnectorAccess, b: ConnectorAccess) =>
  typeof a === "string" || typeof b === "string"
    ? a === b
    : Object.keys({ ...a, ...b }).every((id) => (a[id] ?? "none") === (b[id] ?? "none"));

/** The blocks no longer match the preset — it reads "Custom (based on Helper)". */
export function isCustomAccess(
  preset: AssistantPreset,
  access: AssistantAccess,
  isUno: boolean,
): boolean {
  const expected = presetAccess(preset, access, isUno);
  return !(
    sameConnectors(access.connectors, expected.connectors) &&
    access.browser === expected.browser &&
    samePicks(access.logins, expected.logins) &&
    samePicks(access.secrets, expected.secrets)
  );
}

export function presetLabel(preset: AssistantPreset, custom: boolean): string {
  return custom ? `Custom (based on ${PRESET_NAME[preset]})` : PRESET_NAME[preset];
}

// ── A child never gets more than its parent ───────────────────────────────

const LEVEL_RANK: Readonly<Record<AppLevel, number>> = { none: 0, read: 1, write: 2 };
export const BROWSER_RANK: Readonly<Record<BrowserUse, number>> = {
  off: 0,
  read: 1,
  safe: 2,
  full: 3,
};

const minLevel = (a: AppLevel, b: AppLevel): AppLevel => (LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b);

/** The child's connectors cut to the parent's; `lost` in plain words. */
export function clampConnectors(
  parent: ConnectorAccess,
  child: ConnectorAccess,
  lost: string[],
): ConnectorAccess {
  if (typeof parent === "string" && typeof child === "string") {
    const level = minLevel(parent, child);
    if (level !== child) lost.push(level === "none" ? "every app" : "changes in apps");
    return level;
  }
  const ids = Object.keys({
    ...(typeof parent === "string" ? {} : parent),
    ...(typeof child === "string" ? {} : child),
  });
  const out: Record<string, AppLevel> = {};
  for (const id of ids) {
    const was = connectorLevel(child, id);
    const now = minLevel(was, connectorLevel(parent, id));
    out[id] = now;
    if (now !== was) lost.push(now === "none" ? appName(id) : `changes in ${appName(id)}`);
  }
  if (typeof child === "string" && child !== "none" && typeof parent !== "string")
    lost.push("apps connected later");
  return out;
}

function clampPicks(parent: Picks, child: Picks, word: string, lost: string[]): Picks {
  if (parent === "all") return child;
  if (parent === "none") {
    if (child === "all") lost.push(`every ${word}`);
    else if (child !== "none") for (const id of child) lost.push(`${word} ${shortId(id)}`);
    return "none";
  }
  if (child === "all") {
    lost.push(`${word}s you save later`);
    return parent;
  }
  if (child === "none") return "none";
  for (const id of child) if (!parent.includes(id)) lost.push(`${word} ${shortId(id)}`);
  return child.filter((id) => parent.includes(id));
}

const shortId = (id: string) => id.replace(/^cred-/, "");

/** The four apps of the Uno account, by provider id, for "Scout will lose: …". */
export const APP_NAME: Readonly<Record<string, string>> = {
  github: "GitHub",
  "google-drive": "Google Drive",
  notion: "Notion",
  gmail: "Gmail & Calendar",
};

const appName = (id: string) => APP_NAME[id] ?? id;

/** What a child would get beyond its parent's access (decision 14.10 (3)). */
export function accessBeyondParent(
  parent: AssistantAccess,
  child: AssistantAccess,
): ReadonlyArray<string> {
  const beyond: string[] = [];
  clampConnectors(parent.connectors, child.connectors, beyond);
  if (BROWSER_RANK[child.browser] > BROWSER_RANK[parent.browser]) beyond.push("the browser");
  clampPicks(parent.logins, child.logins, "login", beyond);
  clampPicks(parent.secrets, child.secrets, "key", beyond);
  if (child.projectSkills && !parent.projectSkills) beyond.push("project skills");
  return beyond;
}
