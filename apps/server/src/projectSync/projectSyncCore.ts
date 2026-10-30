/**
 * "On all my computers" on this computer: which projects sync, when, what
 * their row says, and their keys. The sync itself is the engine in the App
 * SDK (`~/.uno/sdk/js/uno-sync.mjs`, the same one `uno project sync` runs);
 * keys go to the Uno vault (`vaultProjectSecrets.ts`) and land in the
 * project's `.env` (0600) on every computer — never in the synced files.
 *
 * New folders in ~/projects sync by themselves; older ones get one question.
 * A project can also live in a private GitHub or GitLab repository (`host`):
 * it is a git project, and each sync pushes and pulls what's committed there.
 *
 * A project someone shared with this person (`team`) lives in the owner's Uno
 * cloud and syncs through the team routes. Its keys only come in: the ones the
 * owner ticked land in `.env`; a key added here stays here.
 *
 * Plain promises with every dependency injected (tests use fakes); the
 * Effect service around it is `ProjectSyncService.ts`.
 *
 * @module projectSync/projectSyncCore
 */
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  isAssistantProjectId,
  type ProjectSecretsList,
  type ProjectSyncConflict,
  type ProjectSyncElsewhere,
  type ProjectSyncEntry,
  type ProjectSyncFiles,
  type ProjectSyncHistory,
  type ProjectSyncHost,
  type ProjectSyncMode,
  type ProjectSyncProjectRef,
  type ProjectSyncSnapshot,
  type ProjectSyncState,
  type ProjectSyncTeam,
} from "@t3tools/contracts";

import { NO_PROJECT_FOLDER } from "@t3tools/shared/noProject";

import { secretNameProblem, upsertEnvContent } from "../secretsEnv.ts";
import {
  MAX_WAIT_FOR_TURNS_MS,
  OWN_WRITES_QUIET_MS,
  POLL_EVERY_MS,
  createSyncScheduler,
  envNames,
  envValue,
  mergeEnvContent,
  type SchedulerTimers,
  type SyncTrigger,
} from "./projectSyncRules.ts";
import type { ProjectTeams, ProjectVault, SharedProject } from "./vaultProjectSecrets.ts";

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
    readonly theirsPerson?: string | null;
    readonly at: string;
  } | null;
  readonly held?: ReadonlyArray<string>;
  readonly message: string;
  readonly host?: { readonly state: EngineState; readonly message: string };
}

export interface EngineCtx {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly hostname?: string;
  readonly person?: string | null;
}

export interface SyncEngine {
  readonly syncProject: (
    input: {
      dir: string;
      name?: string | null;
      adopt?: boolean;
      hostRemote?: string | null;
      skipCloud?: boolean;
      team?: number | null;
    },
    ctx: EngineCtx,
  ) => Promise<EngineResult>;
  readonly startRepository: (input: { dir: string; name: string }, ctx: EngineCtx) => Promise<void>;
  readonly keysBeforePublish: (
    input: { dir: string },
    ctx: EngineCtx,
  ) => Promise<ReadonlyArray<string>>;
  readonly heldFromPublishMessage: (files: ReadonlyArray<string>) => string;
  readonly getProject: (
    input: { name: string; dir?: string | null; team?: number | null },
    ctx: EngineCtx,
  ) => Promise<EngineResult>;
  readonly resolveConflict: (
    input: { dir: string; name: string; keep: "mine" | "theirs" | "dismiss" },
    ctx: EngineCtx,
  ) => Promise<EngineResult>;
  readonly projectHistory: (
    input: { dir: string; skip?: number; limit?: number },
    ctx: EngineCtx,
  ) => Promise<ProjectSyncHistory>;
  readonly restoreVersion: (
    input: {
      dir: string;
      name: string;
      version: string;
      files?: ReadonlyArray<string> | null;
    },
    ctx: EngineCtx,
  ) => Promise<EngineResult>;
  readonly projectFiles: (input: { dir: string }, ctx: EngineCtx) => Promise<ProjectSyncFiles>;
  readonly setLocalOnly: (
    input: { dir: string; path: string; localOnly: boolean },
    ctx: EngineCtx,
  ) => Promise<void>;
  readonly listCloudProjects: (ctx: EngineCtx) => Promise<
    ReadonlyArray<{
      readonly name: string;
      readonly updatedAt: string | null;
      readonly updatedBy: { readonly hostname: string } | null;
      readonly mode: ProjectSyncMode;
    }>
  >;
  readonly peekSharedProject: (
    input: { name: string; team: number },
    ctx: EngineCtx,
  ) => Promise<{
    readonly name: string;
    readonly updatedAt: string | null;
    readonly mode: ProjectSyncMode;
  } | null>;
  readonly defaultName: (dir: string) => string;
}

