/**
 * Sidebar D, the line over the chats (Misha 16.10, w0138 point 5 and its
 * follow-up): one title that says what the list shows, a menu behind it that
 * groups and filters, and the rules for computers in the list.
 *
 * Grouping (ported from icp3/sidebar-v2, proto/chatGrouping.ts): any of
 * Project, Status, Computer in the order the person picks — none is one list,
 * newest first. Filters: some projects, some computers (null = all). Chats
 * outside any project folder are the "Home folder" pseudo-project.
 *
 * Computers: with one computer in view they are never mentioned. With more, a
 * project that does not live on this computer carries its computer's chip; a
 * project on several computers stays one project and its chats from other
 * computers carry a small chip; a sleeping computer is grey.
 */

// ── Group levels ─────────────────────────────────────────────────────────

export type SidebarGroupLevel = "computer" | "project" | "status";

export const SIDEBAR_GROUP_LEVELS: ReadonlyArray<{
  readonly id: SidebarGroupLevel;
  readonly name: string;
}> = [
  { id: "project", name: "Project" },
  { id: "status", name: "Status" },
  { id: "computer", name: "Computer" },
];

const LEVEL_NAME: Readonly<Record<SidebarGroupLevel, string>> = {
  project: "Project",
  status: "Status",
  computer: "Computer",
};

/**
 * The levels to group by: the stored choice, else what the older "Inbox
 * sidebar" switch said (devices from before 0.0.138 keep what they had).
 */
export function resolveGroupLevels(
  stored: ReadonlyArray<SidebarGroupLevel> | null,
  inboxMode: boolean,
): ReadonlyArray<SidebarGroupLevel> {
  if (stored !== null) return stored;
  return inboxMode ? ["status"] : ["project"];
}

/** The levels that apply: each once, in order; Computer only with 2+ computers in view. */
export function effectiveLevels(
  levels: ReadonlyArray<SidebarGroupLevel>,
  computersInView: number,
): SidebarGroupLevel[] {
  const out: SidebarGroupLevel[] = [];
  for (const level of levels) {
    if (out.includes(level) || !(level in LEVEL_NAME)) continue;
    if (level === "computer" && computersInView < 2) continue;
    out.push(level);
  }
  return out;
}

/** Turn a level on (it goes last) or off. */
export function toggleLevel(
  levels: ReadonlyArray<SidebarGroupLevel>,
  level: SidebarGroupLevel,
): SidebarGroupLevel[] {
  return levels.includes(level) ? levels.filter((item) => item !== level) : [...levels, level];
}

/** Move a level one step up (-1) or down (+1); out of range = no change. */
export function moveLevel(
  levels: ReadonlyArray<SidebarGroupLevel>,
  level: SidebarGroupLevel,
  by: -1 | 1,
): SidebarGroupLevel[] {
  const from = levels.indexOf(level);
  const to = from + by;
  if (from === -1 || to < 0 || to >= levels.length) return [...levels];
  const next = [...levels];
  next[from] = next[to]!;
  next[to] = level;
  return next;
}

/** "Computer → Project", or "One list, newest first" with no level. */
export function levelsLabel(levels: ReadonlyArray<SidebarGroupLevel>): string {
  if (levels.length === 0) return "One list, newest first";
  return levels.map((level) => LEVEL_NAME[level]).join(" → ");
}

/**
 * The three simple views Settings offers (variant B): Projects (folders), One
 * list, Inbox (by status). Computer stays as it is; any other mix is "custom".
 */
export type SidebarDPreset = "projects" | "list" | "inbox";

export const SIDEBAR_D_PRESETS: ReadonlyArray<{
  readonly id: SidebarDPreset;
  readonly label: string;
}> = [
  { id: "projects", label: "Projects" },
  { id: "list", label: "One list" },
  { id: "inbox", label: "Inbox" },
];

export function presetOf(levels: ReadonlyArray<SidebarGroupLevel>): SidebarDPreset | null {
  const rest = levels.filter((level) => level !== "computer");
  if (rest.length === 0) return "list";
  if (rest.length === 1 && rest[0] === "project") return "projects";
  if (rest.length === 1 && rest[0] === "status") return "inbox";
  return null;
}

export function levelsForPreset(preset: SidebarDPreset, byComputer: boolean): SidebarGroupLevel[] {
  const head: SidebarGroupLevel[] = byComputer ? ["computer"] : [];
  switch (preset) {
    case "projects":
      return [...head, "project"];
    case "list":
      return head;
    case "inbox":
      return [...head, "status"];
  }
}

// ── Filters ──────────────────────────────────────────────────────────────

/** The pseudo-project of chats outside any project folder. */
export const HOME_FOLDER_GROUP_KEY = "home-folder";
export const HOME_FOLDER_GROUP_NAME = "Home folder";

/**
 * A multi-pick filter (projects or computers): null = all. Toggling one when
 * all are shown keeps only it ("show me landing"); toggling the last one off,
 * or ending with every one on, goes back to all.
 */
