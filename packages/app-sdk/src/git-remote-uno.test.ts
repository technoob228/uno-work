/**
 * git-remote-uno against a fake cloud (UNO_GIT_FAKE_STORAGE_DIR): real git in
 * temp folders, a temp HOME and no system config, the helper found on PATH
 * exactly as git finds it on a cloud computer.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FAKE_FAULTS_ENV,
  FAKE_STORAGE_DELAY_ENV,
  FAKE_STORAGE_ENV,
  FAKE_UPLOAD_MINUTES_ENV,
  OUTCOME_UNKNOWN,
  commitState,
  pruneLog,
  bundleTime,
  collectBundles,
  logKey,
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

/** git in the background (two computers at once). */
function gitAsync(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env: { ...env, [FAKE_STORAGE_DELAY_ENV]: "300" } });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

/** Make unnamed bundle files two hours old: the time in their key and storage's. */
function ageUnnamedBundles(name: string, named: ReadonlyArray<string>) {
  const dir = path.join(cloud, ".uno-git", name, "bundles");
  const old = new Date(Date.now() - 2 * 3600_000).toISOString().replace(/[:.]/g, "-");
  for (const file of fs.readdirSync(dir)) {
    if (named.some((key) => key.endsWith(`/${file}`))) continue;
    const renamed = path.join(dir, file.replace(/^[^Z]+Z/, old));
    fs.renameSync(path.join(dir, file), renamed);
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(renamed, twoHoursAgo, twoHoursAgo);
  }
}

