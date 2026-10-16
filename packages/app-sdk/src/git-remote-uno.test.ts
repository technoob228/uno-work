/**
 * git-remote-uno against a fake cloud (UNO_GIT_FAKE_STORAGE_DIR): real git in
 * temp folders, a temp HOME and no system config, the helper found on PATH
 * exactly as git finds it on a cloud computer.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FAKE_STORAGE_ENV,
  NOT_CLOUD,
  folderStorage,
  listProjects,
  machineCredentials,
  projectNameOf,
  readRemote,
  slugName,
} from "./git-remote-uno.mjs";

const helperModule = path.join(path.dirname(fileURLToPath(import.meta.url)), "git-remote-uno.mjs");

let root = "";
let cloud = "";
let env: NodeJS.ProcessEnv = {};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uno-git-"));
  cloud = path.join(root, "cloud");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  for (const dir of [cloud, bin, home]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "git-remote-uno"),
    `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(helperModule).href)}).then((h) => h.main(process.argv.slice(2)));\n`,
    { mode: 0o755 },
  );
  env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    [FAKE_STORAGE_ENV]: cloud,
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  return {
    code: result.status ?? 1,
    out: `${result.stdout}${result.stderr}`,
    stdout: result.stdout,
  };
}

function ok(cwd: string, ...args: string[]) {
  const result = git(cwd, ...args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.out}`);
  return result.stdout.trim();
}

/** A new repository with one commit, remote `uno` → uno::<name>. */
function newRepo(dirName: string, name: string) {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir);
  ok(dir, "init", "-q", "-b", "main");
  commit(dir, "readme.md", "hello\n", "first");
  ok(dir, "remote", "add", "uno", `uno::${name}`);
  return dir;
}

function commit(dir: string, file: string, content: string | Buffer, message: string) {
  fs.writeFileSync(path.join(dir, file), content);
  ok(dir, "add", file);
  ok(dir, "commit", "-q", "-m", message);
  return ok(dir, "rev-parse", "HEAD");
}

function cloneTo(dirName: string, name: string) {
  const dir = path.join(root, dirName);
  ok(root, "clone", "-q", "-o", "uno", `uno::${name}`, dir);
  return dir;
}

const state = (name: string) => readRemote(folderStorage(cloud), name);
const bundleFiles = (name: string) =>
  fs.readdirSync(path.join(cloud, ".uno-git", name, "bundles")).toSorted();

describe("names", () => {
  it("reads uno::<name> and makes names from folder names", () => {
    expect(projectNameOf("uno::notes")).toBe("notes");
    expect(projectNameOf("notes")).toBe("notes");
    expect(projectNameOf("uno::Notes")).toBeNull();
    expect(projectNameOf("uno::../x")).toBeNull();
    expect(projectNameOf("uno::")).toBeNull();
    expect(slugName("My App (v2)")).toBe("my-app-v2");
    expect(slugName(".hidden")).toBe("hidden");
    expect(slugName("Проект")).toBeNull();
  });
});

describe("machineCredentials", () => {
  it("reads the box key from the settings the daemon names, else says nothing", () => {
    const home = path.join(root, "home");
    expect(machineCredentials({ home }, [])).toBeNull();
    const settings = path.join(root, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ uno: { boxToken: " k ", boxId: 7, apiKey: "a" } }));
    fs.mkdirSync(path.join(home, ".uno", "sdk"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".uno", "sdk", "daemon.json"),
      JSON.stringify({ settingsPath: settings, consoleUrl: "http://127.0.0.1:9/" }),
    );
    expect(machineCredentials({ home }, [])).toEqual({
      token: "k",
      boxId: 7,
      consoleUrl: "http://127.0.0.1:9",
    });
    // A laptop signed in with an account key only: not a cloud computer.
    fs.writeFileSync(settings, JSON.stringify({ uno: { apiKey: "a" } }));
    expect(machineCredentials({ home }, [])).toBeNull();
    expect(NOT_CLOUD).toContain("Uno cloud computers");
  });
});

