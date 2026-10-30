/**
 * Two computers' daemons, end to end: the real sync engine and git helper
 * (packages/app-sdk), the cloud in a folder, the Uno vault faked in memory.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installSdkFiles } from "../appSdk/sdkFiles.ts";

import { SECRET_TOKEN_PATTERN } from "../secretRedaction.ts";
import {
  createProjectSyncCore,
  personName,
  removeEnvName,
  type ProjectRef,
  type SyncEngine,
} from "./projectSyncCore.ts";
import type { ProjectTeams, ProjectVault, SharedProject } from "./vaultProjectSecrets.ts";

let root = "";

/** Obviously fake, and put together here so no scanner flags this test file. */
const FAKE_KEY = ["sk-ant-", "FAKE".repeat(6)].join("");

/** The Uno vault: per project, name → versions. */
function memoryVault() {
  const projects = new Map<string, Map<string, { value: string; version: number }>>();
  const reveals: string[][] = [];
  const of = (project: string) => {
    let keys = projects.get(project);
    if (!keys) projects.set(project, (keys = new Map()));
    return keys;
  };
  const vault: ProjectVault = {
    list: async (project) =>
      [...of(project)].map(([name, item]) => ({ name, version: item.version, updatedAt: null })),
    reveal: async (project, names) => {
      reveals.push([...(names ?? [])]);
      return Object.fromEntries(
        [...of(project)]
          .filter(([name]) => !names || names.length === 0 || names.includes(name))
          .map(([name, item]) => [name, item.value]),
      );
    },
    set: async (project, name, value) => {
      const keys = of(project);
      const old = keys.get(name);
      if (old?.value === value) return { version: old.version, changed: false };
      const version = (old?.version ?? 0) + 1;
      keys.set(name, { value, version });
      return { version, changed: true };
    },
    remove: async (project, name) => void of(project).delete(name),
  };
  return { vault, projects, reveals };
}

interface ComputerOptions {
  readonly cloud?: boolean;
  /** This person's own Uno cloud (default: the one everybody shares in these tests). */
  readonly ownCloud?: string;
  /** The owner's cloud behind `uno::team/...`. */
  readonly teamCloud?: string;
  readonly person?: string;
  readonly teams?: ProjectTeams;
  /** Change the engine, for what real storage can't be made to do here. */
  readonly engine?: (engine: SyncEngine) => SyncEngine;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}