/** Every bundle the current state names is there, and a fresh clone has every ref. */
async function expectConsistent(name: string) {
  const current = await state(name);
  for (const bundle of current.bundles) {
    expect(fs.existsSync(path.join(cloud, bundle.key))).toBe(true);
  }
  const check = path.join(root, `check-${Math.random().toString(16).slice(2)}`);
  ok(root, "clone", "-q", "--no-checkout", `uno::${name}`, check);
  for (const [ref, id] of Object.entries(current.refs)) {
    expect(ok(check, "cat-file", "-t", id)).toMatch(/commit|tag/);
    expect(ref).toMatch(/^refs\//);
  }
  return current;
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
    // A laptop with the account key in Uno Work: its projects sync too.
    fs.writeFileSync(settings, JSON.stringify({ uno: { apiKey: " acct " } }));
    expect(machineCredentials({ home }, [])).toEqual({
      token: "acct",
      boxId: null,
      consoleUrl: "http://127.0.0.1:9",
    });
    // An Uno AI key isn't an account key: nothing to sign in with.
    fs.writeFileSync(settings, JSON.stringify({ uno: { apiKey: "unollm_x" } }));
    expect(machineCredentials({ home }, [])).toBeNull();
    expect(NOT_CLOUD).toContain("Uno account");
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
    // The file stays until it is an hour old (a push in flight may name it).
    expect(bundleFiles("app")).toHaveLength(1);
    expect(await collectBundles(folderStorage(cloud), "app")).toBe(0);
    ageUnnamedBundles("app", []);
    expect(await collectBundles(folderStorage(cloud), "app")).toBe(1);
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
    // The old bundles stay for now: someone may be reading the state before.
    expect(bundleFiles("big")).toHaveLength(6);

    const b = cloneTo("b", "big");
    expect(ok(b, "rev-parse", "HEAD")).toBe(ok(a, "rev-parse", "HEAD"));
    expect(ok(b, "rev-list", "--count", "HEAD")).toBe("6");

    // An hour later the next push clears what no state names.
    ageUnnamedBundles("big", [packed.bundles[0]!.key]);
    commit(b, "last.txt", "last\n", "last");
    ok(b, "push", "uno", "main");
    const after = await state("big");
    expect(bundleFiles("big").toSorted()).toEqual(
      after.bundles.map((bundle) => path.basename(bundle.key)).toSorted(),
    );
    expect(after.seq).toBeGreaterThan(packed.seq);
    await expectConsistent("big");
  }, 30_000);

  it("two computers pushing different branches at once: both land or one is told to fetch first", async () => {
    const a = newRepo("a", "race");
    ok(a, "push", "uno", "main");
    const b = cloneTo("b", "race");
    for (let round = 0; round < 4; round += 1) {
      const idA = commit(a, `a${round}.txt`, `${round}\n`, `a ${round}`);
      const idB = commit(b, `b${round}.txt`, `${round}\n`, `b ${round}`);
      const [fromA, fromB] = await Promise.all([
        gitAsync(a, "push", "uno", `HEAD:refs/heads/a${round}`),
        gitAsync(b, "push", "uno", `HEAD:refs/heads/b${round}`),
      ]);
      const current = await expectConsistent("race");
      for (const [result, ref, id] of [
        [fromA, `refs/heads/a${round}`, idA],
        [fromB, `refs/heads/b${round}`, idB],
      ] as const) {
        if (result.code === 0) expect(current.refs[ref]).toBe(id);
        else {
          expect(result.out).toMatch(/fetch first/);
          expect(current.refs[ref]).toBeUndefined();
        }
      }
    }
  }, 30_000);

  it("two computers fast-forwarding the same branch at once: one lands, the other is refused", async () => {
    const a = newRepo("a", "same");
    ok(a, "push", "uno", "main");
    const b = cloneTo("b", "same");
    for (let round = 0; round < 3; round += 1) {
      // Both start from what the cloud has (the last loser drops its commit).
      for (const dir of [a, b]) {
        ok(dir, "fetch", "-q", "uno");
        ok(dir, "reset", "-q", "--hard", "uno/main");
      }
      const idA = commit(a, `a${round}.txt`, "a\n", `a ${round}`);
      const idB = commit(b, `b${round}.txt`, "b\n", `b ${round}`);
      const [fromA, fromB] = await Promise.all([
        gitAsync(a, "push", "uno", "main"),
        gitAsync(b, "push", "uno", "main"),
      ]);
      expect([fromA.code, fromB.code].filter((code) => code === 0)).toHaveLength(1);
      const winner = fromA.code === 0 ? idA : idB;
      const loser = fromA.code === 0 ? fromB : fromA;
      expect(loser.out).toMatch(/fetch first|rejected/);
      expect((await expectConsistent("same")).refs["refs/heads/main"]).toBe(winner);
    }
  }, 30_000);

  it("refuses to push from a shallow copy", () => {
    const a = newRepo("a", "deep");
    commit(a, "more.txt", "more\n", "second");
    const shallow = path.join(root, "shallow");
    ok(root, "clone", "-q", "--depth", "1", pathToFileURL(a).href, shallow);
    ok(shallow, "remote", "add", "uno", "uno::deep");
    const refused = git(shallow, "push", "uno", "HEAD:refs/heads/main");
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain("This copy is shallow (cloned with --depth)");
    expect(fs.existsSync(path.join(cloud, ".uno-git", "deep"))).toBe(false);
  });

  it("refuses a damaged cloud copy and touches nothing", () => {
    const write = (name: string, body: unknown) => {
      const file = path.join(cloud, logKey(name, 1));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(body));
    };
    const id = "a".repeat(40);
    const base = { version: 1, seq: 1, head: "refs/heads/main", refs: { "refs/heads/main": id } };
    write("evil", {
      ...base,
      bundles: [{ key: ".uno-git/other/bundles/x.bundle", size: 1, tips: {}, prerequisites: [] }],
    });
    write("badref", { ...base, refs: { "refs/heads/a b": id }, bundles: [] });
    write("badid", { ...base, refs: { "refs/heads/main": "xyz" }, bundles: [] });
    for (const name of ["evil", "badref", "badid"]) {
      const result = git(root, "ls-remote", `uno::${name}`);
      expect(result.code).not.toBe(0);
      expect(result.out).toContain(`The cloud copy of ${name} looks damaged`);
    }
  });

  it("reads the time out of a bundle key", () => {
    expect(bundleTime(".uno-git/x/bundles/2026-10-16T22-13-15-291Z-7886e4.bundle")).toBe(
      Date.parse("2026-10-16T22:13:15.291Z"),
    );
    expect(bundleTime(".uno-git/x/bundles/whatever.bundle")).toBeNull();
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

/** A bundle-key time `ms` ago. */
const keyAt = (ms: number) => new Date(Date.now() - ms).toISOString().replace(/[:.]/g, "-");

/** A valid log entry written straight into the fake cloud. */
function putEntry(name: string, seq: number, rev = `rev${seq}`, ageMs = 0) {
  const file = path.join(cloud, logKey(name, seq));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, seq, rev, refs: {}, head: null, bundles: [], updatedAt: "x" }),
  );
  if (ageMs > 0) {
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(file, at, at);
  }
}

