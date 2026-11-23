/**
 * The sidebar's New chat picker (Misha 20.11, T53): which computer and which
 * folder a new chat starts in, decided before the chat opens — one click or
 * Enter on what was used last. Pure parts: the remembered choice, the default,
 * the list and the keys.
 */

/** Where a new chat starts. `cwd` null — the computer's home folder. */
export interface NewChatTarget {
  readonly environmentId: string;
  readonly cwd: string | null;
}

export interface NewChatComputer {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
}

export interface NewChatFolder {
  /** "home" for the home folder, else the project's key. */
  readonly key: string;
  readonly name: string;
  /** null — the home folder. */
  readonly cwd: string | null;
}

export const LAST_NEW_CHAT_STORAGE_KEY = "uno.newChatPicker.last.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readLastNewChatTarget(from: StorageLike | null = storage()): NewChatTarget | null {
  try {
    const raw = from?.getItem(LAST_NEW_CHAT_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<NewChatTarget>;
    if (typeof value.environmentId !== "string" || value.environmentId.length === 0) return null;
    return {
      environmentId: value.environmentId,
      cwd: typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd : null,
    };
  } catch {
    return null;
  }
}

export function writeLastNewChatTarget(
  target: NewChatTarget,
  to: StorageLike | null = storage(),
): void {
  try {
    to?.setItem(LAST_NEW_CHAT_STORAGE_KEY, JSON.stringify(target));
  } catch {
    // Private mode / full storage: the picker falls back to the last chat.
  }
}

const normalize = (path: string) => path.replace(/\/+$/, "");

/** Same folder, whatever the trailing slashes. */
export function sameFolder(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return normalize(a) === normalize(b);
}

/**
 * The computer the picker opens on: the one used last if it is connected now,
 * else the one of the chat the person wrote in last, else the one on screen,
 * else the first connected one.
 */
export function defaultNewChatComputer(input: {
  readonly computers: ReadonlyArray<NewChatComputer>;
  readonly last: NewChatTarget | null;
  readonly lastChat: NewChatTarget | null;
  readonly activeEnvironmentId: string | null;
}): string | null {
  const connected = (id: string | null | undefined) =>
    id ? input.computers.some((computer) => computer.id === id && computer.connected) : false;
  for (const id of [
    input.last?.environmentId,
    input.lastChat?.environmentId,
    input.activeEnvironmentId,
  ]) {
    if (connected(id)) return id!;
  }
  return input.computers.find((computer) => computer.connected)?.id ?? null;
}

/**
 * The folder highlighted on `environmentId`: the one used last there, else
 * the one of the last chat there, else the home folder (always first).
 */
export function defaultNewChatFolderIndex(input: {
  readonly environmentId: string | null;
  readonly folders: ReadonlyArray<NewChatFolder>;
  readonly last: NewChatTarget | null;
  readonly lastChat: NewChatTarget | null;
}): number {
  for (const target of [input.last, input.lastChat]) {
    if (!target || target.environmentId !== input.environmentId) continue;
    const index = input.folders.findIndex((folder) => sameFolder(folder.cwd, target.cwd));
    if (index >= 0) return index;
  }
  return 0;
}

/** The folders that match what was typed (the home folder too, by its name). */
export function filterNewChatFolders<Folder extends NewChatFolder>(
  folders: ReadonlyArray<Folder>,
  query: string,
): ReadonlyArray<Folder> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return folders;
  return folders.filter(
    (folder) =>
      folder.name.toLowerCase().includes(needle) ||
      (folder.cwd !== null && folder.cwd.toLowerCase().includes(needle)),
  );
}

/** ↑/↓ over the list, wrapping round. */
export function moveHighlight(index: number, count: number, step: 1 | -1): number {
  if (count <= 0) return 0;
  return (((index + step) % count) + count) % count;
}

/** Tab / ⇧Tab: the next connected computer, wrapping round; the same one if alone. */
export function nextConnectedComputer(
  computers: ReadonlyArray<NewChatComputer>,
  currentId: string | null,
  step: 1 | -1,
): string | null {
  const connected = computers.filter((computer) => computer.connected);
  if (connected.length === 0) return null;
  const at = connected.findIndex((computer) => computer.id === currentId);
  if (at < 0) return connected[0]!.id;
  return connected[moveHighlight(at, connected.length, step)]!.id;
}
