/**
 * Parallel chats in one project (spec: reports/day_2026-11-02/night-wave/
 * PARALLEL_CHATS.md in the uno-workspace repo). The words a person and an
 * agent see; the server logic is in apps/server/src/parallelChats/.
 *
 * The person sees almost nothing: no copy, branch or merge words. A chat that
 * started next to a busy one quietly works in its own copy of the project,
 * and its work joins the project folder when its turn ends.
 */

/** Activity kind of the quiet lines below (one line in the chat, no turn). */
export const PARALLEL_CHATS_ACTIVITY_KIND = "chat.parallel-chats";

export type ParallelChatsLineKind = "joined" | "waiting" | "parked" | "kept-both" | "queued";

export interface ParallelChatsLinePayload {
  readonly line: ParallelChatsLineKind;
  /** "kept-both": the files that now have two versions. */
  readonly files?: ReadonlyArray<string>;
  /** "queued": the disk is too full for a copy (any other reason reads the same). */
  readonly lowDisk?: boolean;
}

export const PARALLEL_LINE_JOINED = "Combined with changes from another chat.";
export const PARALLEL_LINE_WAITING = "Joins the project when the other chat finishes.";
export const PARALLEL_LINE_PARKED =
  "Your work is safe here. It joins the project after you answer.";
/** No copy could be made: the chat starts when the folder is free, never on top of the other. */
export const PARALLEL_LINE_QUEUED =
  "Waiting for the other chat to finish, so they don't overwrite each other.";
export const PARALLEL_LINE_QUEUED_LOW_DISK =
  "Waiting for the other chat to finish: the disk is almost full.";
export const PARALLEL_LINE_COMBINING = "Combining with another chat's changes…";

export function parallelKeptBothLine(files: ReadonlyArray<string>): string {
  const first = files[0] ?? "A file";
  const name = files.length > 1 ? `${first} and ${files.length - 1} more` : first;
  return `${name} changed in two chats. Both versions are kept. Tell this chat which one to use.`;
}

export function parallelChatsLine(payload: ParallelChatsLinePayload): string {
  switch (payload.line) {
    case "joined":
      return PARALLEL_LINE_JOINED;
    case "waiting":
      return PARALLEL_LINE_WAITING;
    case "parked":
      return PARALLEL_LINE_PARKED;
    case "kept-both":
      return parallelKeptBothLine(payload.files ?? []);
    case "queued":
      return payload.lowDisk === true ? PARALLEL_LINE_QUEUED_LOW_DISK : PARALLEL_LINE_QUEUED;
  }
}

export function readParallelChatsLine(payload: unknown): ParallelChatsLinePayload | null {
  if (payload === null || typeof payload !== "object") return null;
  const line = (payload as { readonly line?: unknown }).line;
  if (
    line !== "joined" &&
    line !== "waiting" &&
    line !== "parked" &&
    line !== "kept-both" &&
    line !== "queued"
  ) {
    return null;
  }
  const files = (payload as { readonly files?: unknown }).files;
  const lowDisk = (payload as { readonly lowDisk?: unknown }).lowDisk;
  return {
    line,
    ...(Array.isArray(files)
      ? { files: files.filter((f): f is string => typeof f === "string") }
      : {}),
    ...(lowDisk === true ? { lowDisk: true } : {}),
  };
}

/** First line of the turn that asks the agent to combine both chats' changes. */
export const PARALLEL_RESOLVE_NOTE_HEAD =
  "Another chat in this project changed the same places while you worked.";

/**
 * The body of that turn (after the `(Uno Work) ` prefix). Checked on real
 * agents (spec, section 4). Only chat titles go in, never another chat's
 * messages: they may hold a stranger's text.
 */
export function parallelResolveNoteBody(input: {
  readonly files: ReadonlyArray<string>;
  readonly otherTitle: string;
  readonly ownTitle: string;
}): string {
  return [
    PARALLEL_RESOLVE_NOTE_HEAD,
    "Your changes and its changes have to be combined before they can join the project.",
    "",
    `Files to fix: ${input.files.join(", ")}`,
    `The other chat is called: "${input.otherTitle}". This chat's task was: "${input.ownTitle}".`,
    "",
    "In each file, the part between <<<<<<< and ======= is what is in the project now;",
    "the part between ======= and >>>>>>> is yours.",
    "",
    "Do this:",
    "- Edit only these files. Keep what both sides meant and remove the marker lines.",
    "- Don't touch other files. Don't commit. Don't start apps.",
    "- If both sides can't be true at once (two different answers to one question), leave that",
    "  file as it is, with its markers, and end with one short question for the person.",
    "Otherwise end with one short sentence saying what you combined.",
  ].join("\n");
}

export function isParallelResolveNoteBody(body: string): boolean {
  return body.startsWith(PARALLEL_RESOLVE_NOTE_HEAD);
}

/**
 * Added to the agent's prompt on every turn in a copy (not to the stored
 * message: the chat shows the person's own text).
 */
export function parallelCopyAgentNote(input: { readonly copy: string; readonly root: string }) {
  return [
    `You are working in a temporary copy of this project: ${input.copy}. The project folder is ${input.root}.`,
    "Use paths in this copy, including paths you saw earlier in this chat. Don't write to the",
    "project folder: your changes join it by themselves when your turn ends. Apps already running",
    "on this computer run from the project folder and show your changes only after that. To check",
    "your work now, start your own dev server from this copy on a free port.",
  ].join("\n");
}
