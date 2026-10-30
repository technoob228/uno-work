/**
 * Which files an assistant reply may push into a chat with
 * `[[send-file: …]]` or `send_file`.
 *
 * The request comes from model output, and model output can be steered by
 * anyone who writes into the chat or into a page the agent reads. Without a
 * boundary it would upload `~/.ssh/id_ed25519` or a project's `.env` to the
 * chat. So a file is sent only when, after resolving symlinks, it is a
 * regular file inside one of the chat's roots ({@link sendableRoots}), and no
 * path segment is hidden (`.env`, `.ssh/…`, `.git/…`) or looks like a key.
 *
 * Until 29.10 the roots were the chat's own workspace only, so Uno couldn't
 * send ~/projects/luckyip/docs/… to Telegram. Now: the person's folders
 * (projects, Documents, Uploads, Downloads, Desktop) for an assistant that
 * reaches every project; with "only selected projects", only those.
 *
 * @module manager/connectorOutgoingFiles
 */
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";

const PRIVATE_KEY_NAME =
  /^(id_[a-z0-9_]+|.*\.(pem|key|p12|pfx|keystore|jks|ppk|kdbx|env|der|crt))$|^(credentials|secrets?)(\.[a-z]+)?$/i;

/** Home folders with the person's own files, sendable for an unrestricted assistant. */
export const SENDABLE_HOME_FOLDERS = [
  "projects",
  "Documents",
  "Uploads",
  "Downloads",
  "Desktop",
] as const;

/**
 * The roots a chat may send files from: its own folder; the folders of the
 * chats its assistant started (a chat writes `docs/x.md`, Uno sends it by that
 * very path); then, for the person's own chats and assistants that reach every
 * project, the home's {@link SENDABLE_HOME_FOLDERS} and every project; for
 * "only selected projects", only the folders of those projects.
 */
export function sendableRoots(input: {
  readonly threadRoot: string | null;
  /** The folders of the chats this one started, newest first. */
  readonly childRoots?: ReadonlyArray<string>;
  readonly home: string;
  /** "all", or the project roots the chat's assistant may reach. */
  readonly reach: "all" | ReadonlyArray<string>;
  readonly allProjectRoots: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const roots = new Set<string>();
  if (input.threadRoot !== null && input.threadRoot.trim().length > 0) roots.add(input.threadRoot);
  for (const root of input.childRoots ?? []) roots.add(root);
  if (input.reach === "all") {
    for (const folder of SENDABLE_HOME_FOLDERS) roots.add(nodePath.join(input.home, folder));
    for (const root of input.allProjectRoots) roots.add(root);
  } else {
    for (const root of input.reach) roots.add(root);
  }
  // The home itself is never a root (it holds .ssh, .credentials…).
  roots.delete(input.home);
  return [...roots];
}

/** Pure check on already-resolved absolute paths. */
export function isSendableConnectorPath(
  realFilePath: string,
  realRoots: ReadonlyArray<string>,
): boolean {
  const insideRoot = realRoots.some((root) => {
    const relative = nodePath.relative(root, realFilePath);
    return (
      relative.length > 0 &&
      !relative.startsWith("..") &&
      !nodePath.isAbsolute(relative) &&
      relative
        .split(nodePath.sep)
        .every((segment) => segment.length > 0 && !segment.startsWith("."))
    );
  });
  if (!insideRoot) return false;
  return !PRIVATE_KEY_NAME.test(nodePath.basename(realFilePath));
}

export type ConnectorOutgoingFile =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve a `[[send-file: …]]` path against the thread's workspace roots. A
 * relative path is tried from each root in turn: the first one holding a file
 * this chat may send wins. Never throws.
 */
export async function resolveConnectorOutgoingFile(
  rawPath: string,
  roots: ReadonlyArray<string>,
  /** Expands a leading `~/`. */
  home?: string,
): Promise<ConnectorOutgoingFile> {
  const refused = {
    ok: false,
    reason:
      "only files of this chat's folder and the projects and folders it may reach (projects, Documents, Uploads, Downloads, Desktop) can be sent; hidden files and keys never",
  } as const;
  const usableRoots = roots.filter((root) => root.trim().length > 0);
  if (usableRoots.length === 0) return refused;
  const expanded =
    home !== undefined && (rawPath === "~" || rawPath.startsWith("~/"))
      ? nodePath.join(home, rawPath.slice(1))
      : rawPath;
  const realRoots: Array<string> = [];
  for (const root of usableRoots) {
    try {
      realRoots.push(await fsPromises.realpath(root));
    } catch {
      // A missing root simply can't contain anything.
    }
  }
  const candidates = nodePath.isAbsolute(expanded)
    ? [expanded]
    : usableRoots.map((root) => nodePath.resolve(root, expanded));
  let failure: ConnectorOutgoingFile = { ok: false, reason: "file not found" };
  for (const candidate of candidates) {
    try {
      const realFile = await fsPromises.realpath(candidate);
      if (!(await fsPromises.stat(realFile)).isFile()) {
        failure = { ok: false, reason: "not a file" };
      } else if (isSendableConnectorPath(realFile, realRoots)) {
        return { ok: true, path: realFile };
      } else {
        failure = refused;
      }
    } catch {
      // Not in this root: the next one may have it.
    }
  }
  return failure;
}
