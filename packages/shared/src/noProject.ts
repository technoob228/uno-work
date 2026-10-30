/**
 * "No project": a chat that doesn't belong to anything yet. All such chats of
 * a computer live under one quiet project, each in a folder of its own
 * (`~/chats/2026-10-30-convert-these-pngs-a1b2c3d4`), away from `~/projects`.
 * The folder is made when the chat starts; "Turn into project" makes it a
 * project where it is. Upstream T3 Code's scratch threads, in a folder a person
 * can find in Files.
 */

/** The title of a computer's "No project" project. */
export const NO_PROJECT_TITLE = "No project";

/** Its folder, in the home folder. */
export const NO_PROJECT_FOLDER = "chats";

const withoutTrailingSlash = (path: string): string => path.replace(/\/+$/, "");

export function noProjectRoot(home: string): string {
  return `${withoutTrailingSlash(home)}/${NO_PROJECT_FOLDER}`;
}

export function isNoProjectRoot(folder: string, home: string): boolean {
  return withoutTrailingSlash(folder) === noProjectRoot(home);
}

/** The first words of a message, fit for a folder name: latin letters and digits only. */
export function chatFolderWords(text: string): string {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
}

/** `2026-10-30-convert-these-pngs-a1b2c3d4`; `extra` for a name that was taken. */
export function chatFolderName(input: {
  readonly date: string;
  readonly text: string;
  readonly threadId: string;
  readonly extra?: string;
}): string {
  const id = input.threadId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [input.date, chatFolderWords(input.text), id.slice(-8), input.extra]
    .filter(Boolean)
    .join("-");
}
