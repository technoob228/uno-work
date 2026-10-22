/**
 * "A project lives on all your computers" end to end: real git, the real
 * git-remote-uno helper, the cloud kept in a folder (UNO_GIT_FAKE_STORAGE_DIR),
 * two "computers" = two temp HOMEs.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FAKE_STORAGE_ENV } from "./git-remote-uno.mjs";
import {
  MAX_FILE_BYTES,
  getProject,
  isKeyFile,
  listCloudProjects,
  resolveConflict,
  safeRemoteUrl,
  snapshotGitDir,
  syncProject,
} from "./uno-sync.mjs";

let root = "";
let cloud = "";

/** One computer: its HOME and what the engine runs with. */
function computer(label: string) {
  const home = path.join(root, label);
  fs.mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    [FAKE_STORAGE_ENV]: cloud,
  };
  return { home, env, hostname: label, folder: (name: string) => path.join(home, name) };
}
type Computer = ReturnType<typeof computer>;

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (file: string) => fs.readFileSync(file, "utf8");
const exists = (file: string) => fs.existsSync(file);
/** Set a file's modification time `secondsAgo` in the past. */
const age = (file: string, secondsAgo: number) => {
  const at = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(file, at, at);
};

function gitIn(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    env: {
      ...env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const sync = (at: Computer, dir: string, name?: string, adopt?: boolean) =>
  syncProject({ dir, ...(name ? { name } : {}), ...(adopt ? { adopt } : {}) }, at);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uno-sync-")));
  cloud = path.join(root, "cloud");
  fs.mkdirSync(cloud);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a folder without git", { timeout: 60_000 }, () => {
  it("moves to another computer without keys, packages, builds or ignored files", async () => {
    const laptop = computer("laptop");
    const cloudPc = computer("cloud-pc");
    const notes = laptop.folder("Notes");
    write(path.join(notes, "plan.md"), "plan\n");
    write(path.join(notes, "docs", "a.md"), "a\n");
    write(path.join(notes, ".gitignore"), "private.txt\n");
    write(path.join(notes, "private.txt"), "mine only\n");
    write(path.join(notes, ".env"), "API_KEY=secret\n");
    write(path.join(notes, ".env.local"), "X=1\n");
    write(path.join(notes, "server.pem"), "-----BEGIN-----\n");
    write(path.join(notes, "node_modules", "x", "index.js"), "x\n");
    write(path.join(notes, "dist", "app.js"), "built\n");

    const saved = await sync(laptop, notes);
    expect(saved).toMatchObject({ ok: true, state: "synced", mode: "snapshot", name: "notes" });
    expect(saved.pushed).toBe(true);
    // No git in the person's folder: the snapshot repository lives elsewhere.
    expect(exists(path.join(notes, ".git"))).toBe(false);
    expect(exists(snapshotGitDir(laptop.home, "notes"))).toBe(true);

    const got = await getProject({ name: "notes" }, cloudPc);
    expect(got).toMatchObject({ ok: true, state: "synced", pulled: true });
    const there = path.join(cloudPc.home, "projects", "notes");
    expect(read(path.join(there, "plan.md"))).toBe("plan\n");
    expect(read(path.join(there, "docs", "a.md"))).toBe("a\n");
    expect(read(path.join(there, ".gitignore"))).toBe("private.txt\n");
    for (const never of [
      "private.txt",
      ".env",
      ".env.local",
      "server.pem",
      "node_modules",
      "dist",
      ".git",
    ]) {
      expect(exists(path.join(there, never)), never).toBe(false);
    }

    const listed = await listCloudProjects(cloudPc);
    expect(listed.map((project) => [project.name, project.mode])).toEqual([["notes", "snapshot"]]);
  });

  it("brings edits, new files and deletions both ways", async () => {
    const a = computer("a");
    const b = computer("b");
    const dirA = a.folder("site");
    write(path.join(dirA, "index.html"), "v1\n");
    write(path.join(dirA, "old.txt"), "old\n");
    await sync(a, dirA);
    const dirB = b.folder("site-here");
    expect((await getProject({ name: "site", dir: dirB }, b)).ok).toBe(true);

    write(path.join(dirB, "index.html"), "v2\n");
    write(path.join(dirB, "new.txt"), "new\n");
    fs.rmSync(path.join(dirB, "old.txt"));
    expect(await sync(b, dirB, "site")).toMatchObject({ state: "synced", pushed: true });

    expect(await sync(a, dirA, "site")).toMatchObject({ state: "synced", pulled: true });
    expect(read(path.join(dirA, "index.html"))).toBe("v2\n");
    expect(read(path.join(dirA, "new.txt"))).toBe("new\n");
    expect(exists(path.join(dirA, "old.txt"))).toBe(false);

    // Nothing changed anywhere: nothing to do.
    expect(await sync(a, dirA, "site")).toMatchObject({
      state: "synced",
      pushed: false,
      pulled: false,
    });
  });

  it("merges changes to different files made on both computers", async () => {
    const a = computer("a");
    const b = computer("b");
    const dirA = a.folder("app");
    write(path.join(dirA, "one.txt"), "1\n");
    write(path.join(dirA, "two.txt"), "2\n");
    await sync(a, dirA);
    const dirB = b.folder("app");
    await getProject({ name: "app", dir: dirB }, b);

    write(path.join(dirA, "one.txt"), "1 from a\n");
    write(path.join(dirB, "two.txt"), "2 from b\n");
    await sync(b, dirB, "app");
    const merged = await sync(a, dirA, "app");
    expect(merged).toMatchObject({ state: "synced", pulled: true, pushed: true, conflict: null });
    expect(read(path.join(dirA, "one.txt"))).toBe("1 from a\n");
    expect(read(path.join(dirA, "two.txt"))).toBe("2 from b\n");
    await sync(b, dirB, "app");
    expect(read(path.join(dirB, "one.txt"))).toBe("1 from a\n");
  });

  it("one file changed on both: the newer one wins, the other stays in history, Keep mine brings it back", async () => {
    const a = computer("a");
    const b = computer("b");
    const dirA = a.folder("doc");
    write(path.join(dirA, "text.md"), "start\n");
    await sync(a, dirA);
    const dirB = b.folder("doc");
    await getProject({ name: "doc", dir: dirB }, b);

    // a edited it an hour ago (offline); b just now, and synced first.
    write(path.join(dirA, "text.md"), "edited on a\n");
    age(path.join(dirA, "text.md"), 3600);
    write(path.join(dirB, "text.md"), "edited on b\n");
    await sync(b, dirB, "doc");

    const result = await sync(a, dirA, "doc");
    expect(result.state).toBe("conflict");
    expect(result.ok).toBe(true);
    expect(result.conflict?.files).toEqual(["text.md"]);
    expect(result.conflict?.kept).toEqual({ "text.md": "theirs" });
    expect(read(path.join(dirA, "text.md"))).toBe("edited on b\n");
    // a's version is in the history, not lost.
    const gitDir = snapshotGitDir(a.home, "doc");
    expect(
      gitIn(dirA, { ...a.env, GIT_DIR: gitDir }, "show", `${result.conflict?.mine}:text.md`),
    ).toBe("edited on a");
    // The conflict stays until the person decides.
    expect((await sync(a, dirA, "doc")).state).toBe("conflict");

    const kept = await resolveConflict({ dir: dirA, name: "doc", keep: "mine" }, a);
    expect(kept).toMatchObject({ state: "synced", conflict: null });
    expect(read(path.join(dirA, "text.md"))).toBe("edited on a\n");
    await sync(b, dirB, "doc");
    expect(read(path.join(dirB, "text.md"))).toBe("edited on a\n");
  });

  it("the newer edit wins on the other side too, and Dismiss keeps it", async () => {
    const a = computer("a");
    const b = computer("b");
    const dirA = a.folder("doc");
    write(path.join(dirA, "text.md"), "start\n");
    await sync(a, dirA);
    const dirB = b.folder("doc");
    await getProject({ name: "doc", dir: dirB }, b);

    write(path.join(dirB, "text.md"), "older on b\n");
    await sync(b, dirB, "doc");
    write(path.join(dirA, "text.md"), "newer on a\n");
    // b's commit happened "now"; a's file is newer still.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dirA, "text.md"), future, future);
    const result = await sync(a, dirA, "doc");
    expect(result.conflict?.kept).toEqual({ "text.md": "mine" });
    expect(read(path.join(dirA, "text.md"))).toBe("newer on a\n");
    expect(await resolveConflict({ dir: dirA, name: "doc", keep: "dismiss" }, a)).toMatchObject({
      state: "synced",
      conflict: null,
    });
  });

  it("refuses a file over the size cap, with what to do", async () => {
    const a = computer("a");
    const dir = a.folder("media");
    write(path.join(dir, "note.txt"), "hi\n");
    // Sparse: as big as it says, no disk used.
    const fd = fs.openSync(path.join(dir, "video.mp4"), "w");
    fs.ftruncateSync(fd, MAX_FILE_BYTES + 1);
    fs.closeSync(fd);
    const result = await sync(a, dir);
    expect(result).toMatchObject({ ok: false, state: "too-big", pushed: false });
    expect(result.message).toContain("video.mp4");
    expect(result.message).toContain("Uno Drive");
    // Ignoring it is enough.
    write(path.join(dir, ".gitignore"), "*.mp4\n");
    expect((await sync(a, dir)).state).toBe("synced");
  });

  it("won't mix a different folder into a name that's taken, unless asked to (Get it here)", async () => {
    const a = computer("a");
    const b = computer("b");
    const one = a.folder("site");
    write(path.join(one, "a.txt"), "a\n");
    await sync(a, one);
    const other = b.folder("site");
    write(path.join(other, "b.txt"), "b\n");
    const refused = await sync(b, other);
    expect(refused).toMatchObject({ ok: false, state: "blocked" });
    expect(refused.message).toContain("different project");
    const joined = await sync(b, other, "site", true);
    expect(joined.state).toBe("synced");
    expect(read(path.join(other, "a.txt"))).toBe("a\n");
    expect(read(path.join(other, "b.txt"))).toBe("b\n");
  });

  it("a second folder for the same project on one computer joins it, deleting nothing", async () => {
    const a = computer("a");
    const b = computer("b");
    const first = a.folder("first");
    write(path.join(first, "keep.txt"), "keep\n");
    await sync(a, first, "proj");
    const moved = a.folder("moved");
    write(path.join(moved, "extra.txt"), "extra\n");
    // Not on purpose: refused while the first folder is still there.
    expect((await sync(a, moved, "proj")).state).toBe("blocked");
    expect((await getProject({ name: "proj", dir: moved }, a)).state).toBe("synced");
    expect(read(path.join(moved, "keep.txt"))).toBe("keep\n");
    expect(read(path.join(moved, "extra.txt"))).toBe("extra\n");
    const elsewhere = b.folder("proj");
    await getProject({ name: "proj", dir: elsewhere }, b);
    expect(fs.readdirSync(elsewhere).toSorted()).toEqual(["extra.txt", "keep.txt"]);
  });

  it("says an empty folder has nothing to sync", async () => {
    const a = computer("a");
    const dir = a.folder("empty");
    fs.mkdirSync(dir);
    expect(await sync(a, dir)).toMatchObject({ ok: true, state: "empty" });
  });
});

