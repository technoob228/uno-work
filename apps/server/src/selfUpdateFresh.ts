/**
 * A new computer installs the latest Uno Work right at creation, before its
 * owner opens it for the first time — the one case where the daemon updates
 * without being asked (Misha, 10.10). Everything else goes through the
 * owner's "Update now" / "This evening" (selfUpdate.ts, selfUpdateLater.ts).
 *
 * Why: a computer is created from an image, and for a few minutes after a
 * release the image is still the previous version. Nobody is there yet, so
 * there is nothing to interrupt and nobody to ask.
 *
 * When: the daemon's first moments on a new computer — a cold first boot
 * (daemon start) or a clone of the image's memory snapshot getting its own
 * identity (cloneIdentity.ts, SIGUSR2). If a newer release is out and nobody
 * has opened this computer yet, the daemon drops the same request file as the
 * Update button at once: no quiet minutes, no reminder check.
 *
 * "New": the computer got its identity (the environment id: written at the
 * first start, rewritten when a clone becomes its own computer) less than
 * NEW_MS ago. A computer that has simply never been opened in Uno Work — a
 * server reached over SSH for months — is not new and is left alone.
 *
 * "Nobody has opened it": no client has ever connected (a marker file, written
 * on the first connection and never removed — the path is closed for good),
 * and there is no chat with a message from a person and no agent turn. A clone
 * of a computer somebody has worked on carries its chats, so it is not "new".
 *
 * No loop: one try per version (kept on disk), and a version that was tried
 * here and put back is never tried again this way. No owner's note is left, so
 * the Security line says "Uno Work on this computer was updated to X (was Y)",
 * not "You updated".
 *
 * Kept free of Effect so tests drive it directly; the loop is in
 * selfUpdateLaterScheduler.ts.
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isNewerVersion, type UpdaterStatus } from "./selfUpdate.ts";
import { rolledBackHere } from "./selfUpdateLater.ts";

/** After a start or a clone the daemon looks this often… */
export const FRESH_UPDATE_RETRY_MS = 15_000;
/** …this many times (the network of a just-resumed clone may need a moment). */
export const FRESH_UPDATE_TRIES = 12;

/** A computer is "new" this long after it got its identity. */
export const FRESH_UPDATE_NEW_MS = 30 * 60_000;

const OPENED_FILE = "opened-once.json";
const ATTEMPT_FILE = "self-update-fresh.json";

async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** A person has connected to this computer at least once. */
export async function wasOpenedOnce(stateDir: string): Promise<boolean> {
  try {
    await stat(join(stateDir, OPENED_FILE));
    return true;
  } catch {
    return false;
  }
}

/** The first connection: from now on only the owner's word updates this computer. */
export async function markOpenedOnce(stateDir: string, now = Date.now()): Promise<void> {
  if (await wasOpenedOnce(stateDir)) return;
  await mkdir(stateDir, { recursive: true });
  await writeJson(join(stateDir, OPENED_FILE), { openedAt: new Date(now).toISOString() });
}

/**
 * The computer got its identity (`environment-id`) a short while ago. No file
 * yet — the very first start, the state is still empty: new.
 */
export async function isNewComputer(environmentIdPath: string, now = Date.now()): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(environmentIdPath);
    return now - mtimeMs < FRESH_UPDATE_NEW_MS;
  } catch {
    return true;
  }
}

/** The version this path has already asked for on this computer, or null. */
export async function readFreshAttempt(stateDir: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(stateDir, ATTEMPT_FILE), "utf8"));
    const version =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["version"]
        : null;
    return typeof version === "string" && version ? version : null;
  } catch {
    return null;
  }
}

export async function noteFreshAttempt(
  stateDir: string,
  version: string,
  now = Date.now(),
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeJson(join(stateDir, ATTEMPT_FILE), { version, at: new Date(now).toISOString() });
}

export type FreshUpdateSkip =
  | "unsupported"
  /** Not just created: an older computer is updated only by its owner's word. */
  | "not-new"
  /** A person has connected here once: only their word updates it now. */
  | "opened"
  /** There is a chat with a person's message or an agent turn: not a new computer. */
  | "has-chats"
  /** The chats could not be looked at yet (the daemon is still starting): look again shortly. */
  | "not-ready"
  | "in-progress"
  /** The console's list could not be read yet: look again shortly. */
  | "no-release"
  | "current"
  | "rolled-back"
  /** This path already asked for this version once. */
  | "attempted";

export type FreshUpdateDecision =
  | { readonly go: true; readonly version: string }
  | { readonly go: false; readonly reason: FreshUpdateSkip };

export interface FreshUpdateInput {
  /** The installer set up self-update here (0.0.113+, a cloud computer). */
  readonly supported: boolean;
  /** The computer got its identity a short while ago (isNewComputer). */
  readonly isNew: boolean;
  /** A client has ever connected (the marker, or a session that connected). */
  readonly openedOnce: boolean;
  /** A message from a person or an agent turn exists; null — could not be checked yet. */
  readonly hasChats: boolean | null;
  readonly currentVersion: string;
  /** The console's latest release, null — not known right now. */
  readonly latestVersion: string | null;
  /** A request is waiting or the updater is running. */
  readonly inProgress: boolean;
  /** The updater's last word (status.json). */
  readonly lastRun: UpdaterStatus | null;
  /** The version this path asked for before (on disk), null — never. */
  readonly attemptedVersion: string | null;
}

const skip = (reason: FreshUpdateSkip): FreshUpdateDecision => ({ go: false, reason });

/** Only "not known yet" is worth another look in a few seconds. */
export function freshUpdateWorthRetry(decision: FreshUpdateDecision): boolean {
  return !decision.go && (decision.reason === "no-release" || decision.reason === "not-ready");
}

export function decideFreshUpdate(input: FreshUpdateInput): FreshUpdateDecision {
  if (!input.supported) return skip("unsupported");
  if (!input.isNew) return skip("not-new");
  if (input.openedOnce) return skip("opened");
  if (input.hasChats === null) return skip("not-ready");
  if (input.hasChats) return skip("has-chats");
  if (input.inProgress) return skip("in-progress");
  const target = input.latestVersion;
  if (!target) return skip("no-release");
  // Compared as numbers; never down or sideways.
  if (!isNewerVersion(target, input.currentVersion)) return skip("current");
  if (rolledBackHere(input.lastRun, target)) return skip("rolled-back");
  if (input.attemptedVersion === target) return skip("attempted");
  return { go: true, version: target };
}
