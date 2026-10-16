/**
 * Sidebar D, the line over the chats (Misha 16.10, w0138 point 5): one title
 * that says what the list shows, and the rules for computers in it.
 *
 * Three views of the same live chats:
 * - "projects" — folders with their chats ("Projects");
 * - "list"     — one list, newest first, with a project filter ("All projects ▾");
 * - "inbox"    — by status ("Inbox").
 * Chats outside any project are the "Home folder" pseudo-project, never a
 * separate section.
 *
 * Computers: with one computer in the sidebar they are never mentioned. With
 * more, a project that does not live on this computer carries the chip of the
 * computer(s) it lives on; a project on several computers stays one project and
 * its chats from other computers carry a small chip. "Group by computer" puts
 * computer headers on top with their projects inside; a sleeping one is grey.
 */

export type SidebarDView = "projects" | "list" | "inbox";

export const SIDEBAR_D_VIEW_OPTIONS: ReadonlyArray<{
  readonly id: SidebarDView;
  readonly label: string;
  readonly hint: string;
}> = [
  { id: "projects", label: "Projects", hint: "Folders with their chats" },
  { id: "list", label: "One list", hint: "Newest first, filter by project" },
  { id: "inbox", label: "Inbox", hint: "By status: what needs you first" },
];

/**
 * The view to show: the stored choice, else what the older "Inbox sidebar"
 * switch said (devices from before 0.0.138 keep what they had).
 */
export function resolveSidebarDView(stored: SidebarDView | null, inboxMode: boolean): SidebarDView {
  if (stored !== null) return stored;
  return inboxMode ? "inbox" : "projects";
}

/** The pseudo-project of chats outside any project folder. */
export const HOME_FOLDER_GROUP_KEY = "home-folder";
export const HOME_FOLDER_GROUP_NAME = "Home folder";

/** The title over the list: says what is shown. */
export function sidebarDViewTitle(view: SidebarDView, filterName: string | null): string {
  switch (view) {
    case "projects":
      return "Projects";
    case "list":
      return filterName ?? "All projects";
    case "inbox":
      return "Inbox";
  }
}

/** "Group by computer" only means something with several computers, and not by status. */
export function canGroupByComputer(view: SidebarDView, multiComputer: boolean): boolean {
  return multiComputer && view !== "inbox";
}

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
 * - in a project row (`projectComputers`): only when the project spans
 *   several computers and the chat is not on this one (a project on one other
 *   computer already says so on its row);
 * - in one list / inbox (`projectComputers` null): when not on this computer.
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
}

export interface SidebarDComputerSection<T> {
  readonly computer: SidebarDComputer;
  readonly isThis: boolean;
  /** Grey: asleep or unreachable, nothing to open right now. */
  readonly dimmed: boolean;
  readonly chats: ReadonlyArray<T>;
}

/**
 * "Group by computer": this computer first, then the others in the given
 * order, the ones asleep or unreachable last. Every computer keeps its header,
 * chats or not; chats on a computer the list doesn't know go nowhere.
 */
export function groupChatsByComputer<T>(input: {
  readonly chats: ReadonlyArray<T>;
  readonly computerOf: (chat: T) => string;
  readonly computers: ReadonlyArray<SidebarDComputer>;
  readonly thisComputer: string | null;
}): ReadonlyArray<SidebarDComputerSection<T>> {
  const byEnvironment = new Map<string, T[]>();
  for (const chat of input.chats) {
    const environmentId = input.computerOf(chat);
    const chats = byEnvironment.get(environmentId);
    if (chats) chats.push(chat);
    else byEnvironment.set(environmentId, [chat]);
  }
  const rank = (computer: SidebarDComputer) =>
    computer.environmentId !== null && computer.environmentId === input.thisComputer
      ? 0
      : computer.status === "online" || computer.status === "unknown"
        ? 1
        : 2;
  const seen = new Set<string>();
  return input.computers
    .filter((computer) => {
      if (seen.has(computer.key)) return false;
      seen.add(computer.key);
      return true;
    })
    .map((computer, index) => ({ computer, index }))
    .toSorted((a, b) => rank(a.computer) - rank(b.computer) || a.index - b.index)
    .map(({ computer }) => ({
      computer,
      isThis: computer.environmentId !== null && computer.environmentId === input.thisComputer,
      dimmed: computer.status === "sleeping" || computer.status === "offline",
      chats:
        computer.environmentId === null ? [] : (byEnvironment.get(computer.environmentId) ?? []),
    }));
}

/**
 * The list view's filter: the chats of one project (its logical key, or the
 * Home folder), or all of them. A filter whose project is gone shows all.
 */
export function filterChatsByProject<T>(input: {
  readonly chats: ReadonlyArray<T>;
  readonly filterKey: string | null;
  readonly knownKeys: ReadonlySet<string>;
  readonly groupKeyOf: (chat: T) => string;
}): ReadonlyArray<T> {
  if (input.filterKey === null || !input.knownKeys.has(input.filterKey)) return input.chats;
  return input.chats.filter((chat) => input.groupKeyOf(chat) === input.filterKey);
}
