/**
 * Sidebar v2 (icp3 09.10, Misha's decision on the heavy-usage variants): the
 * chat list groups by any combination of status, computer and project, in
 * the order the person picks ("project → computer", "status → project",
 * "computer → project → status"; no level = one list, newest first), and
 * shows all computers, one, or the ones picked.
 *
 * Pure: no store, no React — the list (ProtoSidebarList) and the demo feed
 * it accessors, the unit tests feed it plain objects.
 */
import type { DRowMark } from "../components/sidebar/sidebarD.logic";

export type GroupLevel = "status" | "computer" | "project";

export const GROUP_LEVELS: ReadonlyArray<{ readonly id: GroupLevel; readonly name: string }> = [
  { id: "status", name: "Status" },
  { id: "computer", name: "Computer" },
  { id: "project", name: "Project" },
];

/**
 * A chat's status for grouping — the marks the sidebar rows already show
 * (sidebarD.logic `dRowMark`) plus Done: a question or an approval waits
 * (Needs you — the same two the Needs you row counts), finished and not seen
 * yet (Your turn), failed, working, nothing going on (Idle), Done.
 */
export type ChatStatus = "needs-you" | "your-turn" | "failed" | "working" | "idle" | "done";

export const STATUS_ORDER: ReadonlyArray<ChatStatus> = [
  "needs-you",
  "your-turn",
  "failed",
  "working",
  "idle",
  "done",
];

export const STATUS_NAME: Readonly<Record<ChatStatus, string>> = {
  "needs-you": "Needs you",
  "your-turn": "Your turn",
  failed: "Failed",
  working: "Working",
  idle: "Idle",
  done: "Done",
};

export function chatStatusOf(mark: DRowMark, done: boolean): ChatStatus {
  if (done) return "done";
  switch (mark) {
    case "approval":
    case "input":
      return "needs-you";
    case "your-turn":
      return "your-turn";
    case "failed":
      return "failed";
    case "working":
      return "working";
    default:
      return "idle";
  }
}

/** The levels that apply: each once, in order; Computer only with 2+ computers in view. */
export function effectiveLevels(
  levels: ReadonlyArray<GroupLevel>,
  computersInView: number,
): GroupLevel[] {
  const out: GroupLevel[] = [];
  for (const level of levels) {
    if (out.includes(level)) continue;
    if (!GROUP_LEVELS.some((item) => item.id === level)) continue;
    if (level === "computer" && computersInView < 2) continue;
    out.push(level);
  }
  return out;
}

/** "Project → Computer", or "Newest first" with no level. */
export function levelsLabel(levels: ReadonlyArray<GroupLevel>): string {
  if (levels.length === 0) return "Newest first";
  return levels.map((level) => GROUP_LEVELS.find((item) => item.id === level)!.name).join(" → ");
}

/** Turn a level on (it goes last) or off. */
export function toggleLevel(levels: ReadonlyArray<GroupLevel>, level: GroupLevel): GroupLevel[] {
  return levels.includes(level) ? levels.filter((item) => item !== level) : [...levels, level];
}

/** Move a level one step up (-1) or down (+1); out of range = no change. */
export function moveLevel(
  levels: ReadonlyArray<GroupLevel>,
  level: GroupLevel,
  by: -1 | 1,
): GroupLevel[] {
  const from = levels.indexOf(level);
  const to = from + by;
  if (from === -1 || to < 0 || to >= levels.length) return [...levels];
  const next = [...levels];
  next[from] = next[to]!;
  next[to] = level;
  return next;
}

/**
 * The computer filter: null = all; otherwise the ones picked. Toggling the
 * last one off goes back to all (an empty list would hide every chat).
 */
export function toggleComputer(
  picked: ReadonlyArray<string> | null,
  computer: string,
  all: ReadonlyArray<string>,
): string[] | null {
  const current = picked === null ? [...all] : picked.filter((id) => all.includes(id));
  const next = current.includes(computer)
    ? current.filter((id) => id !== computer)
    : [...current, computer];
  if (next.length === 0 || all.every((id) => next.includes(id))) return null;
  return all.filter((id) => next.includes(id));
}

/** Whether a chat on this computer is in view. */
export function computerPasses(picked: ReadonlyArray<string> | null, computer: string): boolean {
  return picked === null || picked.includes(computer);
}

export interface ChatGroupNode<T> {
  readonly level: GroupLevel;
  /** Status id, environment id or logical project key. */
  readonly id: string;
  /** Unique across the tree — the fold key ("project:repo:x/computer:env-1"). */
  readonly path: string;
  readonly depth: number;
  /** Every chat under this group, in the incoming order (newest first). */
  readonly chats: ReadonlyArray<T>;
  /** Null on the last level: the chats are listed under it. */
  readonly children: ReadonlyArray<ChatGroupNode<T>> | null;
  /** The level values of this group and its parents. */
  readonly trail: Readonly<Partial<Record<GroupLevel, string>>>;
}

export interface GroupChatsInput<T> {
  /** Newest activity first; they keep that order inside every group. */
  readonly chats: ReadonlyArray<T>;
  readonly levels: ReadonlyArray<GroupLevel>;
  readonly keyOf: Readonly<Record<GroupLevel, (chat: T) => string>>;
  /**
   * The order of groups on a level. Keys not listed come after, in the order
   * their newest chat comes. Status uses STATUS_ORDER when not given.
   */
  readonly orderOf?: Readonly<Partial<Record<GroupLevel, ReadonlyArray<string>>>>;
  /**
   * Groups to show even without chats (an empty project, a computer with
   * nothing yet), given the groups above. Not under a status: "Working ›
   * brand-kit (empty)" means nothing.
   */
  readonly seedOf?: Readonly<
    Partial<
      Record<
        GroupLevel,
        (trail: Readonly<Partial<Record<GroupLevel, string>>>) => ReadonlyArray<string>
      >
    >
  >;
}

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

/** Group chats by the levels in order; null with no level (one flat list). */
export function groupChats<T>(input: GroupChatsInput<T>): ReadonlyArray<ChatGroupNode<T>> | null {
  if (input.levels.length === 0) return null;
  const build = (
    chats: ReadonlyArray<T>,
    depth: number,
    parentPath: string,
    trail: Readonly<Partial<Record<GroupLevel, string>>>,
  ): ChatGroupNode<T>[] => {
    const level = input.levels[depth]!;
    const keyOf = input.keyOf[level];
    const underStatus = trail.status !== undefined;
    const seeded = underStatus ? [] : (input.seedOf?.[level]?.(trail) ?? []);
    const preferred = input.orderOf?.[level] ?? (level === "status" ? STATUS_ORDER : undefined);
    const last = depth === input.levels.length - 1;
    return orderedKeys(chats, keyOf, preferred, seeded).map((id) => {
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

/** What a chat row still has to say about its place, given the levels above it. */
export function placeShown(
  levels: ReadonlyArray<GroupLevel>,
  options: { readonly multi: boolean },
): { readonly project: boolean; readonly computer: boolean } {
  return {
    project: !levels.includes("project"),
    computer: options.multi && !levels.includes("computer"),
  };
}