export interface ProjectRef {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createdAt?: string;
}

export interface ProjectSyncDeps {
  readonly home: string;
  readonly stateDir: string;
  readonly hostname: string;
  readonly env: NodeJS.ProcessEnv;
  readonly engine: () => Promise<SyncEngine>;
  /** A key to the person's Uno cloud is on this computer. */
  readonly available: () => Promise<boolean>;
  /** The name on the versions this computer saves, when known. */
  readonly person?: () => Promise<string | null>;
  /** A chat is working in the project's folder right now. */
  readonly turnRunning?: (projectId: string) => Promise<boolean>;
  readonly vault: ProjectVault;
  /** Projects other people shared with this person; none when teams aren't on. */
  readonly teams?: ProjectTeams;
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
  /** Files with something that looks like a key inside, waiting here (names only). */
  held?: ReadonlyArray<string>;
  /** Turned on by itself (a new folder in ~/projects), not by the person. */
  auto?: boolean;
  /** The project's GitHub or GitLab repository: pushed to and pulled from on each sync. */
  host?: ProjectSyncHost;
  /** Someone else's project, shared with this person. */
  team?: ProjectSyncTeam;
}

/** What this computer remembers across projects. */
interface Notes {
  /** When this computer started syncing by default: older projects are asked about once. */
  since: string | null;
  /** The one line about the first project was shown. */
  introSeen: boolean;
  /** The one question to older projects was answered. */
  askedOld: boolean;
}

const STORE_FILE = "project-sync.json";
const UNAVAILABLE =
  "Sign in to your Uno account on this computer (Settings → Uno account) to keep projects on all your computers.";
const ELSEWHERE_TTL_MS = 2 * 60_000;
/** Turn starts and opens don't need a fresh look more often than this. */
const FRESH_ENOUGH_MS = 60_000;
/** How long Keep only here / Sync it wait for a running sync to let go of the folder. */
const LOCAL_ONLY_WAIT_MS = 20_000;
const LOCAL_ONLY_POLL_MS = 200;
const HISTORY_PAGE = 100;

const expandHome = (home: string, dir: string) =>
  dir === "~" ? home : dir.startsWith("~/") ? path.join(home, dir.slice(2)) : dir;

