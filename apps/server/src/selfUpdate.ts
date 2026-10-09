import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { compareCliVersions } from "@t3tools/contracts";

/**
 * Uno Work updates itself on a cloud computer when its owner presses "Update".
 *
 * The daemon runs unprivileged (NoNewPrivileges, no sudo) and the app directory
 * belongs to root, so the daemon cannot — and must not be able to — replace its
 * own code. It only drops a request file into a directory that is root's
 * (the daemon's group may create files there, nothing else). install.sh sets
 * up `uno-work-update.path`: systemd sees the file and starts the root oneshot
 * `uno-work-update` (deploy/install.sh writes it), which
 *
 *   1. reads the release list `SHA256SUMS` from the console over HTTPS,
 *   2. downloads the versioned bundle and checks its sha256 against that list,
 *   3. installs it with the bundle's own install.sh, restarts the daemon,
 *   4. puts the previous version back when the new one is not healthy in time,
 *
 * and writes its progress to status.json (root's directory; the daemon only
 * reads). Nothing the daemon — or an agent running under the same uid — writes
 * is used as input: no URL, no version, no command. The worst a stray request
 * can do is install the release the console already serves.
 *
 * Who may ask: only an owner session of this computer (see http.ts), and the
 * daemon itself while nobody is working on it and the owner left "Update
 * automatically" on (autoUpdate.ts). There is deliberately no agent tool for it.
 *
 * Paths come from the drop-in `uno-work.service.d/update.conf`. Without them
 * (desktop, dev, machines installed before 0.0.113) self-update is "not
 * supported" and the app shows nothing.
 */

export const SELF_UPDATE_REQUEST_ENV = "UNO_WORK_UPDATE_REQUEST";
export const SELF_UPDATE_STATUS_ENV = "UNO_WORK_UPDATE_STATUS";
export const SELF_UPDATE_BASE_URL_ENV = "UNO_WORK_UPDATE_BASE_URL";

/** Where releases live: the console. The root updater has its own copy of this. */
export const SELF_UPDATE_DEFAULT_BASE_URL = "https://console.uno.place/cli/work";
export const SELF_UPDATE_LATEST_TARBALL = "uno-work-server-latest.tar.gz";
/**
 * The release machines may install by themselves, while idle (autoUpdate.ts).
 * release-work.sh moves it a day after `latest` (`release-work.sh auto <v>`).
 * Only a line in SHA256SUMS — no file of its own. Absent: no automatic updates.
 */
export const SELF_UPDATE_AUTO_TARBALL = "uno-work-server-auto.tar.gz";

/** How long one answer of the console about "latest" is good for. */
const LATEST_TTL_MS = 30 * 60_000;
/** After a failed check, ask again sooner. */
const LATEST_RETRY_MS = 5 * 60_000;
const LATEST_FETCH_TIMEOUT_MS = 15_000;
/** SHA256SUMS is a few KB; refuse anything that is clearly not it. */
const LATEST_MAX_BYTES = 512 * 1024;
/** The request is there but the updater never took it: the .path unit is off. */
const REQUEST_NOT_PICKED_MS = 2 * 60_000;
/** The updater's own limit is 30 min (TimeoutStartSec). */
const STALE_UPDATE_MS = 40 * 60_000;
/** Typical run on a 2 GB / 2 vCPU computer, for the progress text. */
export const SELF_UPDATE_TYPICAL_SECONDS = 120;

export interface SelfUpdatePaths {
  /** The request file (in root's directory); the .path unit watches it. */
  readonly requestFile: string;
  /** Progress of the root updater (root writes, the daemon reads). */
  readonly statusFile: string;
  /** Where the daemon looks for "latest" — display only, the updater decides itself. */
  readonly baseUrl: string;
}

/** The daemon's own request, next to the button's: `<dir>/auto` (install.sh watches both). */
export function autoRequestFile(requestFile: string): string {
  return join(dirname(requestFile), "auto");
}

export function selfUpdatePathsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SelfUpdatePaths | null {
  const requestFile = env[SELF_UPDATE_REQUEST_ENV]?.trim();
  const statusFile = env[SELF_UPDATE_STATUS_ENV]?.trim();
  if (!requestFile || !statusFile || !isAbsolute(requestFile) || !isAbsolute(statusFile)) {
    return null;
  }
  const baseUrl = normalizeBaseUrl(env[SELF_UPDATE_BASE_URL_ENV]) ?? SELF_UPDATE_DEFAULT_BASE_URL;
  return { requestFile, statusFile, baseUrl };
}

