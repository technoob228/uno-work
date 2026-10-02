/**
 * Skills for assistants come only from the Uno catalog: Hermes' own skills
 * hub (ClawHub, skills.sh, LobeHub, GitHub taps… — `hermes skills install`)
 * is closed in an assistant's HERMES_HOME.
 *
 * Hermes has no config switch for its hub sources (`create_source_router` in
 * `tools/skills_hub.py` always lists them all), so the lock is structural: the
 * hub keeps its state in `<HERMES_HOME>/skills/.hub/` and every install starts
 * with `ensure_hub_dirs()` → `mkdir(.hub, exist_ok=True)`. A regular FILE at
 * that path makes that mkdir fail, so `hermes skills install` (and the
 * `/skills install` slash command) stop before fetching anything, while
 * everything that only READS `.hub/lock.json` treats it as "nothing installed
 * from the hub" (`Path.exists()` is false under a file).
 *
 * This is a guard rail, not a sandbox: an agent with a shell can delete the
 * file or copy files by hand. The hard boundary for assistant computers is
 * the network (the hub hosts blocked at the box) — see the TOOLS.md report.
 *
 * @module assistants/skillHubLock
 */
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

export const SKILL_HUB_LOCK_TEXT =
  "Skills hub installs are disabled for Uno assistants: skills come only from the Uno catalog.\n" +
  "This file intentionally replaces the .hub directory (see Uno Work assistants/skillHubLock.ts).\n";

/** Hosts of Hermes' public skill hubs — for a network-level block. */
export const SKILL_HUB_HOSTS: ReadonlyArray<string> = [
  "clawhub.ai",
  "skills.sh",
  "www.skills.sh",
  "chat-agents.lobehub.com",
  "browse.sh",
];

export type SkillHubLockOutcome = "locked" | "already-locked" | "replaced-directory";

/**
 * Put the lock file at `<hermesHome>/skills/.hub`. Idempotent. A real `.hub`
 * directory (an install happened before the lock) is replaced: it holds only
 * the hub's bookkeeping (lock.json, quarantine, caches), not the skills.
 */
export async function lockHermesSkillHub(hermesHome: string): Promise<SkillHubLockOutcome> {
  const skillsDir = nodePath.join(hermesHome, "skills");
  const hubPath = nodePath.join(skillsDir, ".hub");
  await fs.mkdir(skillsDir, { recursive: true });
  const stat = await fs.lstat(hubPath).catch(() => null);
  if (stat?.isFile()) {
    const current = await fs.readFile(hubPath, "utf8").catch(() => "");
    if (current === SKILL_HUB_LOCK_TEXT) return "already-locked";
  }
  let outcome: SkillHubLockOutcome = "locked";
  if (stat !== null) {
    if (stat.isDirectory()) outcome = "replaced-directory";
    await fs.rm(hubPath, { recursive: true, force: true });
  }
  await fs.writeFile(hubPath, SKILL_HUB_LOCK_TEXT, { mode: 0o444 });
  return outcome;
}