export function toggleFilter(
  picked: ReadonlyArray<string> | null,
  id: string,
  all: ReadonlyArray<string>,
): string[] | null {
  const current = picked === null ? [] : picked.filter((item) => all.includes(item));
  const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
  if (next.length === 0 || all.every((item) => next.includes(item))) return null;
  return all.filter((item) => next.includes(item));
}

/** The picks that still exist; none left = all. */
export function livePicks(
  picked: ReadonlyArray<string> | null,
  all: ReadonlyArray<string>,
): ReadonlyArray<string> | null {
  if (picked === null) return null;
  const live = picked.filter((item) => all.includes(item));
  return live.length === 0 ? null : live;
}

export function passes(picked: ReadonlyArray<string> | null, id: string): boolean {
  return picked === null || picked.includes(id);
}

// ── What the title says ──────────────────────────────────────────────────

/**
 * The title over the list says which chats it shows (critics 16.10: it is a
 * button, and "All projects" lied — it lists chats): "All chats", "Chats ·
 * landing", "Chats · 2 projects", "Chats · landing · MacBook". The grouping
 * is seen in the list itself; the filter is said here only (no second chip).
 */
export function sidebarDTitle(input: {
  /** Names of the picked projects; null = all. */
  readonly projectNames: ReadonlyArray<string> | null;
  /** Names of the picked computers; null = all. */
  readonly computerNames: ReadonlyArray<string> | null;
  /** The chats assistants started are hidden (28.10). */
  readonly assistantChatsHidden?: boolean;
}): string {
  const parts: string[] = [];
  const { projectNames, computerNames } = input;
  if (projectNames !== null) {
    parts.push(projectNames.length === 1 ? projectNames[0]! : `${projectNames.length} projects`);
  }
  if (computerNames !== null) {
    parts.push(
      computerNames.length === 1 ? computerNames[0]! : `${computerNames.length} computers`,
    );
  }
  if (input.assistantChatsHidden) {
    return parts.length === 0 ? "Your chats" : `Your chats · ${parts.join(" · ")}`;
  }
  return parts.length === 0 ? "All chats" : `Chats · ${parts.join(" · ")}`;
}

/**
 * The four ready ways the title menu offers (critics 16.10); any other order
 * of levels is the person's own ("Customize…", Misha's Group by with order).
 */
export type SidebarDHeaderPreset = "list" | "project" | "status" | "computer";

export const SIDEBAR_D_HEADER_PRESETS: ReadonlyArray<{
  readonly id: SidebarDHeaderPreset;
  readonly label: string;
  readonly levels: ReadonlyArray<SidebarGroupLevel>;
}> = [
  { id: "list", label: "One list", levels: [] },
  { id: "project", label: "By project", levels: ["project"] },
  { id: "status", label: "By status", levels: ["status"] },
  { id: "computer", label: "By computer", levels: ["computer", "project"] },
];

export function headerPresetOf(
  levels: ReadonlyArray<SidebarGroupLevel>,
): SidebarDHeaderPreset | null {
  return (
    SIDEBAR_D_HEADER_PRESETS.find(
      (preset) =>
        preset.levels.length === levels.length &&
        preset.levels.every((level, index) => levels[index] === level),
    )?.id ?? null
  );
}

/**
 * What a chat row still has to say about its place (Misha 16.10: "в режиме
 * без сортинга надо показывать плашку… и в инбоксе"): the project when the
 * list is not grouped by project, the computer when several are in view and
 * the list is not grouped by computer.
 */
export function placeShown(
  levels: ReadonlyArray<SidebarGroupLevel>,
  multiComputer: boolean,
): { readonly project: boolean; readonly computer: boolean } {
  return {
    project: !levels.includes("project"),
    computer: multiComputer && !levels.includes("computer"),
  };
}

// ── Computers ────────────────────────────────────────────────────────────

/**
 * Computers named on a project row: none with one computer, none when the
 * project lives on this computer; otherwise every computer it lives on.
 */
export function projectRowComputers(input: {
  readonly computers: ReadonlyArray<string>;
  readonly thisComputer: string | null;
  readonly multiComputer: boolean;
}): ReadonlyArray<string> {
  if (!input.multiComputer) return [];
  if (input.thisComputer !== null && input.computers.includes(input.thisComputer)) return [];
  return [...new Set(input.computers)];
}

/**
 * Whether a chat row carries its computer's chip.
 * - one computer, or rows already under a computer header: never;
 * - right under a project row (`projectComputers`): only when the project
 *   spans several computers and the chat is not on this one (a project on one
 *   other computer already says so on its row);
 * - otherwise (`projectComputers` null): when not on this computer.
 */
export function chatRowShowsComputer(input: {
  readonly chatComputer: string;
  readonly thisComputer: string | null;
  readonly multiComputer: boolean;
  readonly underComputerHeader: boolean;
  readonly projectComputers: ReadonlyArray<string> | null;
}): boolean {
  if (!input.multiComputer || input.underComputerHeader) return false;
  if (input.chatComputer === input.thisComputer) return false;
  if (input.projectComputers === null) return true;
  return new Set(input.projectComputers).size > 1;
}