/** https anywhere, plain http only on loopback (tests). */
export function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol === "https:") return trimmed;
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    return url.protocol === "http:" && loopback ? trimmed : null;
  } catch {
    return null;
  }
}

export interface LatestRelease {
  readonly version: string;
  readonly sha256: string;
  readonly tarball: string;
}

const SUMS_LINE = /^([0-9a-f]{64})\s+\*?(\S+)$/;
const VERSIONED_TARBALL = /^uno-work-server-(\d+\.\d+\.\d+)\.tar\.gz$/;

/**
 * The release list is append-only (`sha256sum … >> SHA256SUMS` on every
 * release): the LAST line for a pointer (`uno-work-server-latest.tar.gz`,
 * `uno-work-server-auto.tar.gz`) is where it points now, and the versioned
 * file with the same sha names its version.
 */
export function parseReleasePointer(sums: string, pointer: string): LatestRelease | null {
  let pointerSha: string | null = null;
  const versioned: Array<{ sha: string; name: string; version: string }> = [];
  for (const raw of sums.split("\n")) {
    const match = SUMS_LINE.exec(raw.trim());
    if (!match) continue;
    const sha = match[1]!;
    const name = match[2]!;
    if (name === pointer) {
      pointerSha = sha;
      continue;
    }
    const version = VERSIONED_TARBALL.exec(name)?.[1];
    if (version) versioned.push({ sha, name, version });
  }
  if (!pointerSha) return null;
  const same = versioned.filter((entry) => entry.sha === pointerSha);
  const release = same[same.length - 1];
  return release ? { version: release.version, sha256: release.sha, tarball: release.name } : null;
}

export function parseLatestRelease(sums: string): LatestRelease | null {
  return parseReleasePointer(sums, SELF_UPDATE_LATEST_TARBALL);
}

/** Null (no line, or no versioned twin) = this console offers no automatic updates. */
export function parseAutoRelease(sums: string): LatestRelease | null {
  return parseReleasePointer(sums, SELF_UPDATE_AUTO_TARBALL);
}

/** Both pointers from one read of the list. */
export interface ReleasePointers {
  readonly latest: LatestRelease | null;
  readonly auto: LatestRelease | null;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  try {
    return compareCliVersions(candidate, current) > 0;
  } catch {
    return false;
  }
}

/** What the root updater writes (deploy/install.sh → uno-work-update). */
export interface UpdaterStatus {
  readonly state: "updating" | "done" | "failed" | "current";
  readonly step: string | null;
  readonly error: string | null;
  readonly fromVersion: string | null;
  readonly toVersion: string | null;
  readonly rolledBack: boolean;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly finishedAt: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null;
}

export function parseUpdaterStatus(body: string): UpdaterStatus | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const state = parsed.state;
    if (state !== "updating" && state !== "done" && state !== "failed" && state !== "current") {
      return null;
    }
    return {
      state,
      step: text(parsed.step),
      error: text(parsed.error),
      fromVersion: text(parsed.fromVersion),
      toVersion: text(parsed.toVersion),
      rolledBack: parsed.rolledBack === true,
      startedAt: text(parsed.startedAt),
      updatedAt: text(parsed.updatedAt),
      finishedAt: text(parsed.finishedAt),
    };
  } catch {
    return null;
  }
}

