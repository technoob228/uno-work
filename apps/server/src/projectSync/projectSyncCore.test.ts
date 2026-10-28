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

import {
  createProjectSyncCore,
  removeEnvName,
  type ProjectRef,
  type SyncEngine,
} from "./projectSyncCore.ts";
import type { ProjectVault } from "./vaultProjectSecrets.ts";

let root = "";

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
      now: () => Date.now(),
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
  return { home, core, projects, addProject };
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

describe("removeEnvName", () => {
  it("drops the assignments of that name only", () => {
    expect(removeEnvName("A=1\nexport B=2\n# B=3\nBB=4\n", "B")).toBe("A=1\n# B=3\nBB=4\n");
  });
});
