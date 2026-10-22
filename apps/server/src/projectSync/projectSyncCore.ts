/**
 * "On all my computers" on this computer: which projects sync, when, what
 * their row says, and their keys. The sync itself is the engine in the App
 * SDK (`~/.uno/sdk/js/uno-sync.mjs`, the same one `uno project sync` runs);
 * keys go to the Uno vault (`vaultProjectSecrets.ts`) and land in the
 * project's `.env` (0600) on every computer — never in the synced files.
 *
 * Plain promises with every dependency injected (tests use fakes); the
 * Effect service around it is `ProjectSyncService.ts`.
 *
 * @module projectSync/projectSyncCore
 */
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ProjectSecretsList,
  ProjectSyncConflict,
  ProjectSyncElsewhere,
  ProjectSyncEntry,
  ProjectSyncMode,
  ProjectSyncSnapshot,
  ProjectSyncState,
} from "@t3tools/contracts";

import { secretNameProblem, upsertEnvContent } from "../secretsEnv.ts";
import {
  OWN_WRITES_QUIET_MS,
  POLL_EVERY_MS,
  createSyncScheduler,
  envNames,
  envValue,
  mergeEnvContent,
  type SchedulerTimers,
  type SyncTrigger,
} from "./projectSyncRules.ts";
import type { ProjectVault } from "./vaultProjectSecrets.ts";

// ── The engine, as this module uses it (uno-sync.d.mts) ─────────────────

export type EngineState =
  | "synced"
  | "conflict"
  | "too-big"
  | "blocked"
  | "busy"
  | "error"
  | "empty";

export interface EngineResult {
  readonly ok: boolean;
  readonly name: string;
  readonly dir: string;
  readonly mode: ProjectSyncMode;
  readonly state: EngineState;
  readonly pushed: boolean;
  readonly pulled: boolean;
  readonly conflict: {
    readonly files: ReadonlyArray<string>;
    readonly kept: Readonly<Record<string, "mine" | "theirs">>;
    readonly theirsFrom: string | null;
    readonly at: string;
  } | null;
  readonly message: string;
}

export interface EngineCtx {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly hostname?: string;
}

export interface SyncEngine {
  readonly syncProject: (
    input: { dir: string; name?: string | null; adopt?: boolean },
    ctx: EngineCtx,
  ) => Promise<EngineResult>;
  readonly getProject: (
    input: { name: string; dir?: string | null },
    ctx: EngineCtx,
  ) => Promise<EngineResult>;
  readonly resolveConflict: (
    input: { dir: string; name: string; keep: "mine" | "theirs" | "dismiss" },
    ctx: EngineCtx,
  ) => Promise<EngineResult>;
  readonly listCloudProjects: (ctx: EngineCtx) => Promise<
    ReadonlyArray<{
      readonly name: string;
      readonly updatedAt: string | null;
      readonly updatedBy: { readonly hostname: string } | null;
      readonly mode: ProjectSyncMode;
    }>
  >;
  readonly defaultName: (dir: string) => string;
}