/** What the app gets from `GET /api/self-update/status`. */
export interface SelfUpdateStatus {
  /** This computer can update Uno Work by itself (installed from 0.0.113+). */
  readonly supported: boolean;
  /** The asking session is the owner of this computer. */
  readonly canUpdate: boolean;
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  /** A newer release is out and nothing is being installed right now. */
  readonly available: boolean;
  readonly state: "idle" | "updating" | "done" | "failed";
  readonly step: string | null;
  readonly error: string | null;
  /** The last run: what it moved from and to. */
  readonly fromVersion: string | null;
  readonly toVersion: string | null;
  readonly rolledBack: boolean;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface SelfUpdateDeps {
  readonly paths: SelfUpdatePaths | null;
  readonly currentVersion: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface SelfUpdateController {
  /** The installer set up self-update on this computer (0.0.113+). */
  readonly supported: boolean;
  readonly status: (options: {
    readonly canUpdate: boolean;
    readonly refresh?: boolean;
  }) => Promise<SelfUpdateStatus>;
  /** Ask the root updater to run. Resolves with the status right after. */
  readonly start: () => Promise<SelfUpdateStatus>;
  /** The last finished run, for the Security journal (see selfUpdateJournal.ts). */
  readonly lastRun: () => Promise<UpdaterStatus | null>;
  /** `latest` and `auto` from the console's list (cached like `status`). */
  readonly releases: (refresh?: boolean) => Promise<ReleasePointers>;
  /**
   * An update is asked for or running: a request file is there (not taken
   * yet, or never — the .path unit is off) or the updater says "updating".
   * Cheap: local reads, no network.
   */
  readonly inProgress: () => Promise<boolean>;
  /**
   * The automatic update (autoUpdate.ts): `auto` next to the button's
   * `request` (the updater then installs the console's "auto" release, not
   * "latest"), and no owner's note — so the Security line says "Uno Work on
   * this computer was updated to X", not "You updated".
   */
  readonly requestAutomatic: () => Promise<void>;
}

export class SelfUpdateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfUpdateUnavailableError";
  }
}