function computer(label: string, vault: ProjectVault, options?: ComputerOptions) {
  const home = path.join(root, label);
  const stateDir = path.join(home, ".t3", "userdata");
  fs.mkdirSync(stateDir, { recursive: true });
  const projects: ProjectRef[] = [];
  /** Projects with a chat working in them, and a clock that can jump. */
  const busy = new Set<string>();
  const clock = { shift: 0 };
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    UNO_GIT_FAKE_STORAGE_DIR: options?.ownCloud ?? path.join(root, "cloud"),
    ...(options?.teamCloud ? { UNO_GIT_FAKE_TEAM_STORAGE_DIR: options.teamCloud } : {}),
  };
  const core = createProjectSyncCore({
    home,
    stateDir,
    hostname: label,
    env,
    // As the daemon does it: the engine the SDK bundle installs in ~/.uno/sdk/js.
    engine: async () => {
      await installSdkFiles(home);
      const file = path.join(home, ".uno", "sdk", "js", "uno-sync.mjs");
      const engine = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as SyncEngine;
      return options?.engine ? options.engine(engine) : engine;
    },
    available: async () => options?.cloud !== false,
    person: async () => options?.person ?? "Misha",
    turnRunning: async (projectId) => busy.has(projectId),
    vault,
    ...(options?.teams ? { teams: options.teams } : {}),
    projects: async () => projects,
    createProject: async (input) => {
      const id = `p-${label}-${projects.length + 1}`;
      projects.push({ id, title: input.title, workspaceRoot: input.workspaceRoot });
      return id;
    },
    timers: {
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now() + clock.shift,
    },
    log: (_level, message, data) => {
      options?.log?.(message, data);
      if (process.env.PSYNC_DEBUG) console.log(message, data);
    },
  });
  const addProject = (name: string) => {
    const dir = path.join(home, name);
    fs.mkdirSync(dir, { recursive: true });
    const id = `p-${label}-${projects.length + 1}`;
    projects.push({ id, title: name, workspaceRoot: dir });
    return { id, dir };
  };
  /** A folder in ~/projects, created `at`. */
  const addInProjects = (name: string, at: string) => {
    const dir = path.join(home, "projects", name);
    fs.mkdirSync(dir, { recursive: true });
    const id = `p-${label}-${projects.length + 1}`;
    projects.push({ id, title: name, workspaceRoot: dir, createdAt: at });
    return { id, dir };
  };
  return { home, env, core, projects, addProject, addInProjects, busy, clock };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uno-psync-")));
  fs.mkdirSync(path.join(root, "cloud"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe("project sync on two computers", { timeout: 120_000 }, () => {
  it("a project and its keys move to the other computer; keys never in the synced files", async () => {
    const { vault, projects } = memoryVault();
    const laptop = computer("laptop", vault);
    const cloudPc = computer("cloud-pc", vault);

    const { id, dir } = laptop.addProject("Notes");
    fs.writeFileSync(path.join(dir, "plan.md"), "plan\n");
    fs.writeFileSync(path.join(dir, ".env"), "OPENAI_API_KEY=sk-1\nNODE_OPTIONS=--evil\n");

    const on = await laptop.core.setEnabled(id, true);
    expect(on).toMatchObject({ enabled: true, name: "notes", mode: "snapshot", state: "synced" });
    // The .env's key went to the vault (not the forbidden one), not into the cloud's files.
    expect([...(projects.get("notes")?.keys() ?? [])]).toEqual(["OPENAI_API_KEY"]);

    const seen = await cloudPc.core.status();
    expect(seen.elsewhere.map((project) => project.name)).toEqual(["notes"]);

    const got = await cloudPc.core.getHere("notes");
    const there = path.join(cloudPc.home, "projects", "notes");
    expect(cloudPc.projects).toEqual([{ id: got.projectId, title: "notes", workspaceRoot: there }]);
    expect(got.entry).toMatchObject({ enabled: true, state: "synced" });
    expect(fs.readFileSync(path.join(there, "plan.md"), "utf8")).toBe("plan\n");
    // Keys arrive in .env (owner-only), from the vault.
    expect(fs.readFileSync(path.join(there, ".env"), "utf8")).toBe("OPENAI_API_KEY=sk-1\n");
    expect(mode(path.join(there, ".env"))).toBe(0o600);
    expect((await cloudPc.core.status()).elsewhere).toEqual([]);

    // A key added on the cloud computer and an edit there reach the laptop; its own keys stay.
    fs.appendFileSync(path.join(dir, ".env"), "LOCAL_ONLY=mine\n");
    await cloudPc.core.secretSet(got.projectId, "TELEGRAM_TOKEN", "123:abc");
    fs.writeFileSync(path.join(there, "plan.md"), "plan v2\n");
    await cloudPc.core.syncNow(got.projectId);
    const back = await laptop.core.syncNow(id);
    expect(back.state).toBe("synced");
    expect(fs.readFileSync(path.join(dir, "plan.md"), "utf8")).toBe("plan v2\n");
    const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(env).toContain("OPENAI_API_KEY=sk-1");
    expect(env).toContain("LOCAL_ONLY=mine");
    expect(env).toContain("TELEGRAM_TOKEN=123:abc");

    const listed = await laptop.core.secretsList(id);
    expect(listed.synced).toBe(true);
    expect(listed.secrets).toEqual(
      expect.arrayContaining([
        { name: "OPENAI_API_KEY", inVault: true, inFile: true },
        { name: "LOCAL_ONLY", inVault: false, inFile: true },
        { name: "TELEGRAM_TOKEN", inVault: true, inFile: true },
      ]),
    );
    // Nothing in the cloud's copy names a value.
    const cloudBytes = fs
      .readdirSync(path.join(root, "cloud"), { recursive: true })
      .map(String)
      .filter((file) => fs.statSync(path.join(root, "cloud", file)).isFile())
      .map((file) => fs.readFileSync(path.join(root, "cloud", file)).toString("latin1"))
      .join("");
    expect(cloudBytes).not.toContain("sk-1");
    expect(cloudBytes).not.toContain("123:abc");
  });

  it("a key the agent asked for (request_secret) travels when its folder is a synced project", async () => {
    const { vault, projects } = memoryVault();
    const laptop = computer("laptop", vault);
    const { id, dir } = laptop.addProject("bot");
    fs.writeFileSync(path.join(dir, "bot.py"), "print(1)\n");
    await laptop.core.setEnabled(id, true);
    await laptop.core.secretWritten({ cwd: dir, file: ".env", name: "BOT_TOKEN", value: "t" });
    await laptop.core.secretWritten({ cwd: dir, file: ".env.local", name: "OTHER", value: "x" });
    expect([...(projects.get("bot")?.keys() ?? [])]).toEqual(["BOT_TOKEN"]);
  });

  it("only re-reads keys that changed (each reveal is an audit row)", async () => {
    const { vault, reveals } = memoryVault();
    const laptop = computer("laptop", vault);
    const { id, dir } = laptop.addProject("api");
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    await laptop.core.setEnabled(id, true);
    await vault.set("api", "K", "1");
    await laptop.core.syncNow(id);
    await laptop.core.syncNow(id);
    expect(reveals).toEqual([["K"]]);
  });

  it("turning it off stops syncing; the cloud copy stays", async () => {
    const { vault } = memoryVault();
    const laptop = computer("laptop", vault);
    const { id, dir } = laptop.addProject("site");
    fs.writeFileSync(path.join(dir, "index.html"), "hi\n");
    await laptop.core.setEnabled(id, true);
    const off = await laptop.core.setEnabled(id, false);
    expect(off).toMatchObject({ enabled: false, state: "off", name: "site" });
    await expect(laptop.core.syncNow(id)).rejects.toThrow("isn't on all your computers");
    // On again: the same name, no "site-2".
    expect((await laptop.core.setEnabled(id, true)).name).toBe("site");
  });

  it("a second, different folder with a taken name syncs as name-2", async () => {
    const { vault } = memoryVault();
    const a = computer("a", vault);
    const b = computer("b", vault);
    const first = a.addProject("app");
    fs.writeFileSync(path.join(first.dir, "one.txt"), "1\n");
    await a.core.setEnabled(first.id, true);
    const second = b.addProject("app");
    fs.writeFileSync(path.join(second.dir, "two.txt"), "2\n");
    expect((await b.core.setEnabled(second.id, true)).name).toBe("app-2");
  });

  it("refuses the home folder itself", async () => {
    const { vault } = memoryVault();
    const laptop = computer("laptop", vault);
    laptop.projects.push({ id: "home", title: "Home", workspaceRoot: "~" });
    await expect(laptop.core.setEnabled("home", true)).rejects.toThrow("home folder");
  });
});

const PAST = "2020-01-01T00:00:00.000Z";
const later = () => new Date(Date.now() + 1000).toISOString();
const versions = (dir: string) =>
  fs
    .readFileSync(path.join(dir, ".uno-git", "logs", "refs", "heads", "main"), "utf8")
    .trim()
    .split("\n").length;

describe("on by default", { timeout: 120_000 }, () => {
  it("a new folder in ~/projects syncs by itself, with one line once", async () => {
    const { vault } = memoryVault();
    const laptop = computer("laptop", vault);
    await laptop.core.status();
    const first = laptop.addInProjects("site", later());
    const second = laptop.addInProjects("blog", later());
    const elsewhere = laptop.addProject("downloads");
    fs.writeFileSync(path.join(first.dir, "index.html"), "hi\n");
    fs.writeFileSync(path.join(second.dir, "post.md"), "hi\n");

    await laptop.core.adoptNewProjects();
    expect((await laptop.core.entry(first.id)).enabled).toBe(true);
    expect((await laptop.core.entry(elsewhere.id)).enabled).toBe(false);
    // Not a word before it has really been saved.
    expect((await laptop.core.status()).intro).toBeNull();

    await laptop.core.syncNow(first.id);
    await laptop.core.syncNow(second.id);
    const status = await laptop.core.status();
    expect(status.intro).toEqual({ projectId: first.id, title: "site" });
    await laptop.core.introSeen();
    expect((await laptop.core.status()).intro).toBeNull();
    laptop.core.stop();
  });

  it("what the person turned off stays off", async () => {
    const { vault } = memoryVault();
    const laptop = computer("laptop", vault);
    await laptop.core.status();
    const { id } = laptop.addInProjects("site", later());
    await laptop.core.setEnabled(id, false);
    await laptop.core.adoptNewProjects();
    expect((await laptop.core.entry(id)).enabled).toBe(false);
    laptop.core.stop();
  });

  it("older projects get one question; no is final, nothing turns on silently", async () => {
    const { vault } = memoryVault();
    const laptop = computer("laptop", vault);
    const { id, dir } = laptop.addInProjects("old-site", PAST);
    fs.writeFileSync(path.join(dir, "index.html"), "hi\n");
    await laptop.core.adoptNewProjects();
    expect((await laptop.core.entry(id)).enabled).toBe(false);
    expect((await laptop.core.status()).askAbout).toEqual([{ projectId: id, title: "old-site" }]);

    await laptop.core.answerOld(false);
    expect((await laptop.core.status()).askAbout).toEqual([]);
    expect((await laptop.core.entry(id)).enabled).toBe(false);
    laptop.core.stop();
  });

  it("yes turns the older projects on, and the answer survives a restart", async () => {
    const { vault } = memoryVault();
    const laptop = computer("laptop", vault);
    const { id, dir } = laptop.addInProjects("old-site", PAST);
    fs.writeFileSync(path.join(dir, "index.html"), "hi\n");
    await laptop.core.answerOld(true);
    await laptop.core.adoptionDone();
    expect(await laptop.core.entry(id)).toMatchObject({ enabled: true, state: "synced" });
    laptop.core.stop();

    const again = computer("laptop", vault);
    again.addInProjects("old-other", PAST);
    expect((await again.core.status()).askAbout).toEqual([]);
    again.core.stop();
  });
});

describe("two chats in one folder", { timeout: 120_000 }, () => {
  const turnEnd = async (laptop: ReturnType<typeof computer>, id: string) => {
    laptop.core.touched(id, "turn-end");
    await new Promise((resolve) => setTimeout(resolve, 2_400));
  };

  it("nothing is saved while a chat is working; its end, or the person, saves", async () => {
    const { vault } = memoryVault();
    const laptop = computer("laptop", vault);
    const { id, dir } = laptop.addProject("shared");
    fs.writeFileSync(path.join(dir, "plan.md"), "one\n");
    await laptop.core.setEnabled(id, true);
    const saved = versions(dir);

    // Chat A's turn ends; chat B is half way through this file.
    laptop.busy.add(id);
    fs.writeFileSync(path.join(dir, "plan.md"), "half done by B\n");
    await turnEnd(laptop, id);
    expect(versions(dir)).toBe(saved);

    // B finishes.
    laptop.busy.delete(id);
    await turnEnd(laptop, id);
    expect(versions(dir)).toBe(saved + 1);

    // The person's own "Sync now" doesn't wait.
    laptop.busy.add(id);
    fs.writeFileSync(path.join(dir, "plan.md"), "asked for\n");
    await laptop.core.syncNow(id);
    expect(versions(dir)).toBe(saved + 2);
  });

  it("a stuck chat doesn't stop saving for good", async () => {
    const { vault } = memoryVault();
    const laptop = computer("laptop", vault);
    const { id, dir } = laptop.addProject("stuck");
    fs.writeFileSync(path.join(dir, "plan.md"), "one\n");
    await laptop.core.setEnabled(id, true);
    const saved = versions(dir);
    laptop.busy.add(id);
    fs.writeFileSync(path.join(dir, "plan.md"), "two\n");
    await turnEnd(laptop, id);
    expect(versions(dir)).toBe(saved);
    laptop.clock.shift = 31 * 60_000;
    await turnEnd(laptop, id);
    expect(versions(dir)).toBe(saved + 1);
  });
});

describe("versions, files, keys in files", { timeout: 120_000 }, () => {
  it("shows what waits, and says nothing of the value", async () => {
    const { vault } = memoryVault();
    const laptop = computer("laptop", vault);
    const { id, dir } = laptop.addProject("held");
    fs.writeFileSync(path.join(dir, "plan.md"), "plan\n");
    fs.writeFileSync(path.join(dir, "config.json"), `{ "key": "${FAKE_KEY}" }\n`);
    const entry = await laptop.core.setEnabled(id, true);
    expect(entry).toMatchObject({ state: "synced", held: ["config.json"] });
    expect(JSON.stringify(entry)).not.toContain(FAKE_KEY);
    fs.writeFileSync(path.join(dir, "config.json"), `{ "key": "moved" }\n`);
    expect((await laptop.core.syncNow(id)).held).toEqual([]);
  });

  it("goes back, says who saved, refuses while a chat works, and keeps the row clean", async () => {
    const { vault } = memoryVault();
    const laptop = computer("laptop", vault);
    const { id, dir } = laptop.addProject("timeline");
    fs.writeFileSync(path.join(dir, "plan.md"), "yesterday\n");
    await laptop.core.setEnabled(id, true);
    fs.writeFileSync(path.join(dir, "plan.md"), "today\n");
    await laptop.core.syncNow(id);

    const history = await laptop.core.history(id);
    expect(history.versions).toHaveLength(2);
    expect(history.versions[0]).toMatchObject({ person: "Misha", computer: "laptop", mine: true });
    const yesterday = history.versions.at(-1)?.id ?? "";

    laptop.busy.add(id);
    await expect(laptop.core.restore(id, yesterday)).rejects.toThrow("A chat is working");
    laptop.busy.delete(id);

    await expect(laptop.core.restore(id, "f".repeat(40))).rejects.toThrow("isn't in this project");
    expect((await laptop.core.entry(id)).state).toBe("synced");

    expect(await laptop.core.restore(id, yesterday)).toMatchObject({ state: "synced" });
    expect(fs.readFileSync(path.join(dir, "plan.md"), "utf8")).toBe("yesterday\n");
  });

  it("sorts the folder into what travels and what stays", async () => {
    const { vault } = memoryVault();
    const laptop = computer("laptop", vault);
    const { id, dir } = laptop.addProject("classes");
    fs.writeFileSync(path.join(dir, "plan.md"), "plan\n");
    fs.writeFileSync(path.join(dir, "movie.mov"), "big\n");
    fs.writeFileSync(path.join(dir, ".env"), "A=1\n");
    await laptop.core.setEnabled(id, true);
    expect(await laptop.core.files(id)).toMatchObject({ synced: 2, keyFiles: [".env"] });
    const files = await laptop.core.setLocalOnly(id, "movie.mov", true);
    expect(files.synced).toBe(1);
    expect(files.localOnly).toEqual([{ path: "movie.mov", yours: true }]);
    expect(fs.existsSync(path.join(dir, "movie.mov"))).toBe(true);
    // Right after: the sync it started in the background doesn't get in the way.
    expect((await laptop.core.setLocalOnly(id, "movie.mov", false)).synced).toBe(2);
    await laptop.core.syncNow(id);
  });

  it("the engine's key patterns are the daemon's", async () => {
    const { vault } = memoryVault();
    const laptop = computer("laptop", vault);
    await installSdkFiles(laptop.home);
    const file = path.join(laptop.home, ".uno", "sdk", "js", "uno-sync.mjs");
    const engine = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
      SECRET_PATTERN: RegExp;
    };
    expect(engine.SECRET_PATTERN.source).toBe(SECRET_TOKEN_PATTERN.source);
  });
});

describe("a project with its own repository", { timeout: 120_000 }, () => {
  /** A bare repository stands in for GitHub: no test here reaches a real host. */
  const hostFor = (label: string) => {
    const bare = path.join(root, `${label}-host.git`);
    run(root, "init", "-q", "--bare", "--initial-branch=main", bare);
    return bare;
  };
  const run = (cwd: string, ...args: string[]) => {
    const done = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
    if (done.status !== 0) throw new Error(done.stderr);
    return done.stdout.trim();
  };
  const hostHas = (bare: string, message: string) =>
    run(bare, "log", "--format=%s", "main").includes(message);
  const started = async (at: ReturnType<typeof computer>, name: string) => {
    const dir = path.join(at.home, "projects", name);
    await at.core.startRepository(dir, name);
    const id = `p-${at.projects.length + 1}`;
    at.projects.push({
      id,
      title: name,
      workspaceRoot: dir,
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await at.core.status();
    await at.core.adoptNewProjects();
    return { id, dir };
  };
  const host = {
    provider: "github" as const,
    repository: "misha/site",
    url: "https://github.com/misha/site",
  };

  it("syncs as a repository from the start, and its host is pushed to and pulled from", async () => {
    const { vault } = memoryVault();
    const a = computer("a", vault);
    const { id, dir } = await started(a, "site");
    const bare = hostFor("a");
    run(dir, "remote", "add", "origin", bare);

    const entry = await a.core.hostConnected(id, { ...host, remote: "origin" });
    expect(entry).toMatchObject({ enabled: true, mode: "git", state: "synced", name: "site" });
    expect(entry.host).toEqual({ ...host, remote: "origin" });
    expect(fs.existsSync(path.join(dir, ".uno-git"))).toBe(false);
    expect(hostHas(bare, "Initial commit")).toBe(true);

    fs.writeFileSync(path.join(dir, "page.html"), "hi\n");
    run(dir, "add", "page.html");
    run(dir, "commit", "-q", "-m", "a page");
    await a.core.syncNow(id);
    expect(hostHas(bare, "a page")).toBe(true);
    expect((await a.core.entry(id)).host?.repository).toBe("misha/site");
  });

  it("keeps a key away from the host", async () => {
    const { vault } = memoryVault();
    const a = computer("a", vault);
    const { id, dir } = await started(a, "site");
    const bare = hostFor("a");
    run(dir, "remote", "add", "origin", bare);
    await a.core.hostConnected(id, { ...host, remote: "origin" });

    fs.writeFileSync(path.join(dir, "config.json"), `${FAKE_KEY}\n`);
    run(dir, "add", "config.json");
    run(dir, "commit", "-q", "-m", "with a key");
    const entry = await a.core.syncNow(id);
    expect(entry.held).toContain("config.json");
    expect(JSON.stringify(entry)).not.toContain(FAKE_KEY);
    expect(hostHas(bare, "with a key")).toBe(false);
  });

  it("still goes to its host on a computer with no way to the Uno cloud", async () => {
    const { vault } = memoryVault();
    const a = computer("a", vault, { cloud: false });
    const dir = path.join(a.home, "projects", "site");
    await a.core.startRepository(dir, "site");
    a.projects.push({ id: "p-1", title: "site", workspaceRoot: dir });
    const bare = hostFor("a");
    run(dir, "remote", "add", "origin", bare);

    const entry = await a.core.hostConnected("p-1", { ...host, remote: "origin" });
    expect(entry).toMatchObject({ enabled: true, state: "synced" });
    expect(hostHas(bare, "Initial commit")).toBe(true);
  });

  it("won't start in the home folder or over someone's files", async () => {
    const { vault } = memoryVault();
    const a = computer("a", vault);
    await expect(a.core.startRepository(a.home, "home")).rejects.toThrow(/inside your home/);
    const taken = path.join(a.home, "projects", "taken");
    fs.mkdirSync(taken, { recursive: true });
    fs.writeFileSync(path.join(taken, "mine.txt"), "x");
    await expect(a.core.startRepository(taken, "taken")).rejects.toThrow(/already has files/);
  });
});

describe("chats without a project", { timeout: 120_000 }, () => {
  it("a chat's folder that became a project syncs by itself; ~/chats itself never does", async () => {
    const { vault } = memoryVault();
    const a = computer("a", vault);
    await a.core.status();
    const at = new Date(Date.now() + 60_000).toISOString();
    const chats = path.join(a.home, "chats");
    const folder = path.join(chats, "2026-10-30-a-chat-c3d4e5f6");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "notes.md"), "notes\n");
    a.projects.push(
      { id: "no-project", title: "No project", workspaceRoot: chats, createdAt: at },
      { id: "promoted", title: "A chat", workspaceRoot: folder, createdAt: at },
    );

    await a.core.adoptNewProjects();
    expect((await a.core.entry("promoted")).enabled).toBe(true);
    expect((await a.core.entry("no-project")).enabled).toBe(false);
    a.core.stop();
  });
});

describe("a project shared with this person", { timeout: 120_000 }, () => {
  const TEAM = 12;
  const OWNER = { username: "misha", email: "misha@example.com" };
  const row = (overrides?: Partial<SharedProject>): SharedProject => ({
    id: TEAM,
    name: "notes",
    role: "editor",
    owner: OWNER,
    joinedAt: "2026-10-30T12:00:00.123456Z",
    ...overrides,
  });

  /** What the console keeps for the team: the keys and which of them the owner ticked. */
  function fakeTeams(rows: ReadonlyArray<SharedProject>) {
    const keys = new Map<string, { value: string; version: number }>();
    const given = new Set<string>();
    const reveals: string[][] = [];
    const teams: ProjectTeams = {
      projects: async () => rows,
      keys: (teamId) => {
        expect(teamId).toBe(TEAM);
        return {
          list: async () =>
            [...keys]
              .filter(([name]) => given.has(name))
              .map(([name, item]) => ({ name, version: item.version, updatedAt: null })),
          reveal: async (_project, names) => {
            reveals.push([...(names ?? [])]);
            return Object.fromEntries(
              [...keys]
                .filter(([name]) => given.has(name) && (!names?.length || names.includes(name)))
                .map(([name, item]) => [name, item.value]),
            );
          },
        };
      },
    };
    return { teams, keys, given, reveals };
  }

  function people(options?: { readonly rows?: ReadonlyArray<SharedProject> }) {
    const ownerVault = memoryVault();
    const anyaVault = memoryVault();
    const console_ = fakeTeams(options?.rows ?? [row()]);
    const logged: string[] = [];
    const misha = computer("misha", ownerVault.vault);
    const anya = computer("anya", anyaVault.vault, {
      person: "Anya",
      ownCloud: path.join(root, "anya-cloud"),
      teamCloud: path.join(root, "cloud"),
      teams: console_.teams,
      log: (message, data) => logged.push(`${message} ${JSON.stringify(data ?? {})}`),
    });
    fs.mkdirSync(path.join(root, "anya-cloud"));
    return { misha, anya, anyaVault, ownerVault, console: console_, logged };
  }

  async function ownerProject(misha: ReturnType<typeof computer>) {
    const project = misha.addProject("notes");
    fs.writeFileSync(path.join(project.dir, "plan.md"), "plan\n");
    await misha.core.setEnabled(project.id, true);
    return project;
  }

  const trackedIn = (dir: string) =>
    spawnSync(
      "git",
      ["--git-dir", path.join(dir, ".uno-git"), "ls-tree", "-r", "--name-only", "HEAD"],
      {
        encoding: "utf8",
      },
    ).stdout;

  it("arrives with the keys it was given, in .env and out of git; the rest stay with the owner", async () => {
    const { misha, anya, console: team } = people();
    await ownerProject(misha);
    const secret = "stripe-value-only-in-the-vault";
    team.keys.set("STRIPE_KEY", { value: secret, version: 3 });
    team.keys.set("DB_URL", { value: "not-for-anya", version: 1 });
    team.given.add("STRIPE_KEY");

    const { projectId, entry } = await anya.core.getHere("notes", TEAM);

    expect(entry).toMatchObject({
      enabled: true,
      name: "notes",
      state: "synced",
      team: { id: TEAM, owner: "misha" },
    });
    const there = path.join(anya.home, "projects", "notes");
    expect(fs.readFileSync(path.join(there, "plan.md"), "utf8")).toBe("plan\n");
    expect(fs.readFileSync(path.join(there, ".env"), "utf8")).toBe(`STRIPE_KEY=${secret}\n`);
    expect(mode(path.join(there, ".env"))).toBe(0o600);

    await anya.core.syncNow(projectId);
    expect(trackedIn(there)).not.toContain(".env");
    const cloudFiles = spawnSync("grep", ["-rl", secret, path.join(root, "cloud")], {
      encoding: "utf8",
    });
    expect(cloudFiles.stdout).toBe("");
  });

  it("syncs both ways and brings newly given keys, asking only for what changed", async () => {
    const { misha, anya, console: team } = people();
    const project = await ownerProject(misha);
    const { projectId } = await anya.core.getHere("notes", TEAM);
    const there = path.join(anya.home, "projects", "notes");

    fs.writeFileSync(path.join(there, "from-anya.md"), "hi\n");
    expect(await anya.core.syncNow(projectId)).toMatchObject({ state: "synced" });
    await misha.core.syncNow(project.id);
    expect(fs.readFileSync(path.join(project.dir, "from-anya.md"), "utf8")).toBe("hi\n");

    fs.writeFileSync(path.join(project.dir, "from-misha.md"), "back\n");
    await misha.core.syncNow(project.id);
    team.keys.set("STRIPE_KEY", { value: "v1", version: 1 });
    team.given.add("STRIPE_KEY");
    await anya.core.syncNow(projectId);
    expect(fs.readFileSync(path.join(there, "from-misha.md"), "utf8")).toBe("back\n");
    expect(fs.readFileSync(path.join(there, ".env"), "utf8")).toBe("STRIPE_KEY=v1\n");
    expect(team.reveals).toEqual([["STRIPE_KEY"]]);

    await anya.core.syncNow(projectId);
    expect(team.reveals).toHaveLength(1);

    team.keys.set("STRIPE_KEY", { value: "v2", version: 2 });
    await anya.core.syncNow(projectId);
    expect(fs.readFileSync(path.join(there, ".env"), "utf8")).toBe("STRIPE_KEY=v2\n");
  });

  it("keys added here stay here: nothing reaches her vault or the owner's", async () => {
    const { misha, anya, anyaVault, ownerVault } = people();
    await ownerProject(misha);
    const { projectId } = await anya.core.getHere("notes", TEAM);
    const there = path.join(anya.home, "projects", "notes");

    await anya.core.setEnabled(projectId, false);
    fs.writeFileSync(path.join(there, ".env"), "ALREADY_HERE=mine\n");
    await anya.core.setEnabled(projectId, true);
    await anya.core.secretSet(projectId, "MY_OWN", "only-here");
    await anya.core.secretWritten({
      cwd: there,
      file: ".env",
      name: "REQUESTED",
      value: "asked-for",
    });

    expect([...anyaVault.projects.values()].flatMap((keys) => [...keys.keys()])).toEqual([]);
    expect([...ownerVault.projects.values()].flatMap((keys) => [...keys.keys()])).toEqual([]);
    const list = await anya.core.secretsList(projectId);
    expect(list.secrets.map((secret) => secret.name)).toEqual(["ALREADY_HERE", "MY_OWN"]);
    expect(list.secrets.every((secret) => !secret.inVault && secret.inFile)).toBe(true);
    expect(fs.readFileSync(path.join(there, ".env"), "utf8")).toContain("MY_OWN=only-here");
  });

  it("a given key can't be removed here, where the next sync would bring it back", async () => {
    const { misha, anya, console: team } = people();
    await ownerProject(misha);
    team.keys.set("STRIPE_KEY", { value: "v1", version: 1 });
    team.given.add("STRIPE_KEY");
    const { projectId } = await anya.core.getHere("notes", TEAM);
    await anya.core.secretSet(projectId, "MY_OWN", "mine");

    await expect(anya.core.secretRemove(projectId, "STRIPE_KEY")).rejects.toThrow(
      /misha gave you this key/,
    );
    await anya.core.secretRemove(projectId, "MY_OWN");
    const there = path.join(anya.home, "projects", "notes");
    expect(fs.readFileSync(path.join(there, ".env"), "utf8")).toBe("STRIPE_KEY=v1\n");
  });

  it("shows up on another computer, by the owner's name, until it's here", async () => {
    const { misha, anya } = people();
    await ownerProject(misha);

    const seen = await anya.core.status();
    expect(seen.elsewhere).toEqual([
      expect.objectContaining({
        name: "notes",
        from: "misha",
        team: { id: TEAM, owner: "misha" },
      }),
    ]);

    await anya.core.getHere("notes", TEAM);
    expect((await anya.core.status()).elsewhere).toEqual([]);
  });

  it("the owner's own row of a team isn't offered back, and a project with nothing saved waits", async () => {
    const { misha, anya } = people({
      rows: [row({ role: "owner" }), row({ id: 13, name: "empty" })],
    });
    await ownerProject(misha);
    expect((await anya.core.status()).elsewhere).toEqual([
      expect.objectContaining({ name: "empty", waiting: true, team: { id: 13, owner: "misha" } }),
    ]);
    await expect(anya.core.getHere("notes", TEAM)).rejects.toThrow(/isn't shared with you/);
    await expect(anya.core.getHere("empty", 13)).rejects.toThrow(/Nothing is saved in empty yet/);
    expect(anya.projects).toEqual([]);
  });

  it("isn't taken on trust: a project the console doesn't list doesn't come", async () => {
    const { misha, anya } = people({ rows: [] });
    await ownerProject(misha);
    await expect(anya.core.getHere("notes", TEAM)).rejects.toThrow(/isn't shared with you/);
    expect(anya.projects).toEqual([]);
  });

  it("with teams off, nothing is different", async () => {
    const vault = memoryVault();
    const plain = computer("plain", vault.vault);
    const off = computer("off", vault.vault, { teams: fakeTeams([]).teams });
    const project = await ownerProject(plain);

    expect(await off.core.status()).toEqual(await computer("third", vault.vault).core.status());
    const here = await off.core.getHere("notes");
    expect(here.entry).toMatchObject({ state: "synced" });
    expect(here.entry).not.toHaveProperty("team");
    expect(await plain.core.entry(project.id)).not.toHaveProperty("team");
  });

  it("a project of their own by the same name stays apart", async () => {
    const { misha, anya, anyaVault } = people();
    await ownerProject(misha);
    const mine = anya.addProject("notes");
    fs.writeFileSync(path.join(mine.dir, "plan.md"), "my own\n");
    fs.writeFileSync(path.join(mine.dir, ".env"), "MINE=1\n");
    await anya.core.setEnabled(mine.id, true);

    // Her own is synced under the same name: the shared one still counts as elsewhere.
    expect((await anya.core.status()).elsewhere.map((item) => item.team?.id)).toEqual([TEAM]);
    const { projectId } = await anya.core.getHere("notes", TEAM);
    expect(projectId).not.toBe(mine.id);
    const there = path.join(anya.home, "projects", "notes");
    expect(fs.readFileSync(path.join(there, "plan.md"), "utf8")).toBe("plan\n");
    expect([...(anyaVault.projects.get("notes")?.keys() ?? [])]).toEqual(["MINE"]);
  });

  it("someone else's change to the same file: the line and Bring mine back, in the real flow", async () => {
    const { misha, anya } = people();
    const project = await ownerProject(misha);
    const { projectId } = await anya.core.getHere("notes", TEAM);
    const there = path.join(anya.home, "projects", "notes");

    fs.writeFileSync(path.join(project.dir, "plan.md"), "misha's\n");
    await misha.core.syncNow(project.id);
    fs.writeFileSync(path.join(there, "plan.md"), "anya's\n");
    const anyas = await anya.core.syncNow(projectId);
    expect(anyas.conflict).toMatchObject({ person: "Misha", kept: { "plan.md": "mine" } });

    const mishas = await misha.core.syncNow(project.id);
    expect(mishas.state).toBe("conflict");
    expect(mishas.conflict).toMatchObject({ person: "Anya", kept: { "plan.md": "theirs" } });
    expect(fs.readFileSync(path.join(project.dir, "plan.md"), "utf8")).toBe("anya's\n");

    const back = await misha.core.resolve(project.id, "mine");
    expect(back).toMatchObject({ state: "synced", conflict: null });
    expect(fs.readFileSync(path.join(project.dir, "plan.md"), "utf8")).toBe("misha's\n");

    await anya.core.resolve(projectId, "dismiss");
    expect(fs.readFileSync(path.join(there, "plan.md"), "utf8")).toBe("misha's\n");
  });

  it("names the owner when their storage is full", async () => {
    const { misha, anya } = people();
    await ownerProject(misha);
    const { projectId } = await anya.core.getHere("notes", TEAM);
    const there = path.join(anya.home, "projects", "notes");

    anya.env.UNO_GIT_FAKE_FAULTS = "owner-full";
    fs.writeFileSync(path.join(there, "x.md"), "x\n");
    const full = await anya.core.syncNow(projectId);
    expect(full.state).toBe("error");
    expect(full.message).toBe("misha's Uno cloud storage is full. Ask them to free up space.");

    delete anya.env.UNO_GIT_FAKE_FAULTS;
    expect(await anya.core.syncNow(projectId)).toMatchObject({ state: "synced" });
  });

  it("removed from the project: says so, keeps the copy, doesn't touch their own cloud", async () => {
    const { misha, anya, anyaVault } = people();
    await ownerProject(misha);
    const { projectId } = await anya.core.getHere("notes", TEAM);
    const there = path.join(anya.home, "projects", "notes");

    anya.env.UNO_GIT_FAKE_FAULTS = "not-shared";
    fs.writeFileSync(path.join(there, "plan.md"), "still mine here\n");
    const gone = await anya.core.syncNow(projectId);

    expect(gone.state).toBe("error");
    expect(gone.message).toBe(
      "You no longer have access to this project. Your copy stays on this computer.",
    );
    expect(fs.readFileSync(path.join(there, "plan.md"), "utf8")).toBe("still mine here\n");
    expect(fs.readdirSync(path.join(root, "anya-cloud"))).toEqual([]);
    expect([...anyaVault.projects.values()].flatMap((keys) => [...keys.keys()])).toEqual([]);
  });

  describe("coming by itself to the first computer opened", () => {
    /** Anya's two computers: the same console, the same owner's cloud, her own cloud. */
    function twoComputers() {
      const { misha, anya, console: team } = people();
      const second = computer("anya-desktop", memoryVault().vault, {
        person: "Anya",
        ownCloud: path.join(root, "anya-cloud"),
        teamCloud: path.join(root, "cloud"),
        teams: team.teams,
      });
      return { misha, anya, second, console: team };
    }
    const arrivals = () => {
      const dir = path.join(root, "cloud", ".uno-git", "notes", "arrivals");
      return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    };

    it("accepted in the console: the project comes here, once, with its keys", async () => {
      const { misha, anya, console: team } = twoComputers();
      team.keys.set("STRIPE_KEY", { value: "v1", version: 1 });
      team.given.add("STRIPE_KEY");
      await ownerProject(misha);

      const listed = (await anya.core.status()).elsewhere.find((item) => item.team);
      expect(listed).toMatchObject({ name: "notes", team: { id: TEAM, owner: "misha" } });
      expect(listed).not.toHaveProperty("waiting");

      const first = await anya.core.arrive("notes", TEAM);
      expect(first).toMatchObject({
        outcome: "here",
        entry: { enabled: true, team: { id: TEAM, owner: "misha" } },
      });
      expect(anya.projects).toHaveLength(1);
      const there = path.join(anya.home, "projects", "notes");
      expect(fs.readFileSync(path.join(there, "plan.md"), "utf8")).toBe("plan\n");
      expect(fs.readFileSync(path.join(there, ".env"), "utf8")).toContain("STRIPE_KEY=v1");
      expect((await anya.core.status()).elsewhere).toEqual([]);

      // Asked again (another window): nothing more happens.
      expect(await anya.core.arrive("notes", TEAM)).toMatchObject({ outcome: "here" });
      expect(anya.projects).toHaveLength(1);
      expect(arrivals()).toEqual(["20261030120000123456"]);
    });

    it("the second computer keeps it as a row with Get it here", async () => {
      const { misha, anya, second } = twoComputers();
      await ownerProject(misha);
      await anya.core.arrive("notes", TEAM);

      expect(await second.core.arrive("notes", TEAM)).toEqual({ outcome: "taken" });
      expect(second.projects).toEqual([]);
      const rows = (await second.core.status()).elsewhere;
      expect(rows.map((item) => item.team?.id)).toEqual([TEAM]);
      expect(rows[0]).not.toHaveProperty("waiting");

      const byHand = await second.core.getHere("notes", TEAM);
      expect(byHand.entry).toMatchObject({ enabled: true, name: "notes" });
      expect(second.projects).toHaveLength(1);
    });

    it("two computers opened at the same moment: one takes it", async () => {
      const { misha, anya, second } = twoComputers();
      await ownerProject(misha);
      const results = await Promise.all([
        anya.core.arrive("notes", TEAM),
        second.core.arrive("notes", TEAM),
      ]);
      expect(results.map((result) => result.outcome).toSorted()).toEqual(["here", "taken"]);
      expect(anya.projects.length + second.projects.length).toBe(1);
      expect(arrivals()).toHaveLength(1);
    });

    it("two windows of one computer and a click meanwhile: one folder", async () => {
      const { misha, anya } = twoComputers();
      await ownerProject(misha);
      await Promise.all([
        anya.core.arrive("notes", TEAM),
        anya.core.arrive("notes", TEAM),
        anya.core.getHere("notes", TEAM),
      ]);
      expect(anya.projects).toHaveLength(1);
      expect(fs.readdirSync(path.join(anya.home, "projects"))).toEqual(["notes"]);
    });

    it("Get it here by hand counts: another computer doesn't bring it as well", async () => {
      const { misha, anya, second } = twoComputers();
      await ownerProject(misha);
      await anya.core.getHere("notes", TEAM);
      expect(await second.core.arrive("notes", TEAM)).toEqual({ outcome: "taken" });
    });

    it("each person's turn is their own", async () => {
      const { misha, anya } = twoComputers();
      await ownerProject(misha);
      const other = computer("gleb", memoryVault().vault, {
        ownCloud: path.join(root, "gleb-cloud"),
        teamCloud: path.join(root, "cloud"),
        teams: fakeTeams([row({ joinedAt: "2026-10-30T12:00:01Z" })]).teams,
      });
      fs.mkdirSync(path.join(root, "gleb-cloud"));
      await anya.core.arrive("notes", TEAM);
      expect(await other.core.arrive("notes", TEAM)).toMatchObject({ outcome: "here" });
      expect(arrivals()).toHaveLength(2);
    });

    it("nothing saved yet: it says so, takes no turn, and comes with the first version", async () => {
      const { misha, anya, second } = twoComputers();
      expect(await anya.core.arrive("notes", TEAM)).toEqual({ outcome: "waiting" });
      expect(await second.core.arrive("notes", TEAM)).toEqual({ outcome: "waiting" });
      expect(anya.projects).toEqual([]);
      expect(arrivals()).toEqual([]);
      expect((await anya.core.status()).elsewhere).toEqual([
        expect.objectContaining({ name: "notes", waiting: true, from: "misha", updatedAt: null }),
      ]);

      await ownerProject(misha);
      anya.clock.shift += 3 * 60_000;
      const rows = (await anya.core.status()).elsewhere;
      expect(rows.map((item) => item.name)).toEqual(["notes"]);
      expect(rows[0]).not.toHaveProperty("waiting");
      expect(await second.core.arrive("notes", TEAM)).toMatchObject({ outcome: "here" });
      expect(await anya.core.arrive("notes", TEAM)).toEqual({ outcome: "taken" });
    });

    it("no space: a plain line, the row stays, Get it here works afterwards", async () => {
      let full = true;
      const { misha } = people();
      const anya = computer("anya-laptop", memoryVault().vault, {
        person: "Anya",
        ownCloud: path.join(root, "anya-cloud"),
        teamCloud: path.join(root, "cloud"),
        teams: fakeTeams([row()]).teams,
        engine: (engine) => ({
          ...engine,
          getProject: async (input, ctx) => {
            if (full) throw new Error("ENOSPC: no space left on device, mkdir '/x'");
            return engine.getProject(input, ctx);
          },
        }),
      });
      await ownerProject(misha);

      await expect(anya.core.arrive("notes", TEAM)).rejects.toThrow(
        "There isn't enough free space on this computer for notes. Free some up, then choose Get it here.",
      );
      expect(anya.projects).toEqual([]);
      expect((await anya.core.status()).elsewhere.map((item) => item.team?.id)).toEqual([TEAM]);

      full = false;
      await anya.core.getHere("notes", TEAM);
      expect(anya.projects).toHaveLength(1);
      expect((await anya.core.status()).elsewhere).toEqual([]);
    });

    it("no connection or a full owner's cloud: it says so and nothing is taken for good", async () => {
      const { misha, anya } = twoComputers();
      await ownerProject(misha);
      const rows = (await anya.core.status()).elsewhere;
      expect(rows).toHaveLength(1);

      anya.env.UNO_GIT_FAKE_FAULTS = "owner-full";
      await expect(anya.core.arrive("notes", TEAM)).rejects.toThrow(
        "misha's Uno cloud storage is full. Ask them to free up space.",
      );
      expect(anya.projects).toEqual([]);
      expect(arrivals()).toEqual([]);
      expect((await anya.core.status()).elsewhere).toEqual(rows);

      delete anya.env.UNO_GIT_FAKE_FAULTS;
      expect(await anya.core.arrive("notes", TEAM)).toMatchObject({ outcome: "here" });
    });

    it("a look at the cloud that fails doesn't take the row away", async () => {
      let offline = false;
      const { misha } = people();
      const anya = computer("anya-laptop", memoryVault().vault, {
        person: "Anya",
        ownCloud: path.join(root, "anya-cloud"),
        teamCloud: path.join(root, "cloud"),
        teams: fakeTeams([row()]).teams,
        engine: (engine) => ({
          ...engine,
          peekSharedProject: async (input, ctx) => {
            if (offline) throw new Error("Couldn't reach the Uno console.");
            return engine.peekSharedProject(input, ctx);
          },
        }),
      });
      await ownerProject(misha);
      const rows = (await anya.core.status()).elsewhere;
      expect(rows).toHaveLength(1);

      offline = true;
      anya.clock.shift += 3 * 60_000;
      expect((await anya.core.status()).elsewhere).toEqual(rows);
      await expect(anya.core.arrive("notes", TEAM)).rejects.toThrow(
        "Couldn't reach the Uno console.",
      );
      expect(anya.projects).toEqual([]);
      expect(arrivals()).toEqual([]);
    });

    it("a project the person deleted here doesn't come back", async () => {
      const { misha, anya, second } = twoComputers();
      await ownerProject(misha);
      const { entry } = await anya.core.arrive("notes", TEAM);
      anya.projects.length = 0;
      await anya.core.syncNow(entry!.projectId);
      expect((await anya.core.entry(entry!.projectId)).enabled).toBe(false);

      expect((await anya.core.status()).elsewhere).toEqual([]);
      expect(await anya.core.arrive("notes", TEAM)).toEqual({ outcome: "taken" });
      expect(anya.projects).toEqual([]);

      // Nor on a computer that opens later, or this one after forgetting its state.
      expect(await second.core.arrive("notes", TEAM)).toEqual({ outcome: "taken" });
      fs.rmSync(path.join(anya.home, ".t3", "userdata", "project-sync.json"));
      const reinstalled = computer("anya", memoryVault().vault, {
        person: "Anya",
        ownCloud: path.join(root, "anya-cloud"),
        teamCloud: path.join(root, "cloud"),
        teams: fakeTeams([row()]).teams,
      });
      expect(await reinstalled.core.arrive("notes", TEAM)).toEqual({ outcome: "taken" });
      expect(reinstalled.projects).toEqual([]);
    });

    it("invited again after being removed: it comes once more", async () => {
      const { misha, anya } = twoComputers();
      await ownerProject(misha);
      await anya.core.arrive("notes", TEAM);
      const again = computer("anya-new", memoryVault().vault, {
        person: "Anya",
        ownCloud: path.join(root, "anya-cloud"),
        teamCloud: path.join(root, "cloud"),
        teams: fakeTeams([row({ joinedAt: "2026-11-02T08:00:00Z" })]).teams,
      });
      expect(await again.core.arrive("notes", TEAM)).toMatchObject({ outcome: "here" });
    });

    it("no longer shared, or teams off: nothing shows and nothing is said", async () => {
      const { misha } = people({ rows: [] });
      await ownerProject(misha);
      const off = computer("off", memoryVault().vault, {
        ownCloud: path.join(root, "off-cloud"),
        teamCloud: path.join(root, "cloud"),
        teams: fakeTeams([]).teams,
      });
      fs.mkdirSync(path.join(root, "off-cloud"));
      expect((await off.core.status()).elsewhere).toEqual([]);
      expect(await off.core.arrive("notes", TEAM)).toEqual({ outcome: "gone" });
      expect(off.projects).toEqual([]);
      expect(arrivals()).toEqual([]);
    });

    it("an answer without the date of joining: stays a row, doesn't come by itself", async () => {
      const { misha, anya } = people({ rows: [row({ joinedAt: null })] });
      await ownerProject(misha);
      expect(await anya.core.arrive("notes", TEAM)).toEqual({ outcome: "taken" });
      expect(anya.projects).toEqual([]);
    });
  });

  it("no value in logs, in errors, or in what the interface gets", async () => {
    const secret = "very-secret-value-1234";
    const { misha, anya, console: team, logged } = people();
    await ownerProject(misha);
    team.keys.set("STRIPE_KEY", { value: secret, version: 1 });
    team.given.add("STRIPE_KEY");
    const { projectId } = await anya.core.getHere("notes", TEAM);
    await anya.core.syncNow(projectId);

    const shown = JSON.stringify([
      await anya.core.status(),
      await anya.core.entry(projectId),
      await anya.core.secretsList(projectId),
    ]);
    expect(shown).not.toContain(secret);
    expect(logged.join("\n")).not.toContain(secret);
  });
});

describe("personName", () => {
  it("prefers a chosen name over a generated one", () => {
    expect(personName({ username: "misha", email: "m@x.io" })).toBe("misha");
    expect(personName({ username: "uno_1058", email: "anna@x.io" })).toBe("anna");
    expect(personName({ username: "uno_1058", email: null })).toBeNull();
    expect(personName({})).toBeNull();
  });
});

describe("removeEnvName", () => {
  it("drops the assignments of that name only", () => {
    expect(removeEnvName("A=1\nexport B=2\n# B=3\nBB=4\n", "B")).toBe("A=1\n# B=3\nBB=4\n");
  });
});
