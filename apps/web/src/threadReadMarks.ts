/**
 * "Read" on a chat (Misha 11.10): the chat finished, the person saw the
 * answer and has nothing to add right now — it stops asking for "Your turn"
 * but stays in its place in the list (Done would park it on the Done shelf).
 * The next finished turn asks again; "Mark unread" brings the mark back.
 *
 * Kept per browser in localStorage, by chat: the mark is the moment the
 * person pressed Read, and it holds while no turn finished after it.
 */
export const THREAD_READ_MARKS_KEY = "uno-work:chats:read";
/** Marks older than this are dropped on load: their chats aged out long ago. */
export const THREAD_READ_MARK_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export type ThreadReadMarks = Readonly<Record<string, string>>;

export function threadReadMarkKey(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

/** Parse the stored record; junk and marks past the TTL read as none. */
export function parseThreadReadMarks(raw: string | null, nowMs: number): ThreadReadMarks {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const marks: Record<string, string> = {};
    for (const [key, at] of Object.entries(value)) {
      if (typeof at !== "string") continue;
      const atMs = Date.parse(at);
      if (Number.isNaN(atMs) || nowMs - atMs > THREAD_READ_MARK_TTL_MS) continue;
      marks[key] = at;
    }
    return marks;
  } catch {
    return {};
  }
}

/** Read covers the turn when it was pressed at or after the turn finished. */
export function isTurnRead(
  readAt: string | null | undefined,
  turnCompletedAt: string | null | undefined,
): boolean {
  const readAtMs = Date.parse(readAt ?? "");
  const completedAtMs = Date.parse(turnCompletedAt ?? "");
  return !Number.isNaN(readAtMs) && !Number.isNaN(completedAtMs) && readAtMs >= completedAtMs;
}

let cache: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (cache !== null) return cache;
  let raw: string | null = null;
  try {
    raw = typeof window === "undefined" ? null : window.localStorage.getItem(THREAD_READ_MARKS_KEY);
  } catch {
    // Storage is off (private mode): the marks live for this window only.
  }
  cache = { ...parseThreadReadMarks(raw, Date.now()) };
  return cache;
}

export function readThreadReadAt(environmentId: string, threadId: string): string | null {
  return load()[threadReadMarkKey(environmentId, threadId)] ?? null;
}

/** Remember (or with null, forget) the mark for one chat. */
export function writeThreadReadAt(
  environmentId: string,
  threadId: string,
  readAt: string | null,
): void {
  const marks = load();
  const key = threadReadMarkKey(environmentId, threadId);
  if (readAt === null) delete marks[key];
  else marks[key] = readAt;
  try {
    window.localStorage.setItem(THREAD_READ_MARKS_KEY, JSON.stringify(marks));
  } catch {
    // Storage is off or full: the mark still holds until the window closes.
  }
}