export function makeSelfUpdateController(deps: SelfUpdateDeps): SelfUpdateController {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  let latest: { releases: ReleasePointers; at: number; ok: boolean } | null = null;
  let checking: Promise<ReleasePointers> | null = null;
  const NONE: ReleasePointers = { latest: null, auto: null };

  const fetchReleases = async (baseUrl: string): Promise<ReleasePointers> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LATEST_FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${baseUrl}/SHA256SUMS`, {
        signal: controller.signal,
        redirect: "error",
        headers: { accept: "text/plain" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      if (body.length > LATEST_MAX_BYTES) throw new Error("release list is too large");
      return { latest: parseLatestRelease(body), auto: parseAutoRelease(body) };
    } finally {
      clearTimeout(timer);
    }
  };

  const releasesFrom = (baseUrl: string, refresh: boolean): Promise<ReleasePointers> => {
    const age = latest ? now() - latest.at : Number.POSITIVE_INFINITY;
    const ttl = latest?.ok ? LATEST_TTL_MS : LATEST_RETRY_MS;
    if (latest && !refresh && age < ttl) return Promise.resolve(latest.releases);
    if (!checking) {
      checking = fetchReleases(baseUrl)
        .then((releases) => {
          latest = { releases, at: now(), ok: true };
          return releases;
        })
        .catch(() => {
          // The console is unreachable: keep what we knew, try again soon.
          latest = { releases: latest?.releases ?? NONE, at: now(), ok: false };
          return latest.releases;
        })
        .finally(() => {
          checking = null;
        });
    }
    return checking;
  };

  const latestRelease = (baseUrl: string, refresh: boolean): Promise<LatestRelease | null> =>
    releasesFrom(baseUrl, refresh).then((releases) => releases.latest);

  const readUpdater = async (statusFile: string): Promise<UpdaterStatus | null> => {
    try {
      return parseUpdaterStatus(await readFile(statusFile, "utf8"));
    } catch {
      return null;
    }
  };

  const fileTime = async (file: string): Promise<number | null> => {
    try {
      return (await stat(file)).mtimeMs;
    } catch {
      return null;
    }
  };
  /** The newest waiting request: the owner's `request` or the daemon's `auto`. */
  const requestTime = async (requestFile: string): Promise<number | null> => {
    const times = (
      await Promise.all([fileTime(requestFile), fileTime(autoRequestFile(requestFile))])
    ).filter((at): at is number => at !== null);
    return times.length > 0 ? Math.max(...times) : null;
  };

  const status: SelfUpdateController["status"] = async ({ canUpdate, refresh = false }) => {
    const base = {
      canUpdate,
      currentVersion: deps.currentVersion,
      latestVersion: null,
      available: false,
      state: "idle",
      step: null,
      error: null,
      fromVersion: null,
      toVersion: null,
      rolledBack: false,
      startedAt: null,
      finishedAt: null,
    } satisfies Omit<SelfUpdateStatus, "supported">;
    const paths = deps.paths;
    if (!paths) return { ...base, supported: false, canUpdate: false };

    const at = now();
    const [updater, requestedAt, release] = await Promise.all([
      readUpdater(paths.statusFile),
      requestTime(paths.requestFile),
      latestRelease(paths.baseUrl, refresh),
    ]);
    const latestVersion = release?.version ?? null;
    const newer = latestVersion !== null && isNewerVersion(latestVersion, deps.currentVersion);
    const run = {
      fromVersion: updater?.fromVersion ?? null,
      toVersion: updater?.toVersion ?? null,
      rolledBack: updater?.rolledBack ?? false,
      startedAt: updater?.startedAt ?? null,
      finishedAt: updater?.finishedAt ?? null,
    };
    const result = (
      patch: Partial<SelfUpdateStatus> & Pick<SelfUpdateStatus, "state">,
    ): SelfUpdateStatus => ({
      ...base,
      ...run,
      supported: true,
      latestVersion,
      available: newer && patch.state !== "updating",
      ...patch,
    });

    // The request is newer than the updater's last word: it has not taken it yet.
    const updaterAt = updater?.updatedAt ? Date.parse(updater.updatedAt) : Number.NaN;
    if (requestedAt !== null && !(updaterAt >= requestedAt)) {
      if (at - requestedAt > REQUEST_NOT_PICKED_MS) {
        return result({
          state: "failed",
          error: "The update didn't start on this computer. Try again in a minute.",
          rolledBack: false,
        });
      }
      return result({
        state: "updating",
        step: "Starting",
        startedAt: new Date(requestedAt).toISOString(),
        finishedAt: null,
        toVersion: latestVersion,
        fromVersion: deps.currentVersion,
      });
    }
    if (updater?.state === "updating") {
      const started = updater.startedAt ? Date.parse(updater.startedAt) : Number.NaN;
      if (Number.isFinite(started) && at - started > STALE_UPDATE_MS) {
        return result({ state: "failed", error: "The update stopped responding. Try again." });
      }
      return result({ state: "updating", step: updater.step ?? "Updating" });
    }
    if (updater?.state === "failed") {
      return result({ state: "failed", error: updater.error ?? "The update didn't finish." });
    }
    if (updater?.state === "done") return result({ state: "done" });
    return result({ state: "idle" });
  };

  /** The file carries nothing the updater reads — only its existence (and name) matters. */
  const writeRequest = async (file: string) => {
    // The directory is root's (install.sh): it is not ours to create.
    await mkdir(dirname(file), { recursive: true }).catch(() => undefined);
    const temp = `${file}.tmp`;
    await writeFile(temp, `${new Date(now()).toISOString()}\n`);
    await rename(temp, file);
  };

  const start: SelfUpdateController["start"] = async () => {
    const paths = deps.paths;
    if (!paths) {
      throw new SelfUpdateUnavailableError("This computer can't update Uno Work by itself.");
    }
    const current = await status({ canUpdate: true, refresh: true });
    if (current.state === "updating") return current;
    if (!current.available) {
      throw new SelfUpdateUnavailableError("Uno Work is already up to date.");
    }
    await writeRequest(paths.requestFile);
    return status({ canUpdate: true });
  };

  const inProgress: SelfUpdateController["inProgress"] = async () => {
    const paths = deps.paths;
    if (!paths) return false;
    const [updater, requestedAt] = await Promise.all([
      readUpdater(paths.statusFile),
      requestTime(paths.requestFile),
    ]);
    if (requestedAt !== null) return true;
    if (updater?.state !== "updating") return false;
    const started = updater.startedAt ? Date.parse(updater.startedAt) : Number.NaN;
    return !(Number.isFinite(started) && now() - started > STALE_UPDATE_MS);
  };

  return {
    supported: deps.paths !== null,
    status,
    start,
    lastRun: async () => (deps.paths ? readUpdater(deps.paths.statusFile) : null),
    releases: (refresh = false) =>
      deps.paths ? releasesFrom(deps.paths.baseUrl, refresh) : Promise.resolve(NONE),
    inProgress,
    requestAutomatic: async () => {
      if (!deps.paths) {
        throw new SelfUpdateUnavailableError("This computer can't update Uno Work by itself.");
      }
      await writeRequest(autoRequestFile(deps.paths.requestFile));
    },
  };
}