export type SidebarDComputerStatus = "online" | "offline" | "sleeping" | "unknown";

export interface SidebarDComputer {
  /** Null for a computer on the account nothing has connected to yet (asleep). */
  readonly environmentId: string | null;
  readonly key: string;
  readonly label: string;
  readonly status: SidebarDComputerStatus;
  /** A cloud computer (an Uno box) or one of the person's own (a laptop). */
  readonly cloud?: boolean;
}

export function isComputerDimmed(computer: SidebarDComputer): boolean {
  return computer.status === "sleeping" || computer.status === "offline";
}

/** This computer first, then the others as given, the ones asleep or unreachable last. */
export function orderComputers(
  computers: ReadonlyArray<SidebarDComputer>,
  thisComputer: string | null,
): SidebarDComputer[] {
  const rank = (computer: SidebarDComputer) =>
    computer.environmentId !== null && computer.environmentId === thisComputer
      ? 0
      : isComputerDimmed(computer)
        ? 2
        : 1;
  const seen = new Set<string>();
  return computers
    .filter((computer) => {
      if (seen.has(computer.key)) return false;
      seen.add(computer.key);
      return true;
    })
    .map((computer, index) => ({ computer, index }))
    .toSorted((a, b) => rank(a.computer) - rank(b.computer) || a.index - b.index)
    .map(({ computer }) => computer);
}

// ── The tree ─────────────────────────────────────────────────────────────

export interface SidebarDGroupNode<T> {
  readonly level: SidebarGroupLevel;
  /** Status id, computer key or project group key. */
  readonly id: string;
  /** Unique across the tree — the fold key ("computer:mac/project:landing"). */
  readonly path: string;
  readonly depth: number;
  /** Every chat under this group, in the incoming order (newest first). */
  readonly chats: ReadonlyArray<T>;
  /** Null on the last level: the chats are listed under it. */
  readonly children: ReadonlyArray<SidebarDGroupNode<T>> | null;
  /** The level values of this group and its parents. */
  readonly trail: Readonly<Partial<Record<SidebarGroupLevel, string>>>;
}

type Trail = Readonly<Partial<Record<SidebarGroupLevel, string>>>;

function orderedKeys<T>(
  chats: ReadonlyArray<T>,
  keyOf: (chat: T) => string,
  preferred: ReadonlyArray<string> | undefined,
  seeded: ReadonlyArray<string>,
): string[] {
  const present: string[] = [];
  for (const chat of chats) {
    const key = keyOf(chat);
    if (!present.includes(key)) present.push(key);
  }
  for (const key of seeded) if (!present.includes(key)) present.push(key);
  if (!preferred) return present;
  const rank = (key: string) => {
    const index = preferred.indexOf(key);
    return index === -1 ? preferred.length + present.indexOf(key) : index;
  };
  return present.toSorted((a, b) => rank(a) - rank(b));
}

/**
 * Group chats by the levels in order; null with no level (one flat list).
 * Groups keep the order of their newest chat unless `orderOf` fixes it;
 * `seedOf` adds groups without chats (a project with nothing live, a computer
 * asleep) — never under a status ("Working › landing (empty)" means nothing).
 */
export function groupSidebarChats<T>(input: {
  readonly chats: ReadonlyArray<T>;
  readonly levels: ReadonlyArray<SidebarGroupLevel>;
  readonly keyOf: Readonly<Record<SidebarGroupLevel, (chat: T) => string>>;
  readonly orderOf?: Readonly<Partial<Record<SidebarGroupLevel, ReadonlyArray<string>>>>;
  readonly seedOf?: Readonly<
    Partial<Record<SidebarGroupLevel, (trail: Trail) => ReadonlyArray<string>>>
  >;
}): ReadonlyArray<SidebarDGroupNode<T>> | null {
  if (input.levels.length === 0) return null;
  const build = (
    chats: ReadonlyArray<T>,
    depth: number,
    parentPath: string,
    trail: Trail,
  ): SidebarDGroupNode<T>[] => {
    const level = input.levels[depth]!;
    const keyOf = input.keyOf[level];
    const seeded = trail.status !== undefined ? [] : (input.seedOf?.[level]?.(trail) ?? []);
    const last = depth === input.levels.length - 1;
    return orderedKeys(chats, keyOf, input.orderOf?.[level], seeded).map((id) => {
      const mine = chats.filter((chat) => keyOf(chat) === id);
      const path = `${parentPath}${parentPath ? "/" : ""}${level}:${id}`;
      const nextTrail = { ...trail, [level]: id };
      return {
        level,
        id,
        path,
        depth,
        chats: mine,
        children: last ? null : build(mine, depth + 1, path, nextTrail),
        trail: nextTrail,
      };
    });
  };
  return build(input.chats, 0, "", {});
}
