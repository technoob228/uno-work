/**
 * Which files an assistant reply may push into a chat with
 * `[[send-file: …]]`.
 *
 * The marker comes from model output, and model output can be steered by
 * anyone who writes into the chat or into a page the agent reads. Without a
 * boundary it would upload `~/.ssh/id_ed25519` or a project's `.env` to the
 * chat. So a file is sent only when, after resolving symlinks, it is a
 * regular file inside the thread's workspace, and no path segment is hidden
 * (`.env`, `.ssh/…`, `.git/…`) or looks like a private key.
 *
 * @module manager/connectorOutgoingFiles
 */
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";

const PRIVATE_KEY_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)(_sk)?|.*\.(pem|key|p12|pfx|keystore|jks))$/i;

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
 * Resolve a `[[send-file: …]]` path against the thread's workspace roots.
 * Relative paths are taken from the first root. Never throws.
 */
export async function resolveConnectorOutgoingFile(
  rawPath: string,
  roots: ReadonlyArray<string>,
): Promise<ConnectorOutgoingFile> {
  const refused = {
    ok: false,
    reason: "only files inside this chat's workspace can be sent (hidden files and keys excluded)",
  } as const;
  const usableRoots = roots.filter((root) => root.trim().length > 0);
  if (usableRoots.length === 0) return refused;
  const candidate = nodePath.isAbsolute(rawPath)
    ? rawPath
    : nodePath.resolve(usableRoots[0]!, rawPath);
  let realFile: string;
  try {
    realFile = await fsPromises.realpath(candidate);
  } catch {
    return { ok: false, reason: "file not found" };
  }
  const realRoots: Array<string> = [];
  for (const root of usableRoots) {
    try {
      realRoots.push(await fsPromises.realpath(root));
    } catch {
      // A missing root simply can't contain anything.
    }
  }
  return isSendableConnectorPath(realFile, realRoots) ? { ok: true, path: realFile } : refused;
}