describe("git-remote-uno", () => {
  it("pushes a new repository, clones it elsewhere, and pushes on top incrementally", async () => {
    const a = newRepo("a", "notes");
    commit(a, "data.bin", randomBytes(64 * 1024), "data");
    expect(git(a, "push", "-u", "uno", "main").code).toBe(0);
    ok(a, "tag", "v1");
    ok(a, "push", "uno", "--tags");

    const first = await state("notes");
    expect(first.head).toBe("refs/heads/main");
    expect(first.refs["refs/heads/main"]).toBe(ok(a, "rev-parse", "HEAD"));
    expect(first.refs["refs/tags/v1"]).toBe(ok(a, "rev-parse", "v1"));
    expect(first.updatedBy?.hostname).toBe(os.hostname());

    const b = cloneTo("b", "notes");
    expect(ok(b, "rev-parse", "HEAD")).toBe(ok(a, "rev-parse", "HEAD"));
    expect(ok(b, "tag")).toBe("v1");
    expect(ok(b, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("uno/main");

    const head = commit(b, "readme.md", "hello again\n", "second");
    ok(b, "push", "uno");
    const second = await state("notes");
    expect(second.refs["refs/heads/main"]).toBe(head);
    // Only what's new went up: a small bundle on top of the first.
    expect(second.bundles).toHaveLength(2);
    expect(second.bundles[1]!.prerequisites).toEqual([first.refs["refs/heads/main"]]);
    expect(second.bundles[1]!.size).toBeLessThan(second.bundles[0]!.size / 4);

    ok(a, "pull", "-q", "--ff-only");
    expect(ok(a, "rev-parse", "HEAD")).toBe(head);
    expect(await listProjects(folderStorage(cloud))).toMatchObject([
      { name: "notes", branches: 1, head: "refs/heads/main" },
    ]);
  });

  it("rejects a push that isn't a fast-forward, takes it when forced", async () => {
    const a = newRepo("a", "site");
    ok(a, "push", "-u", "uno", "main");
    const b = cloneTo("b", "site");
    const fromB = commit(b, "b.txt", "b\n", "from b");
    ok(b, "push", "uno");

    // A hasn't seen B's commit: git refuses before anything is uploaded.
    commit(a, "a.txt", "a\n", "from a");
    const rejected = git(a, "push", "uno", "main");
    expect(rejected.code).not.toBe(0);
    expect(rejected.out).toMatch(/rejected/);
    // A fetched it but still diverges: non-fast-forward.
    ok(a, "fetch", "-q", "uno");
    const again = git(a, "push", "uno", "main");
    expect(again.code).not.toBe(0);
    expect(again.out).toMatch(/non-fast-forward|rejected/);
    expect((await state("site")).refs["refs/heads/main"]).toBe(fromB);

    const forced = ok(a, "rev-parse", "HEAD");
    ok(a, "push", "--force", "uno", "main");
    expect((await state("site")).refs["refs/heads/main"]).toBe(forced);
    ok(b, "fetch", "-q", "uno");
    expect(ok(b, "rev-parse", "uno/main")).toBe(forced);
  });

  it("deletes a branch, and an empty cloud copy lists nothing", async () => {
    const a = newRepo("a", "app");
    ok(a, "push", "uno", "main");
    // Same commit under another name: nothing new to upload.
    ok(a, "branch", "feature");
    ok(a, "push", "uno", "feature");
    const both = await state("app");
    expect(Object.keys(both.refs).toSorted()).toEqual(["refs/heads/feature", "refs/heads/main"]);
    expect(both.bundles).toHaveLength(1);

    ok(a, "push", "uno", ":feature");
    expect(Object.keys((await state("app")).refs)).toEqual(["refs/heads/main"]);
    expect(ok(a, "ls-remote", "uno")).not.toContain("feature");

    ok(a, "push", "uno", ":main");
    const empty = await state("app");
    expect(empty.refs).toEqual({});
    expect(empty.bundles).toEqual([]);
    expect(bundleFiles("app")).toEqual([]);
  });

  it("packs many bundles into one full bundle, and a clone still works", async () => {
    const a = newRepo("a", "big");
    commit(a, "base.bin", randomBytes(32 * 1024), "base");
    ok(a, "push", "uno", "main");
    for (let index = 0; index < 3; index += 1) {
      commit(a, `n${index}.txt`, `${index}\n`, `small ${index}`);
      ok(a, "push", "uno", "main");
    }
    expect((await state("big")).bundles).toHaveLength(4);

    // New content bigger than the full bundle: everything is packed again.
    commit(a, "more.bin", randomBytes(48 * 1024), "more");
    ok(a, "push", "uno", "main");
    const packed = await state("big");
    expect(packed.bundles).toHaveLength(1);
    expect(packed.bundles[0]!.prerequisites).toEqual([]);
    expect(packed.bundles[0]!.tips).toEqual(packed.refs);
    expect(bundleFiles("big")).toEqual([path.basename(packed.bundles[0]!.key)]);

    const b = cloneTo("b", "big");
    expect(ok(b, "rev-parse", "HEAD")).toBe(ok(a, "rev-parse", "HEAD"));
    expect(ok(b, "rev-list", "--count", "HEAD")).toBe("6");
  });

  it("says what's wrong with a bad name, and clones an empty project as empty", () => {
    const bad = git(root, "ls-remote", "uno::Bad Name");
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("isn't an Uno project name");
    const empty = git(root, "clone", "uno::nothing-here", path.join(root, "e"));
    expect(empty.code).toBe(0);
    expect(empty.out).toMatch(/empty repository/);
  });
});
