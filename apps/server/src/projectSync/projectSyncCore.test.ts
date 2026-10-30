/**
 * Two computers' daemons, end to end: the real sync engine and git helper
 * (packages/app-sdk), the cloud in a folder, the Uno vault faked in memory.
 */
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
import type { ProjectVault } from "./vaultProjectSecrets.ts";

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

function computer(label: string, vault: ProjectVault) {
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
    UNO_GIT_FAKE_STORAGE_DIR: path.join(root, "cloud"),
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
      return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as SyncEngine;
    },
    available: async () => true,
    person: async () => "Misha",
    turnRunning: async (projectId) => busy.has(projectId),
    vault,
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
  return { home, core, projects, addProject, addInProjects, busy, clock };
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
    expect(history.versions[0]).toMatchObject({ person: "Misha", computer: "laptop" });
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
    expect((await laptop.core.setLocalOnly(id, "movie.mov", false)).synced).toBe(2);
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
