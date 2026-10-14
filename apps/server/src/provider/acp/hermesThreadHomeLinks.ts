/**
 * Puts the shared parts of Hermes into a chat's own HERMES_HOME as symlinks
 * ({@link hermesThreadHomeLinks} says which and why). Idempotent; never
 * deletes anything of the chat's:
 *
 * - a link that is already right stays;
 * - a link to somewhere else is re-pointed;
 * - a real file where a link belongs is moved aside (`<name>.own-<time>`),
 *   because a chat-local `auth.json` would hold a second, diverging ChatGPT
 *   token;
 * - a real directory stays as it is (a chat that ran on Hermes ≥ 0.21 before
 *   the link existed has its own runtime — it keeps working).
 *
 * @module provider/acp/hermesThreadHomeLinks
 */
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type { HermesThreadHomeLink } from "./HermesAcpSupport.ts";

export type HermesThreadHomeLinkOutcome =
  | "linked"
  | "kept"
  | "relinked"
  | "moved-aside"
  | "own-dir";

async function lstatOrNull(path: string) {
  try {
    return await fs.lstat(path);
  } catch {
    return null;
  }
}

async function linkOne(
  link: HermesThreadHomeLink,
  now: () => Date,
): Promise<HermesThreadHomeLinkOutcome> {
  if (link.directory) await fs.mkdir(link.target, { recursive: true });
  else await fs.mkdir(nodePath.dirname(link.target), { recursive: true });
  await fs.mkdir(nodePath.dirname(link.path), { recursive: true });

  const existing = await lstatOrNull(link.path);
  let outcome: HermesThreadHomeLinkOutcome = "linked";
  if (existing?.isSymbolicLink()) {
    if ((await fs.readlink(link.path)) === link.target) return "kept";
    await fs.unlink(link.path);
    outcome = "relinked";
  } else if (existing?.isDirectory()) {
    return "own-dir";
  } else if (existing !== null) {
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    await fs.rename(link.path, `${link.path}.own-${stamp}`);
    outcome = "moved-aside";
  }
  await fs.symlink(link.target, link.path, link.directory ? "dir" : "file");
  return outcome;
}

export async function linkThreadHome(
  links: ReadonlyArray<HermesThreadHomeLink>,
  now: () => Date = () => new Date(),
): Promise<ReadonlyArray<HermesThreadHomeLinkOutcome>> {
  const outcomes: HermesThreadHomeLinkOutcome[] = [];
  for (const link of links) outcomes.push(await linkOne(link, now));
  return outcomes;
}