/** The name to sign versions with: the account's, never the generated `uno_1234`. */
export function personName(account: {
  readonly username?: string | null;
  readonly email?: string | null;
}): string | null {
  const username = account.username?.trim() ?? "";
  if (username && !/^uno_\d+$/.test(username)) return username;
  return account.email?.split("@")[0]?.trim() || null;
}

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
  const notes: Notes = { since: null, introSeen: false, askedOld: false };
  let loaded = false;
  const watchers = new Map<string, () => void>();
  const quietUntil = new Map<string, number>();
  const pendingResolve = new Map<string, "mine" | "theirs" | "dismiss">();
  const pendingUpload = new Set<string>();
  const pendingRestore = new Map<
    string,
    { version: string; files: ReadonlyArray<string> | null }
  >();
  const lastRun = new Map<string, EngineResult>();
  /** Folders "Get it here" is filling: not new projects to adopt. */
  const arriving = new Set<string>();
  /** Since when a project's syncs have been waiting for chats to finish. */
  const waitingSince = new Map<string, number>();
  /** The answer "turn on" to the question about older projects, working through them. */
  let adopting: Promise<void> = Promise.resolve();
  let elsewhere: { at: number; list: ReadonlyArray<ProjectSyncElsewhere> } | null = null;
  let elsewhereLoading: Promise<void> | null = null;
  let pollTimer: unknown = null;
  let stopped = false;
  const engineCtx = async (): Promise<EngineCtx> => ({
    home: deps.home,
    env: { ...deps.env, HOME: deps.home },
    hostname: deps.hostname,
    person: (await deps.person?.().catch(() => null)) ?? null,
  });

  /** The owner as this project's words name them. */
  const teamOf = (project: SharedProject): ProjectSyncTeam => ({
    id: project.id,
    owner: personName(project.owner) ?? project.owner.username ?? "The owner",
  });

  /** Projects other people shared with this person, as the console says now. */
  const sharedWithMe = async () =>
    ((await deps.teams?.projects()) ?? []).filter((project) => project.role === "editor");

  const sharedProject = async (teamId: number, name: string) => {
    const found = (await sharedWithMe()).find(
      (project) => project.id === teamId && project.name === name,
    );
    if (!found) throw new ProjectSyncFailure(`${name} isn't shared with you.`);
    return teamOf(found);
  };

  /** A shared project is on this computer. */
  const arrived = (teamId: number) =>
    Object.values(store).some((entry) => entry.team?.id === teamId);

  /** "The project owner's…" from the engine, with their name in it. */
  const ownerNamed = (entry: Stored, message: string) =>
    entry.team ? message.replace("The project owner's", `${entry.team.owner}'s`) : message;

  const load = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(await readFile(storeFile, "utf8")) as Partial<Notes> & {
        projects?: unknown;
      };
      if (raw.projects && typeof raw.projects === "object") {
        store = raw.projects as Record<string, Stored>;
      }
      notes.since = typeof raw.since === "string" ? raw.since : null;
      notes.introSeen = raw.introSeen === true;
      notes.askedOld = raw.askedOld === true;
    } catch {
      store = {};
    }
    if (notes.since === null) {
      notes.since = new Date(deps.timers.now()).toISOString();
      await persist();
    }
  };
  const persist = () =>
    writePrivate(
      storeFile,
      `${JSON.stringify({ version: 1, ...notes, projects: store }, null, 2)}\n`,
    ).catch((error) =>
      deps.log("warn", "project sync: couldn't save its state", { error: String(error) }),
    );

  const scheduler = createSyncScheduler({
    run: (key, manual) =>
      runSync(key, manual).catch(async (error) => {
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

  const folderOf = (project: ProjectRef) =>
    path.resolve(expandHome(deps.home, project.workspaceRoot));

  /**
   * A folder of its own right in ~/projects, or a chat without a project that
   * became one (~/chats): what syncs without being asked.
   */
  const inProjectsFolder = (project: ProjectRef) => {
    const parent = path.dirname(folderOf(project));
    const home = path.resolve(deps.home);
    return parent === path.join(home, "projects") || parent === path.join(home, NO_PROJECT_FOLDER);
  };

  /** Projects of this computer nobody decided about yet, by whether they came after `since`. */
  const undecided = async () => {
    const since = Date.parse(notes.since ?? "");
    const open = (await deps.projects()).filter(
      (project) =>
        !store[project.id] &&
        !isAssistantProjectId(project.id) &&
        !arriving.has(folderOf(project)) &&
        inProjectsFolder(project),
    );
    const isNew = (project: ProjectRef) => Date.parse(project.createdAt ?? "") >= since;
    return { fresh: open.filter(isNew), old: open.filter((project) => !isNew(project)) };
  };

  const newEntry = (dir: string): Stored => ({
    name: null,
    dir,
    enabled: false,
    mode: null,
    state: "off",
    message: "",
    lastSyncedAt: null,
    conflict: null,
    keyVersions: {},
  });

  /** A new folder in ~/projects starts syncing by itself, after it settles (a clone may be running). */
  const adoptNewProjects = async () => {
    await load();
    if (stopped) return;
    const { fresh } = await undecided();
    if (fresh.length === 0 || !(await deps.available())) return;
    for (const project of fresh) {
      const dir = folderOf(project);
      if (!(await stat(dir).catch(() => null))?.isDirectory()) continue;
      store[project.id] = { ...newEntry(dir), enabled: true, state: "empty", auto: true };
      pendingUpload.add(project.id);
      startWatch(project.id, dir);
      scheduler.schedule(project.id, "app-start");
    }
    await persist();
  };

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
      held: entry.enabled ? (entry.held ?? []) : [],
      host: entry.host ?? null,
      ...(entry.team ? { team: entry.team } : {}),
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

  async function runSync(projectId: string, manual: boolean): Promise<void> {
    await load();
    const entry = store[projectId];
    if (!entry?.enabled || stopped) return;
    if (!manual && (await deps.turnRunning?.(projectId))) {
      // A chat is mid-way: its turn's end, or the next poll, runs this again.
      const since = waitingSince.get(projectId) ?? deps.timers.now();
      waitingSince.set(projectId, since);
      if (deps.timers.now() - since < MAX_WAIT_FOR_TURNS_MS) return;
    }
    waitingSince.delete(projectId);
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
    const ctx = await engineCtx();
    // Without a way to the Uno cloud a project with a repository still goes there.
    const cloud = await deps.available();
    const toHost = {
      ...(entry.host ? { hostRemote: entry.host.remote, skipCloud: !cloud } : {}),
      ...(entry.team ? { team: entry.team.id } : {}),
    };
    let result: EngineResult;
    const keep = pendingResolve.get(projectId);
    pendingResolve.delete(projectId);
    const restore = pendingRestore.get(projectId);
    pendingRestore.delete(projectId);
    if (keep && entry.name) {
      result = await engine.resolveConflict({ dir, name: entry.name, keep }, ctx);
    } else if (restore && entry.name) {
      result = await engine.restoreVersion({ dir, name: entry.name, ...restore }, ctx);
      // The person's click is answered directly: it says nothing about the project's sync.
      if (!result.ok) {
        lastRun.set(projectId, result);
        return;
      }
    } else if (entry.name) {
      // Ours already: it may (re)join the cloud's history (a moved folder).
      result = await engine.syncProject({ dir, name: entry.name, adopt: true, ...toHost }, ctx);
    } else {
      result = await firstSync(engine, dir, ctx, toHost);
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
      entry.message = ownerNamed(entry, result.message);
    }
    entry.conflict = result.conflict
      ? {
          files: [...result.conflict.files],
          kept: { ...result.conflict.kept },
          from: result.conflict.theirsFrom,
          person: result.conflict.theirsPerson ?? null,
          at: result.conflict.at,
        }
      : null;
    if (result.state !== "busy") entry.held = [...(result.held ?? [])];
    if (result.ok) entry.lastSyncedAt = new Date(deps.timers.now()).toISOString();
    if (result.ok && entry.name && cloud) {
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
  async function firstSync(
    engine: SyncEngine,
    dir: string,
    ctx: EngineCtx,
    toHost: { readonly hostRemote?: string; readonly skipCloud?: boolean; readonly team?: number },
  ) {
    let result = await engine.syncProject({ dir, name: null, ...toHost }, ctx);
    const base = result.name || engine.defaultName(dir);
    for (
      let n = 2;
      n <= 6 && result.state === "blocked" && /different project/.test(result.message);
      n += 1
    ) {
      result = await engine.syncProject({ dir, name: `${base}-${n}`.slice(0, 64), ...toHost }, ctx);
    }
    return result;
  }

  /** Where a project's keys come from: the person's vault, or what its owner gave them. */
  const keysOf = (entry: Stored): Pick<ProjectVault, "list" | "reveal"> => {
    if (!entry.team) return deps.vault;
    if (!deps.teams) throw new ProjectSyncFailure("Shared projects aren't available right now.");
    return deps.teams.keys(entry.team.id);
  };

  /**
   * Keys of the project between this computer and the vault. New or
   * changed keys in the vault are written into `.env` (merging: keys only
   * this computer has stay). `upload`: keys of `.env` the vault doesn't have
   * yet go there (turning sync on); never in someone else's project, whose
   * keys are its owner's to add.
   */
  async function syncKeys(projectId: string, entry: Stored, upload: boolean) {
    const name = entry.name;
    if (!name) return;
    const envFile = path.join(entry.dir, ".env");
    const local = await readFile(envFile, "utf8").catch(() => "");
    const vault = keysOf(entry);
    let remote = await vault.list(name);
    if (upload && !entry.team) {
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
      if (uploaded > 0) remote = await vault.list(name);
    }
    const present = new Set(envNames(local));
    const changed = remote
      .filter(
        (secret) => entry.keyVersions[secret.name] !== secret.version || !present.has(secret.name),
      )
      .map((secret) => secret.name);
    if (changed.length === 0) return;
    const values = await vault.reveal(name, changed);
    const merged = mergeEnvContent(local, values);
    if (merged.content !== local) {
      await writePrivate(envFile, merged.content);
      await keepEnvOutOfGit(entry.dir);
    }
    for (const secret of remote) {
      if (changed.includes(secret.name) && secret.name in values) {
        entry.keyVersions[secret.name] = secret.version;
      }
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

  const disable = async (projectId: string): Promise<ProjectSyncEntry> => {
    await load();
    const project = await projectOf(projectId);
    if (!project) throw new ProjectSyncFailure("This project isn't on this computer.");
    const entry: Stored = store[projectId] ?? newEntry(folderOf(project));
    store[projectId] = entry;
    entry.enabled = false;
    entry.state = "off";
    scheduler.cancel(projectId);
    stopWatch(projectId);
    await persist();
    return view(projectId);
  };

  const enable = async (projectId: string): Promise<ProjectSyncEntry> => {
    await load();
    const project = await projectOf(projectId);
    if (!project) throw new ProjectSyncFailure("This project isn't on this computer.");
    const dir = folderOf(project);
    const entry: Stored = store[projectId] ?? newEntry(dir);
    store[projectId] = entry;
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
  };

  const refreshElsewhere = () => {
    if (elsewhereLoading) return elsewhereLoading;
    elsewhereLoading = (async () => {
      try {
        const engine = await deps.engine();
        const ctx = await engineCtx();
        const list = await engine.listCloudProjects(ctx);
        elsewhere = {
          at: deps.timers.now(),
          list: [
            ...list.map((project) => ({
              name: project.name,
              updatedAt: project.updatedAt,
              from: project.updatedBy?.hostname ?? null,
              mode: project.mode,
            })),
            ...(await sharedElsewhere(engine, ctx)),
          ],
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

  /** Projects shared with this person that aren't on this computer yet. */
  const sharedElsewhere = async (
    engine: SyncEngine,
    ctx: EngineCtx,
  ): Promise<ReadonlyArray<ProjectSyncElsewhere>> => {
    const shared = await sharedWithMe().catch((error) => {
      deps.log("warn", "project sync: couldn't list the shared projects", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return [];
    });
    const rows = await Promise.all(
      shared
        .filter((project) => !arrived(project.id))
        .map(async (project) => {
          const peek = await engine
            .peekSharedProject({ name: project.name, team: project.id }, ctx)
            .catch(() => null);
          if (!peek) return [];
          const team = teamOf(project);
          return [
            {
              name: project.name,
              updatedAt: peek.updatedAt,
              from: team.owner,
              mode: peek.mode,
              team,
            },
          ];
        }),
    );
    return rows.flat();
  };

  const schedulePolls = () => {
    if (stopped) return;
    pollTimer = deps.timers.setTimeout(() => {
      for (const [projectId, entry] of Object.entries(store)) {
        if (entry.enabled) scheduler.schedule(projectId, "poll");
      }
      void adoptNewProjects().catch((error) =>
        deps.log("warn", "project sync: couldn't look for new projects", { error: String(error) }),
      );
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
      await adoptNewProjects().catch((error) =>
        deps.log("warn", "project sync: couldn't look for new projects", { error: String(error) }),
      );
      schedulePolls();
    },

    adoptNewProjects,

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
          .filter((entry) => !entry.team)
          .map((entry) => entry.name)
          .filter((name): name is string => !!name),
      );
      const introProject = notes.introSeen
        ? null
        : Object.entries(store).find(([, entry]) => entry.auto && entry.lastSyncedAt)?.[0];
      const titles = (list: ReadonlyArray<ProjectRef>): ReadonlyArray<ProjectSyncProjectRef> =>
        list.map((project) => ({
          projectId: project.id as ProjectSyncProjectRef["projectId"],
          title: project.title,
        }));
      return {
        available,
        unavailableReason: available ? null : UNAVAILABLE,
        projects: Object.keys(store).map(view),
        elsewhere: available
          ? (elsewhere?.list ?? []).filter((project) =>
              project.team ? !arrived(project.team.id) : !here.has(project.name),
            )
          : [],
        intro: introProject
          ? (titles((await deps.projects()).filter((item) => item.id === introProject))[0] ?? null)
          : null,
        askAbout: available && !notes.askedOld ? titles((await undecided()).old) : [],
      };
    },

    /** The first project's one line was shown: never again on this computer. */
    introSeen: async () => {
      await load();
      notes.introSeen = true;
      await persist();
    },

    /**
     * The one question to older projects. Whatever the answer, it isn't asked
     * again; "yes" turns them on one after another, in the background.
     */
    answerOld: async (turnOn: boolean) => {
      await load();
      const { old } = await undecided();
      notes.askedOld = true;
      await persist();
      if (!turnOn) return;
      adopting = (async () => {
        for (const project of old) {
          await enable(project.id).catch((error) =>
            deps.log("warn", "project sync: an older project didn't turn on", {
              project: project.title,
              reason: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      })();
    },

    /** Tests: the older projects are all on. */
    adoptionDone: () => adopting,

    entry: async (projectId: string) => {
      await load();
      return view(projectId);
    },

    setEnabled: (projectId: string, enabled: boolean): Promise<ProjectSyncEntry> =>
      enabled ? enable(projectId) : disable(projectId),

    /**
     * A new project's folder, its own git and first version, before it is a
     * project: it syncs as a repository from its first moment (a folder Uno
     * saw without git stays a snapshot).
     */
    startRepository: async (folder: string, name: string) => {
      const dir = path.resolve(expandHome(deps.home, folder));
      if (dir === path.resolve(deps.home)) {
        throw new ProjectSyncFailure("Pick a folder inside your home folder.");
      }
      const engine = await deps.engine();
      await engine.startRepository({ dir, name }, await engineCtx());
    },

    /** Where the project's folder is, for what publishes it. */
    folderOf: async (projectId: string) => {
      const project = await projectOf(projectId);
      if (!project) throw new ProjectSyncFailure("This project isn't on this computer.");
      return folderOf(project);
    },

    /** The project was published: from now on its repository is kept in step too. */
    hostConnected: async (projectId: string, host: ProjectSyncHost) => {
      await load();
      const project = await projectOf(projectId);
      if (!project) throw new ProjectSyncFailure("This project isn't on this computer.");
      const dir = folderOf(project);
      const entry: Stored = store[projectId] ?? newEntry(dir);
      store[projectId] = entry;
      entry.enabled = true;
      entry.dir = dir;
      entry.host = host;
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

    /**
     * A project from "Projects on your other computers", here: a folder in
     * ~/projects and a project row. `teamId`: someone else's project, shared
     * with this person; checked with the console, not taken on trust.
     */
    getHere: async (name: string, teamId?: number) => {
      await load();
      await ensureAvailable();
      const team = teamId === undefined ? null : await sharedProject(teamId, name);
      const linked = Object.entries(store).find(
        ([, entry]) => entry.name === name && (entry.team?.id ?? null) === (team?.id ?? null),
      );
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
      const result = await engine.getProject(
        { name, dir, ...(team ? { team: team.id } : {}) },
        await engineCtx(),
      );
      if (!result.ok) throw new ProjectSyncFailure(result.message);
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
        ...(team ? { team } : {}),
      };
      arriving.add(dir);
      const projectId = await deps
        .createProject({ title: name, workspaceRoot: dir })
        .then((id) => {
          store[id] = entry;
          return id;
        })
        .finally(() => arriving.delete(dir));
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

    // ── Versions ────────────────────────────────────────────────────────

    history: async (projectId: string, skip?: number): Promise<ProjectSyncHistory> => {
      await load();
      const project = await projectOf(projectId);
      if (!project) throw new ProjectSyncFailure("This project isn't on this computer.");
      const engine = await deps.engine();
      return engine.projectHistory(
        { dir: folderOf(project), limit: HISTORY_PAGE, ...(skip ? { skip } : {}) },
        await engineCtx(),
      );
    },

    /** Bring a version back: the whole project, or `files` of it. Only by the person's click. */
    restore: async (projectId: string, version: string, files?: ReadonlyArray<string>) => {
      await load();
      if (!store[projectId]?.enabled)
        throw new ProjectSyncFailure("This project isn't on all your computers.");
      if (await deps.turnRunning?.(projectId)) {
        throw new ProjectSyncFailure(
          "A chat is working in this project. Try again when it's done.",
        );
      }
      pendingRestore.set(projectId, { version, files: files ?? null });
      await scheduler.runNow(projectId);
      const result = lastRun.get(projectId);
      if (result && !result.ok) throw new ProjectSyncFailure(result.message);
      return view(projectId);
    },

    // ── What travels ────────────────────────────────────────────────────

    files: async (projectId: string): Promise<ProjectSyncFiles> => {
      await load();
      const project = await projectOf(projectId);
      if (!project) throw new ProjectSyncFailure("This project isn't on this computer.");
      const engine = await deps.engine();
      return engine.projectFiles({ dir: folderOf(project) }, await engineCtx());
    },

    setLocalOnly: async (
      projectId: string,
      relative: string,
      localOnly: boolean,
    ): Promise<ProjectSyncFiles> => {
      await load();
      const project = await projectOf(projectId);
      if (!project) throw new ProjectSyncFailure("This project isn't on this computer.");
      if (!store[projectId]?.enabled)
        throw new ProjectSyncFailure("This project isn't on all your computers.");
      const engine = await deps.engine();
      const dir = folderOf(project);
      const ctx = await engineCtx();
      // The engine refuses while a sync holds the folder: the choice waits its turn.
      for (let waited = 0; scheduler.isRunning(projectId) && waited < LOCAL_ONLY_WAIT_MS; ) {
        await new Promise<void>((resolve) =>
          deps.timers.setTimeout(() => resolve(), LOCAL_ONLY_POLL_MS),
        );
        waited += LOCAL_ONLY_POLL_MS;
      }
      await engine.setLocalOnly({ dir, path: relative, localOnly }, ctx);
      // The list answers now; the other computers follow in the background
      // (it took seconds on the person's click, with nothing on screen).
      void scheduler.runNow(projectId);
      return engine.projectFiles({ dir }, ctx);
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
          vaultNames = new Set((await keysOf(entry).list(entry.name!)).map((secret) => secret.name));
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
      if (entry?.enabled && entry.name && !entry.team) {
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
      const entry = store[projectId];
      if (entry?.team) {
        const given = await keysOf(entry)
          .list(entry.name!)
          .catch(() => []);
        // The next sync would only bring it back.
        if (given.some((key) => key.name === name)) {
          throw new ProjectSyncFailure(
            `${entry.team.owner} gave you this key. Ask them to take it off.`,
          );
        }
      }
      const envFile = path.join(dir, ".env");
      const local = await readFile(envFile, "utf8").catch(() => null);
      if (local !== null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        await writePrivate(envFile, removeEnvName(local, name));
      }
      if (entry?.enabled && entry.name && !entry.team) {
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
        ([, entry]) => entry.enabled && entry.name && !entry.team && entry.dir === cwd,
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
