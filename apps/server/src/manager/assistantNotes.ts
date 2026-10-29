/**
 * An assistant's own memory files through uno-manager (`notes_read`,
 * `notes_append`, `notes_edit`).
 *
 * The Uno chat has no file tools of its own any more (Hermes' terminal and
 * file toolsets are off for it: HERMES_DISPATCHER_DISABLED_TOOLSETS), yet it
 * keeps NOTES.md and ROUTING.md up to date. These tools reach exactly those
 * files of the caller's own workspace — never a path the model names.
 *
 * @module manager/assistantNotes
 */
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";

/** Files an assistant reads with `notes_read`. */
export const ASSISTANT_NOTES_READABLE = ["NOTES.md", "ROUTING.md", "USER.md", "SOUL.md"] as const;
/** Files it changes itself; USER.md and SOUL.md are the person's (its page). */
export const ASSISTANT_NOTES_WRITABLE = ["NOTES.md", "ROUTING.md"] as const;

export type AssistantNotesReadable = (typeof ASSISTANT_NOTES_READABLE)[number];
export type AssistantNotesWritable = (typeof ASSISTANT_NOTES_WRITABLE)[number];

/** Lines `notes_read` returns by default (the newest part). */
export const NOTES_READ_DEFAULT_LINES = 120;
export const NOTES_READ_MAX_LINES = 600;
/** One append or replacement at most this long. */
export const NOTES_TEXT_MAX_CHARS = 4_000;
/** A file this large is not grown further (the person trims it on the page). */
export const NOTES_FILE_MAX_BYTES = 512 * 1024;

export type NotesResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

const isReadable = (name: unknown): name is AssistantNotesReadable =>
  typeof name === "string" && (ASSISTANT_NOTES_READABLE as ReadonlyArray<string>).includes(name);
const isWritable = (name: unknown): name is AssistantNotesWritable =>
  typeof name === "string" && (ASSISTANT_NOTES_WRITABLE as ReadonlyArray<string>).includes(name);

const asRecord = (args: unknown): Record<string, unknown> =>
  typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};

/**
 * The file's path in the workspace, refusing a symlink (it could point
 * anywhere on the disk). Missing is fine: `exists: false`.
 */
async function ownFile(
  workspaceRoot: string,
  name: string,
): Promise<{ readonly path: string; readonly exists: boolean } | { readonly error: string }> {
  const path = nodePath.join(workspaceRoot, name);
  try {
    const stat = await fsp.lstat(path);
    if (!stat.isFile()) return { error: `${name} is not a plain file in your folder.` };
    return { path, exists: true };
  } catch {
    return { path, exists: false };
  }
}

export async function readAssistantNotes(workspaceRoot: string, args: unknown): Promise<NotesResult> {
  const input = asRecord(args);
  const file = input["file"] ?? "NOTES.md";
  if (!isReadable(file)) {
    return { ok: false, error: `file is one of ${ASSISTANT_NOTES_READABLE.join(", ")}.` };
  }
  const rawLines = input["lines"];
  const lines =
    typeof rawLines === "number" && Number.isFinite(rawLines) && rawLines > 0
      ? Math.min(Math.floor(rawLines), NOTES_READ_MAX_LINES)
      : NOTES_READ_DEFAULT_LINES;
  const target = await ownFile(workspaceRoot, file);
  if ("error" in target) return { ok: false, error: target.error };
  if (!target.exists) return { ok: true, value: { file, text: "", totalLines: 0 } };
  const text = await fsp.readFile(target.path, "utf8");
  const all = text.split("\n");
  // Tables and headings live at the top of ROUTING/USER/SOUL; NOTES grows at the end.
  const fromEnd = file === "NOTES.md";
  const slice = fromEnd ? all.slice(-lines) : all.slice(0, lines);
  return {
    ok: true,
    value: {
      file,
      text: slice.join("\n"),
      totalLines: all.length,
      ...(slice.length < all.length
        ? { truncated: fromEnd ? "older lines left out" : "later lines left out" }
        : {}),
    },
  };
}

const checkText = (raw: unknown, field: string): string | { readonly error: string } => {
  if (typeof raw !== "string" || raw.trim().length === 0) return { error: `${field} is required.` };
  if (raw.length > NOTES_TEXT_MAX_CHARS) {
    return { error: `${field} is at most ${NOTES_TEXT_MAX_CHARS} characters: keep notes short.` };
  }
  return raw;
};