describe("a folder with its own git", { timeout: 60_000 }, () => {
  function repo(at: Computer, name: string) {
    const dir = at.folder(name);
    fs.mkdirSync(dir, { recursive: true });
    gitIn(dir, at.env, "init", "-q", "-b", "main");
    write(path.join(dir, "README.md"), `${name}\n`);
    gitIn(dir, at.env, "add", "-A");
    gitIn(dir, at.env, "commit", "-q", "-m", "first");
    return dir;
  }

  it("syncs committed work, keeps its GitHub remote (never a token in it)", async () => {
    const a = computer("a");
    const b = computer("b");
    const dir = repo(a, "api");
    gitIn(dir, a.env, "remote", "add", "origin", "https://github.com/me/api.git");
    gitIn(dir, a.env, "remote", "add", "leaky", "https://me:ghp_secret@github.com/me/api.git");
    write(path.join(dir, "draft.txt"), "not committed\n");
    gitIn(dir, a.env, "add", "draft.txt");

    const saved = await sync(a, dir);
    expect(saved).toMatchObject({ ok: true, state: "synced", mode: "git", name: "api" });
    expect(saved.message).toContain("aren't committed");
    expect(gitIn(dir, a.env, "remote", "get-url", "uno")).toBe("uno::api");

    const got = await getProject({ name: "api" }, b);
    expect(got).toMatchObject({ ok: true, mode: "git" });
    const there = path.join(b.home, "projects", "api");
    expect(read(path.join(there, "README.md"))).toBe("api\n");
    expect(exists(path.join(there, "draft.txt"))).toBe(false);
    expect(gitIn(there, b.env, "remote", "get-url", "origin")).toBe(
      "https://github.com/me/api.git",
    );
    expect(() => gitIn(there, b.env, "remote", "get-url", "leaky")).toThrow();

    // A commit on b reaches a.
    write(path.join(there, "b.txt"), "b\n");
    gitIn(there, b.env, "add", "-A");
    gitIn(there, b.env, "commit", "-q", "-m", "from b");
    expect((await sync(b, there, "api")).pushed).toBe(true);
    gitIn(dir, a.env, "reset", "-q");
    fs.rmSync(path.join(dir, "draft.txt"));
    expect(await sync(a, dir, "api")).toMatchObject({ state: "synced", pulled: true });
    expect(read(path.join(dir, "b.txt"))).toBe("b\n");
  });

  it("won't sync a repository that keeps a .env or a key in git", async () => {
    const a = computer("a");
    const dir = repo(a, "leaky");
    write(path.join(dir, ".env"), "TOKEN=1\n");
    gitIn(dir, a.env, "add", "-f", ".env");
    gitIn(dir, a.env, "commit", "-q", "-m", "oops");
    const result = await sync(a, dir);
    expect(result).toMatchObject({ ok: false, state: "blocked" });
    expect(result.message).toContain(".env");
    expect(fs.readdirSync(cloud)).toEqual([]);
  });
});

describe("rules", () => {
  it("knows key files", () => {
    for (const file of [".env", "app/.env.production", "id_ed25519", "certs/server.pem", "a.p12"]) {
      expect(isKeyFile(file), file).toBe(true);
    }
    for (const file of [".env.example", "README.md", "src/env.ts", "keys.md"]) {
      expect(isKeyFile(file), file).toBe(false);
    }
  });

  it("shares remote URLs only without credentials", () => {
    expect(safeRemoteUrl("https://github.com/me/x.git")).toBe("https://github.com/me/x.git");
    expect(safeRemoteUrl("git@github.com:me/x.git")).toBe("git@github.com:me/x.git");
    expect(safeRemoteUrl("https://me:tok@github.com/me/x.git")).toBeNull();
    expect(safeRemoteUrl("https://tok@github.com/me/x.git")).toBeNull();
    expect(safeRemoteUrl("file:///etc")).toBeNull();
    expect(safeRemoteUrl("ext::sh -c evil")).toBeNull();
  });
});