export interface ProjectRef {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface ProjectSyncDeps {
  readonly home: string;
  readonly stateDir: string;
  readonly hostname: string;
  readonly env: NodeJS.ProcessEnv;
  readonly engine: () => Promise<SyncEngine>;
  /** A key to the person's Uno cloud is on this computer. */
  readonly available: () => Promise<boolean>;
  readonly vault: ProjectVault;
  readonly projects: () => Promise<ReadonlyArray<ProjectRef>>;
  readonly createProject: (input: { title: string; workspaceRoot: string }) => Promise<string>;
  readonly timers: SchedulerTimers;
  readonly watch?: (dir: string, onChange: (relative: string | null) => void) => () => void;
  readonly log: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
}

export class ProjectSyncFailure extends Error {}

/** What this computer remembers per project (`<stateDir>/project-sync.json`). */
interface Stored {
  name: string | null;
  dir: string;
  enabled: boolean;
  mode: ProjectSyncMode | null;
  state: ProjectSyncState;
  message: string;
  lastSyncedAt: string | null;
  conflict: ProjectSyncConflict | null;
  /** Vault version of each key last written into `.env` here. */
  keyVersions: Record<string, number>;
}

const STORE_FILE = "project-sync.json";
const UNAVAILABLE =
  "Sign in to your Uno account on this computer (Settings → Uno account) to keep projects on all your computers.";
const ELSEWHERE_TTL_MS = 2 * 60_000;
/** Turn starts and opens don't need a fresh look more often than this. */
const FRESH_ENOUGH_MS = 60_000;

const expandHome = (home: string, dir: string) =>
  dir === "~" ? home : dir.startsWith("~/") ? path.join(home, dir.slice(2)) : dir;

/** Remove every active assignment of `name` from a dotenv file. */
export function removeEnvName(content: string, name: string): string {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const kept = content.split("\n").filter((line) => !pattern.test(line));
  return kept.join("\n");
}

async function writePrivate(file: string, contents: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, contents, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

export function createProjectSyncCore(deps: ProjectSyncDeps) {
  const storeFile = path.join(deps.stateDir, STORE_FILE);
  let store: Record<string, Stored> = {};
  let loaded = false;
  const watchers = new Map<string, () => void>();
  const quietUntil = new Map<string, number>();
  const pendingResolve = new Map<string, "mine" | "theirs" | "dismiss">();
  const pendingUpload = new Set<string>();
  const lastRun = new Map<string, EngineResult>();
  let elsewhere: { at: number; list: ReadonlyArray<ProjectSyncElsewhere> } | null = null;
  let elsewhereLoading: Promise<void> | null = null;
  let pollTimer: unknown = null;
  let stopped = false;
  const engineCtx = (): EngineCtx => ({
    home: deps.home,
    env: { ...deps.env, HOME: deps.home },
    hostname: deps.hostname,
  });

  const load = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(await readFile(storeFile, "utf8")) as { projects?: unknown };
      if (raw.projects && typeof raw.projects === "object") {
        store = raw.projects as Record<string, Stored>;
      }
    } catch {
      store = {};
    }
  };
  const persist = () =>
    writePrivate(storeFile, `${JSON.stringify({ version: 1, projects: store }, null, 2)}\n`).catch(
      (error) =>
        deps.log("warn", "project sync: couldn't save its state", { error: String(error) }),
    );

  const scheduler = createSyncScheduler({
    run: (key) =>
      runSync(key).catch(async (error) => {
        // Never silent: the row says it, the log has it.
        const reason = error instanceof Error ? error.message : String(error);
        deps.log("warn", "project sync failed", { projectId: key, reason });
        const entry = store[key];
        if (entry) {
          entry.state = "error";
          entry.message = `Couldn't sync: ${reason}`;
          await persist();
        }
      }),
    timers: deps.timers,
  });

  const projectOf = async (projectId: string) =>
    (await deps.projects()).find((project) => project.id === projectId) ?? null;

  const view = (projectId: string): ProjectSyncEntry => {
    const entry = store[projectId];
    if (!entry) {
      return {
        projectId: projectId as ProjectSyncEntry["projectId"],
        enabled: false,
        name: null,
        mode: null,
        state: "off",
        message: "",
        lastSyncedAt: null,
        conflict: null,
      };
    }
    return {
      projectId: projectId as ProjectSyncEntry["projectId"],
      enabled: entry.enabled,
      name: entry.name,
      mode: entry.mode,
      state: !entry.enabled ? "off" : scheduler.isRunning(projectId) ? "syncing" : entry.state,
      message: entry.enabled ? entry.message : "",
      lastSyncedAt: entry.lastSyncedAt,
      conflict: entry.enabled ? entry.conflict : null,
    };
  };

  const startWatch = (projectId: string, dir: string) => {
    if (!deps.watch || watchers.has(projectId)) return;
    watchers.set(
      projectId,
      deps.watch(dir, () => {
        if ((quietUntil.get(projectId) ?? 0) > deps.timers.now()) return;
        scheduler.schedule(projectId, "file-save");
      }),
    );
  };
  const stopWatch = (projectId: string) => {
    watchers.get(projectId)?.();
    watchers.delete(projectId);
  };

  // ── One sync ──────────────────────────────────────────────────────────