describe("compare-and-swap of the state", () => {
  it("storage can't say whether our state landed: the push fails, nothing is deleted, the cloud stays whole", async () => {
    const a = newRepo("a", "unknown");
    ok(a, "push", "uno", "main");
    commit(a, "two.txt", "two\n", "two");
    const faulty = spawnSync("git", ["push", "uno", "main"], {
      cwd: a,
      env: { ...env, [FAKE_FAULTS_ENV]: "lost-answer,readback-fail" },
      encoding: "utf8",
    });
    expect(faulty.status).not.toBe(0);
    expect(faulty.stderr).toContain("Couldn't tell whether this push reached your Uno cloud");
    // It did land: the state names the new bundle, and the bundle is there.
    const current = await expectConsistent("unknown");
    expect(current.refs["refs/heads/main"]).toBe(ok(a, "rev-parse", "HEAD"));
    // Pushing again is a no-op.
    expect(git(a, "push", "uno", "main").out).toMatch(/up-to-date/i);
  });

  it("a read-back that fails is never taken for someone else's entry", async () => {
    const storage = folderStorage(cloud, { lostAnswer: true, failReadBack: true });
    putEntry("p", 1, "r1");
    const before = await readRemote(folderStorage(cloud), "p");
    await expect(commitState(storage, "p", before, { ...before })).rejects.toThrow(OUTCOME_UNKNOWN);
  });

  it("a slow push can't land in a slot pruning emptied", async () => {
    for (let seq = 1; seq <= 3; seq += 1) putEntry("slow", seq);
    const before = await readRemote(folderStorage(cloud), "slow");
    expect(before.seq).toBe(3);
    // Meanwhile: many pushes, and entries far behind pruned.
    const storage = folderStorage(cloud, {
      beforeConditionalWrite: async () => {
        for (let seq = 1; seq <= 3; seq += 1) fs.rmSync(path.join(cloud, logKey("slow", seq)));
        for (let seq = 5; seq <= 60; seq += 1) putEntry("slow", seq);
      },
    });
    // Slot 4 was free, so the write lands — but it doesn't follow `before`.
    expect(await commitState(storage, "slow", before, { ...before })).toBeNull();
    expect(fs.existsSync(path.join(cloud, logKey("slow", 4)))).toBe(true);
    expect((await readRemote(folderStorage(cloud), "slow")).seq).toBe(60);
    // And a writer that is already behind doesn't write at all.
    expect(await commitState(folderStorage(cloud), "slow", before, { ...before })).toBeNull();
    expect(fs.existsSync(path.join(cloud, logKey("slow", 61)))).toBe(false);
  });

  it("prunes only entries more than 50 behind that are also an hour old", async () => {
    for (let seq = 1; seq <= 60; seq += 1)
      putEntry("log", seq, `r${seq}`, seq <= 5 ? 2 * 3600_000 : 0);
    expect(await pruneLog(folderStorage(cloud), "log")).toBe(5);
    expect(fs.existsSync(path.join(cloud, logKey("log", 6)))).toBe(true);
    expect((await readRemote(folderStorage(cloud), "log")).seq).toBe(60);
  });

  it("a cut-short listing is refused, and nothing is collected from it", async () => {
    for (let seq = 1; seq <= 3; seq += 1) putEntry("many", seq);
    const short = folderStorage(cloud, { truncateAfter: 2 });
    await expect(readRemote(short, "many")).rejects.toThrow(
      "more history entries than can be listed",
    );
    await expect(collectBundles(short, "many")).rejects.toThrow();
    expect((await readRemote(folderStorage(cloud), "many")).seq).toBe(3);
  });
});

describe("time", () => {
  it("a push whose upload took over 30 minutes doesn't name its bundle", async () => {
    const a = newRepo("a", "late");
    ok(a, "push", "uno", "main");
    const before = await state("late");
    commit(a, "two.txt", "two\n", "two");
    const late = spawnSync("git", ["push", "uno", "main"], {
      cwd: a,
      env: { ...env, [FAKE_UPLOAD_MINUTES_ENV]: "31" },
      encoding: "utf8",
    });
    expect(late.status).not.toBe(0);
    expect(late.stderr).toContain("took too long");
    expect((await state("late")).seq).toBe(before.seq);
    // Its bundle is left for collectBundles, not deleted by the push.
    expect(bundleFiles("late")).toHaveLength(2);
  });

  it("collects a stray bundle only when both its key time and storage's clock say an hour", async () => {
    putEntry("gc", 1);
    const dir = path.join(cloud, ".uno-git", "gc", "bundles");
    fs.mkdirSync(dir, { recursive: true });
    const make = (file: string, mtimeAgoMs: number) => {
      fs.writeFileSync(path.join(dir, file), "x");
      const at = new Date(Date.now() - mtimeAgoMs);
      fs.utimesSync(path.join(dir, file), at, at);
    };
    make(`${keyAt(2 * 3600_000)}-aaaaaa.bundle`, 0); // old name, just stored
    make(`${keyAt(0)}-bbbbbb.bundle`, 2 * 3600_000); // stored long ago, fresh name (clock behind)
    make(`${keyAt(2 * 3600_000)}-cccccc.bundle`, 2 * 3600_000); // old both ways
    expect(await collectBundles(folderStorage(cloud), "gc")).toBe(1);
    expect(
      fs
        .readdirSync(dir)
        .toSorted()
        .map((file) => file.slice(-13)),
    ).toEqual(["aaaaaa.bundle", "bbbbbb.bundle"]);
    // Storage's clock decides, not this computer's: two hours later both go.
    const later = folderStorage(cloud, { nowMs: () => Date.now() + 3 * 3600_000 });
    expect(await collectBundles(later, "gc")).toBe(2);
  });
});