export async function appendAssistantNotes(
  workspaceRoot: string,
  args: unknown,
): Promise<NotesResult> {
  const input = asRecord(args);
  const file = input["file"] ?? "NOTES.md";
  if (!isWritable(file)) {
    return {
      ok: false,
      error: `You can append to ${ASSISTANT_NOTES_WRITABLE.join(" or ")}; USER.md and SOUL.md are the person's (your page).`,
    };
  }
  const text = checkText(input["text"], "text");
  if (typeof text !== "string") return { ok: false, error: text.error };
  const target = await ownFile(workspaceRoot, file);
  if ("error" in target) return { ok: false, error: target.error };
  const before = target.exists ? await fsp.readFile(target.path, "utf8") : "";
  if (Buffer.byteLength(before) > NOTES_FILE_MAX_BYTES) {
    return {
      ok: false,
      error: `${file} is too long to grow; tell the person to trim it on your page.`,
    };
  }
  if (file === "ROUTING.md") {
    const placed = appendToOutcomesLog(before, text);
    if (placed !== null) {
      await fsp.writeFile(target.path, placed, "utf8");
      return { ok: true, value: { file, appended: true, section: "Outcomes log" } };
    }
  }
  const separator = before.length === 0 || before.endsWith("\n") ? "" : "\n";
  await fsp.appendFile(target.path, `${separator}${text.trimEnd()}\n`, "utf8");
  return { ok: true, value: { file, appended: true } };
}

/**
 * ROUTING.md: an appended line belongs to its "## Outcomes log" (the end
 * of the file is "## Declined"); a "- task → …" proposal line to
 * "## Proposals" when the text names it. null: no such section.
 */
export function appendToOutcomesLog(content: string, text: string): string | null {
  const lines = content.split("\n");
  const heading = /^##\s+outcomes/i;
  const at = lines.findIndex((line) => heading.test(line.trim()));
  if (at === -1) return null;
  let end = at + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end] ?? "")) end += 1;
  // Before the blank lines that end the section.
  let insertAt = end;
  while (insertAt > at + 1 && (lines[insertAt - 1] ?? "").trim() === "") insertAt -= 1;
  const added = text.trimEnd().split("\n");
  return [...lines.slice(0, insertAt), ...added, ...lines.slice(insertAt)].join("\n");
}

/** The person's lines in `text`: a note ending in "(you)", a routing row with Source `you`. */
export const personLines = (text: string): ReadonlyArray<string> =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => /\(you\)\.?$/.test(line) || /\|\s*`?you`?\s*\|/.test(line));

export async function editAssistantNotes(workspaceRoot: string, args: unknown): Promise<NotesResult> {
  const input = asRecord(args);
  const file = input["file"];
  if (!isWritable(file)) {
    return {
      ok: false,
      error: `file is ${ASSISTANT_NOTES_WRITABLE.join(" or ")}; USER.md and SOUL.md are the person's (your page).`,
    };
  }
  const find = checkText(input["find"], "find");
  if (typeof find !== "string") return { ok: false, error: find.error };
  const replaceRaw = input["replace"];
  if (typeof replaceRaw !== "string" || replaceRaw.length > NOTES_TEXT_MAX_CHARS) {
    return { ok: false, error: `replace is a string of at most ${NOTES_TEXT_MAX_CHARS} characters.` };
  }
  const dropped = personLines(find).filter((line) => !replaceRaw.includes(line));
  if (dropped.length > 0) {
    return {
      ok: false,
      error: `That would change the person's own line (${dropped[0]!.slice(0, 80)}): lines ending in (you) and routing rows with Source "you" are theirs. Propose the change to them instead.`,
    };
  }
  const target = await ownFile(workspaceRoot, file);
  if ("error" in target) return { ok: false, error: target.error };
  if (!target.exists) return { ok: false, error: `${file} does not exist yet: use notes_append.` };
  const before = await fsp.readFile(target.path, "utf8");
  const first = before.indexOf(find);
  if (first < 0) return { ok: false, error: `That text is not in ${file}: read it first.` };
  if (before.indexOf(find, first + 1) >= 0) {
    return { ok: false, error: `That text is in ${file} more than once: give a longer piece.` };
  }
  await fsp.writeFile(
    target.path,
    before.slice(0, first) + replaceRaw + before.slice(first + find.length),
    "utf8",
  );
  return { ok: true, value: { file, replaced: true } };
}