  async function runSync(projectId: string): Promise<void> {
    await load();
    const entry = store[projectId];
    if (!entry?.enabled || stopped) return;
    const project = await projectOf(projectId);
    if (!project) {
      // The project was removed from Uno Work: stop syncing it (the cloud copy stays).
      entry.enabled = false;
      stopWatch(projectId);
      await persist();
      return;
    }
    const dir = path.resolve(expandHome(deps.home, project.workspaceRoot));
    if (dir !== entry.dir) {
      stopWatch(projectId);
      entry.dir = dir;
      startWatch(projectId, dir);
    }
    const engine = await deps.engine();
    const ctx = engineCtx();
    let result: EngineResult;
    const keep = pendingResolve.get(projectId);
    pendingResolve.delete(projectId);
    if (keep && entry.name) {
      result = await engine.resolveConflict({ dir, name: entry.name, keep }, ctx);
    } else if (entry.name) {
      // Ours already: it may (re)join the cloud's history (a moved folder).
      result = await engine.syncProject({ dir, name: entry.name, adopt: true }, ctx);
    } else {
      result = await firstSync(engine, dir, ctx);
    }
    lastRun.set(projectId, result);
    quietUntil.set(projectId, deps.timers.now() + OWN_WRITES_QUIET_MS);
    if (result.name) entry.name = result.name;
    entry.mode = result.mode;
    if (result.state === "busy") {
      // The folder changed mid-sync: once more in a moment.
      deps.timers.setTimeout(() => scheduler.schedule(projectId, "poll"), 10_000);
    } else {
      entry.state = result.state;
      entry.message = result.message;
    }
    entry.conflict = result.conflict
      ? {
          files: [...result.conflict.files],
          kept: { ...result.conflict.kept },
          from: result.conflict.theirsFrom,
          at: result.conflict.at,
        }
      : null;
    if (result.ok) entry.lastSyncedAt = new Date(deps.timers.now()).toISOString();
    if (result.ok && entry.name) {
      await syncKeys(projectId, entry, pendingUpload.delete(projectId)).catch((error) =>
        deps.log("warn", "project sync: keys didn't sync", {
          project: entry.name,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    await persist();
  }

  /** A project's first sync: its folder's name, or name-2… when that name is another project. */
  async function firstSync(engine: SyncEngine, dir: string, ctx: EngineCtx) {
    let result = await engine.syncProject({ dir, name: null }, ctx);
    const base = result.name || engine.defaultName(dir);
    for (
      let n = 2;
      n <= 6 && result.state === "blocked" && /different project/.test(result.message);
      n += 1
    ) {
      result = await engine.syncProject({ dir, name: `${base}-${n}`.slice(0, 64) }, ctx);
    }
    return result;
  }

  /**
   * Keys of the project between this computer and the vault. New or
   * changed keys in the vault are written into `.env` (merging: keys only
   * this computer has stay). `upload`: keys of `.env` the vault doesn't have
   * yet go there (turning sync on).
   */
  async function syncKeys(projectId: string, entry: Stored, upload: boolean) {
    const name = entry.name;
    if (!name) return;
    const envFile = path.join(entry.dir, ".env");
    const local = await readFile(envFile, "utf8").catch(() => "");
    let remote = await deps.vault.list(name);
    if (upload) {
      const there = new Set(remote.map((secret) => secret.name));
      let uploaded = 0;
      for (const key of envNames(local)) {
        if (there.has(key) || secretNameProblem(key) !== null) continue;
        const value = envValue(local, key);
        if (!value) continue;
        const saved = await deps.vault.set(name, key, value);
        entry.keyVersions[key] = saved.version;
        uploaded += 1;
      }
      if (uploaded > 0) remote = await deps.vault.list(name);
    }
    const present = new Set(envNames(local));
    const changed = remote
      .filter(
        (secret) => entry.keyVersions[secret.name] !== secret.version || !present.has(secret.name),
      )
      .map((secret) => secret.name);
    if (changed.length === 0) return;
    const values = await deps.vault.reveal(name, changed);
    const merged = mergeEnvContent(local, values);
    if (merged.content !== local) {
      await writePrivate(envFile, merged.content);
      await keepEnvOutOfGit(entry.dir);
    }
    for (const secret of remote) {
      if (changed.includes(secret.name)) entry.keyVersions[secret.name] = secret.version;
    }
    void projectId;
  }

  /** A folder with its own git: make sure `.env` can't be committed by accident. */
  async function keepEnvOutOfGit(dir: string) {
    const gitDir = path.join(dir, ".git");
    const info = await stat(gitDir).catch(() => null);
    if (!info?.isDirectory()) return;
    const exclude = path.join(gitDir, "info", "exclude");
    const current = await readFile(exclude, "utf8").catch(() => "");
    if (current.split("\n").some((line) => line.trim() === ".env" || line.trim() === ".env*"))
      return;
    await mkdir(path.dirname(exclude), { recursive: true });
    await writeFile(
      exclude,
      `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}# Uno: keys travel through the Uno vault\n.env\n.env.*\n`,
    );
  }

  const ensureAvailable = async () => {
    if (!(await deps.available())) throw new ProjectSyncFailure(UNAVAILABLE);
  };

  const refreshElsewhere = () => {
    if (elsewhereLoading) return elsewhereLoading;
    elsewhereLoading = (async () => {
      try {
        const engine = await deps.engine();
        const list = await engine.listCloudProjects(engineCtx());
        elsewhere = {
          at: deps.timers.now(),
          list: list.map((project) => ({
            name: project.name,
            updatedAt: project.updatedAt,
            from: project.updatedBy?.hostname ?? null,
            mode: project.mode,
          })),
        };
      } catch (error) {
        deps.log("warn", "project sync: couldn't list the cloud's projects", {
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        elsewhereLoading = null;
      }
    })();
    return elsewhereLoading;
  };

  const schedulePolls = () => {
    if (stopped) return;
    pollTimer = deps.timers.setTimeout(() => {
      for (const [projectId, entry] of Object.entries(store)) {
        if (entry.enabled) scheduler.schedule(projectId, "poll");
      }
      schedulePolls();
    }, POLL_EVERY_MS);
  };

  const fresh = (projectId: string) => {
    const at = scheduler.lastFinishedAt(projectId);
    return at !== null && deps.timers.now() - at < FRESH_ENOUGH_MS;
  };

  return {
    /** Load, sync every enabled project soon, watch their folders, poll the cloud. */
    start: async () => {
      await load();
      for (const [projectId, entry] of Object.entries(store)) {
        if (!entry.enabled) continue;
        startWatch(projectId, entry.dir);
        scheduler.schedule(projectId, "app-start");
      }
      schedulePolls();
    },

    stop: () => {
      stopped = true;
      scheduler.stop();
      if (pollTimer !== null) deps.timers.clearTimeout(pollTimer);
      for (const projectId of [...watchers.keys()]) stopWatch(projectId);
    },

    status: async (): Promise<ProjectSyncSnapshot> => {
      await load();
      const available = await deps.available();
      if (available && (!elsewhere || deps.timers.now() - elsewhere.at > ELSEWHERE_TTL_MS)) {
        const loading = refreshElsewhere();
        // The first time, wait a little for it; after that the cached list is shown.
        if (!elsewhere) {
          await Promise.race([
            loading,
            new Promise((resolve) => deps.timers.setTimeout(() => resolve(null), 4_000)),
          ]);
        }
      }
      const here = new Set(
        Object.values(store)
          .map((entry) => entry.name)
          .filter((name): name is string => !!name),
      );
      return {
        available,
        unavailableReason: available ? null : UNAVAILABLE,
        projects: Object.keys(store).map(view),
        elsewhere: available
          ? (elsewhere?.list ?? []).filter((project) => !here.has(project.name))
          : [],
      };
    },

    entry: async (projectId: string) => {
      await load();
      return view(projectId);
    },

    setEnabled: async (projectId: string, enabled: boolean): Promise<ProjectSyncEntry> => {
      await load();
      const project = await projectOf(projectId);
      if (!project) throw new ProjectSyncFailure("This project isn't on this computer.");
      const dir = path.resolve(expandHome(deps.home, project.workspaceRoot));
      const entry: Stored = store[projectId] ?? {
        name: null,
        dir,
        enabled: false,
        mode: null,
        state: "off",
        message: "",
        lastSyncedAt: null,
        conflict: null,
        keyVersions: {},
      };
      store[projectId] = entry;
      if (!enabled) {
        entry.enabled = false;
        entry.state = "off";
        scheduler.cancel(projectId);
        stopWatch(projectId);
        await persist();
        return view(projectId);
      }
      await ensureAvailable();
      if (dir === path.resolve(deps.home)) {
        throw new ProjectSyncFailure(
          "The home folder itself can't be on all computers. Put the project in its own folder.",
        );
      }
      const info = await stat(dir).catch(() => null);
      if (!info?.isDirectory())
        throw new ProjectSyncFailure(`${dir} isn't a folder on this computer.`);
      entry.enabled = true;
      entry.dir = dir;
      entry.state = "syncing";
      pendingUpload.add(projectId);
      await persist();
      startWatch(projectId, dir);
      await scheduler.runNow(projectId);
      elsewhere = null;
      return view(projectId);
    },

    syncNow: async (projectId: string) => {
      await load();
      if (!store[projectId]?.enabled)
        throw new ProjectSyncFailure("This project isn't on all your computers.");
      await scheduler.runNow(projectId);
      return view(projectId);
    },

    resolve: async (projectId: string, keep: "mine" | "theirs" | "dismiss") => {
      await load();
      if (!store[projectId]?.enabled)
        throw new ProjectSyncFailure("This project isn't on all your computers.");
      pendingResolve.set(projectId, keep);
      await scheduler.runNow(projectId);
      return view(projectId);
    },

    /** A project from "Projects on your other computers", here: a folder in ~/projects and a project row. */
    getHere: async (name: string) => {
      await load();
      await ensureAvailable();
      const linked = Object.entries(store).find(([, entry]) => entry.name === name);
      if (linked) {
        const [projectId, entry] = linked;
        if (!entry.enabled) {
          entry.enabled = true;
          await persist();
          startWatch(projectId, entry.dir);
        }
        await scheduler.runNow(projectId);
        return { projectId, entry: view(projectId) };
      }
      const root = path.join(deps.home, "projects");
      let dir = path.join(root, name);
      for (let n = 2; n < 50; n += 1) {
        const entries = await readdir(dir).catch(() => null);
        if (entries === null || entries.length === 0) break;
        dir = path.join(root, `${name}-${n}`);
      }
      const engine = await deps.engine();
      const result = await engine.getProject({ name, dir }, engineCtx());
      if (!result.ok) throw new ProjectSyncFailure(result.message);
      const projectId = await deps.createProject({ title: name, workspaceRoot: dir });
      const entry: Stored = {
        name,
        dir,
        enabled: true,
        mode: result.mode,
        state: result.state === "busy" ? "syncing" : result.state,
        message: result.message,
        lastSyncedAt: new Date(deps.timers.now()).toISOString(),
        conflict: null,
        keyVersions: {},
      };
      store[projectId] = entry;
      quietUntil.set(projectId, deps.timers.now() + OWN_WRITES_QUIET_MS);
      await syncKeys(projectId, entry, false).catch((error) =>
        deps.log("warn", "project sync: keys didn't arrive", {
          project: name,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      await persist();
      startWatch(projectId, dir);
      elsewhere = null;
      return { projectId, entry: view(projectId) };
    },

    /** The person opened the project here, or a turn starts in it: bring the other computers' changes. */
    touched: (
      projectId: string,
      trigger: Extract<SyncTrigger, "opened" | "turn-start" | "turn-end">,
    ) => {
      const entry = store[projectId];
      if (!entry?.enabled) return;
      if (trigger !== "turn-end" && fresh(projectId)) return;
      scheduler.schedule(projectId, trigger);
    },

    // ── Keys ────────────────────────────────────────────────────────────

    secretsList: async (projectId: string): Promise<ProjectSecretsList> => {
      await load();
      const project = await projectOf(projectId);
      if (!project) throw new ProjectSyncFailure("This project isn't on this computer.");
      const dir = path.resolve(expandHome(deps.home, project.workspaceRoot));
      const entry = store[projectId];
      const fileNames = new Set(
        envNames(await readFile(path.join(dir, ".env"), "utf8").catch(() => "")),
      );
      const synced = !!entry?.enabled && !!entry.name;
      let vaultNames = new Set<string>();
      let vaultError: string | null = null;
      if (synced) {
        try {
          vaultNames = new Set((await deps.vault.list(entry.name!)).map((secret) => secret.name));
        } catch (error) {
          vaultError = error instanceof Error ? error.message : String(error);
        }
      }
      const names = [...new Set([...fileNames, ...vaultNames])].toSorted();
      return {
        projectId: projectId as ProjectSecretsList["projectId"],
        synced,
        secrets: names.map((name) => ({
          name,
          inVault: vaultNames.has(name),
          inFile: fileNames.has(name),
        })),
        vaultError,
      };
    },

    /** Settings → project keys, and `request_secret`'s answer: the `.env` here and, when synced, the vault. */
    secretSet: async (projectId: string, name: string, value: string) => {
      await load();
      const problemText = secretNameProblem(name);
      if (problemText !== null) throw new ProjectSyncFailure(problemText);
      const project = await projectOf(projectId);
      if (!project) throw new ProjectSyncFailure("This project isn't on this computer.");
      const dir = path.resolve(expandHome(deps.home, project.workspaceRoot));
      const envFile = path.join(dir, ".env");
      const local = await readFile(envFile, "utf8").catch(() => "");
      await writePrivate(envFile, upsertEnvContent(local, name, value));
      await keepEnvOutOfGit(dir);
      const entry = store[projectId];
      if (entry?.enabled && entry.name) {
        const saved = await deps.vault.set(entry.name, name, value).catch((error) => {
          throw new ProjectSyncFailure(
            `Saved on this computer, but not for your other computers: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        entry.keyVersions[name] = saved.version;
        await persist();
      }
    },

    secretRemove: async (projectId: string, name: string) => {
      await load();
      const project = await projectOf(projectId);
      if (!project) throw new ProjectSyncFailure("This project isn't on this computer.");
      const dir = path.resolve(expandHome(deps.home, project.workspaceRoot));
      const envFile = path.join(dir, ".env");
      const local = await readFile(envFile, "utf8").catch(() => null);
      if (local !== null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        await writePrivate(envFile, removeEnvName(local, name));
      }
      const entry = store[projectId];
      if (entry?.enabled && entry.name) {
        await deps.vault.remove(entry.name, name);
        delete entry.keyVersions[name];
        await persist();
      }
    },

    /**
     * A secret `request_secret` just wrote into a folder: when that folder is
     * a synced project and the file its `.env`, it travels too. Best-effort.
     */
    secretWritten: async (input: { cwd: string; file: string; name: string; value: string }) => {
      await load();
      if (input.file !== ".env") return;
      const cwd = path.resolve(expandHome(deps.home, input.cwd));
      const found = Object.entries(store).find(
        ([, entry]) => entry.enabled && entry.name && entry.dir === cwd,
      );
      if (!found) return;
      const [, entry] = found;
      try {
        const saved = await deps.vault.set(entry.name!, input.name, input.value);
        entry.keyVersions[input.name] = saved.version;
        await persist();
      } catch (error) {
        deps.log("warn", "project sync: a requested key didn't reach the vault", {
          project: entry.name,
          key: input.name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },

    /** The synced project a folder belongs to (agents' `project_keys`). */
    projectForFolder: async (cwd: string) => {
      await load();
      const folder = path.resolve(expandHome(deps.home, cwd));
      for (const project of await deps.projects()) {
        const dir = path.resolve(expandHome(deps.home, project.workspaceRoot));
        if (folder === dir || folder.startsWith(`${dir}${path.sep}`)) return project.id;
      }
      return null;
    },

    /** Re-read the vault into `.env` now (agents' `project_keys load`). */
    loadKeys: async (projectId: string) => {
      await load();
      const entry = store[projectId];
      if (!entry?.enabled || !entry.name) {
        throw new ProjectSyncFailure(
          "This project isn't on all your computers, so its keys are only in its .env here.",
        );
      }
      entry.keyVersions = {};
      await syncKeys(projectId, entry, false);
      await persist();
    },

    /** Tests and diagnostics. */
    lastResult: (projectId: string) => lastRun.get(projectId) ?? null,
  };
}

export type ProjectSyncCore = ReturnType<typeof createProjectSyncCore>;
