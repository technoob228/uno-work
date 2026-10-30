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
  builtFolders,
  getProject,
  heldFromPublishMessage,
  isKeyFile,
  keysBeforePublish,
  listCloudProjects,
  projectFiles,
  projectHistory,
  resolveConflict,
  restoreVersion,
  safeRelative,
  safeRemoteUrl,
  setLocalOnly,
  snapshotGitDir,
  startRepository,
  syncProject,
  versionAuthor,
} from "./uno-sync.mjs";

/** Obviously fake, and put together here so no scanner flags this test file. */
const FAKE_KEY = ["sk-ant-", "FAKE".repeat(6)].join("");
const FAKE_GITHUB = ["ghp_", "FAKE".repeat(6)].join("");

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
    write(path.join(notes, "package.json"), "{}\n");
    write(path.join(notes, "dist", "app.js"), "built\n");

    const saved = await sync(laptop, notes);
    expect(saved).toMatchObject({ ok: true, state: "synced", mode: "snapshot", name: "notes" });
    expect(saved.pushed).toBe(true);
    // No .git in the person's folder: the hidden history is .uno-git, remote uno.
    expect(exists(path.join(notes, ".git"))).toBe(false);
    expect(snapshotGitDir(notes)).toBe(path.join(notes, ".uno-git"));
    expect(
      gitIn(notes, { ...laptop.env, GIT_DIR: snapshotGitDir(notes) }, "config", "remote.uno.url"),
    ).toBe("uno::notes");

    const got = await getProject({ name: "notes" }, cloudPc);
    expect(got).toMatchObject({ ok: true, state: "synced", pulled: true });
    const there = path.join(cloudPc.home, "projects", "notes");
    expect(
      gitIn(there, { ...cloudPc.env, GIT_DIR: snapshotGitDir(there) }, "config", "remote.uno.url"),
    ).toBe("uno::notes");
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
    const gitDir = snapshotGitDir(dirA);
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
    // Not on purpose: refused, its history isn't the project's.
    expect((await sync(a, moved, "proj")).state).toBe("blocked");
    expect((await getProject({ name: "proj", dir: moved }, a)).state).toBe("synced");
    expect(read(path.join(moved, "keep.txt"))).toBe("keep\n");
    expect(read(path.join(moved, "extra.txt"))).toBe("extra\n");
    const elsewhere = b.folder("proj");
    await getProject({ name: "proj", dir: elsewhere }, b);
    expect(fs.readdirSync(elsewhere).toSorted()).toEqual([".uno-git", "extra.txt", "keep.txt"]);
  });

  it("a folder synced again under a new name starts that name from its own history", async () => {
    const a = computer("a");
    const b = computer("b");
    const dir = a.folder("draft");
    write(path.join(dir, "x.md"), "x\n");
    await sync(a, dir, "draft");
    expect((await sync(a, dir, "draft-2")).state).toBe("synced");
    const gitDir = snapshotGitDir(dir);
    expect(gitIn(dir, { ...a.env, GIT_DIR: gitDir }, "config", "remote.uno.url")).toBe(
      "uno::draft-2",
    );
    const got = b.folder("got");
    await getProject({ name: "draft-2", dir: got }, b);
    expect(read(path.join(got, "x.md"))).toBe("x\n");
  });

  it("a file with a key waits on this computer; everything else goes; the value is never shown", async () => {
    const a = computer("a");
    const b = computer("b");
    const dir = a.folder("held");
    write(path.join(dir, "plan.md"), "plan\n");
    write(path.join(dir, "config.json"), `{ "token": "${FAKE_KEY}" }\n`);
    const first = await sync(a, dir, "held");
    expect(first).toMatchObject({ ok: true, state: "synced", held: ["config.json"] });
    expect(first.message).toContain("config.json");
    expect(first.message).not.toContain(FAKE_KEY);
    expect(JSON.stringify(first)).not.toContain(FAKE_KEY);

    await getProject({ name: "held" }, b);
    const there = path.join(b.home, "projects", "held");
    expect(read(path.join(there, "plan.md"))).toBe("plan\n");
    expect(exists(path.join(there, "config.json"))).toBe(false);
    // Still in the person's folder, untouched.
    expect(read(path.join(dir, "config.json"))).toContain(FAKE_KEY);

    // The key moved out: the file syncs and the note is gone.
    write(path.join(dir, "config.json"), `{ "token": "from-keys" }\n`);
    expect(await sync(a, dir, "held")).toMatchObject({ state: "synced", held: [], pushed: true });
    await sync(b, there, "held");
    expect(read(path.join(there, "config.json"))).toContain("from-keys");
  });

  it("a synced file that gets a key keeps its last clean version in the cloud", async () => {
    const a = computer("a");
    const b = computer("b");
    const dir = a.folder("edited");
    write(path.join(dir, "notes.md"), "clean\n");
    write(path.join(dir, "other.md"), "one\n");
    await sync(a, dir, "edited");
    await getProject({ name: "edited" }, b);

    write(path.join(dir, "notes.md"), `clean\n${FAKE_GITHUB}\n`);
    write(path.join(dir, "other.md"), "two\n");
    expect(await sync(a, dir, "edited")).toMatchObject({ state: "synced", held: ["notes.md"] });
    const there = path.join(b.home, "projects", "edited");
    await sync(b, there, "edited");
    expect(read(path.join(there, "notes.md"))).toBe("clean\n");
    expect(read(path.join(there, "other.md"))).toBe("two\n");

    // Editing the other computer's copy of a held file is said plainly, not retried for ever.
    write(path.join(there, "notes.md"), "edited there\n");
    await sync(b, there, "edited");
    const clash = await sync(a, dir, "edited");
    expect(clash).toMatchObject({ state: "blocked", held: ["notes.md"] });
    expect(clash.message).toContain("Keys");
  });

  it("reads files of any size whole, a key across two reads included", async () => {
    const a = computer("a");
    const dir = a.folder("big");
    // Around the pipe's 64 KB read, so a key sits on the seam whatever the first read took.
    const dumps = Array.from({ length: 12 }, (_, index) => `dump-${index + 10}.txt`);
    for (const [index, name] of dumps.entries()) {
      const before = `${"x".repeat(64 * 1024 - 8 * index)}\n`;
      write(path.join(dir, name), `${before}${FAKE_KEY}\n${"y".repeat(100_000)}`);
    }
    write(path.join(dir, "clean.txt"), "z".repeat(300_000));
    write(path.join(dir, "image.bin"), "\u0000\u0001 binary");
    const result = await sync(a, dir, "big");
    expect(result).toMatchObject({ state: "synced", held: dumps });
    expect(gitIn(dir, { ...a.env, GIT_DIR: snapshotGitDir(dir) }, "ls-files")).toBe(
      "clean.txt\nimage.bin",
    );
  });

  it("a folder with nothing but a held file says so, not that it's empty", async () => {
    const a = computer("a");
    const dir = a.folder("only-held");
    write(path.join(dir, "keys.txt"), `${FAKE_KEY}\n`);
    const result = await sync(a, dir, "only-held");
    expect(result).toMatchObject({ state: "empty", held: ["keys.txt"] });
    expect(result.message).toContain("keys.txt");
  });

  it("keeps saving after `git init` in the folder, and heals a folder that stopped", async () => {
    const a = computer("a");
    const b = computer("b");
    const dir = a.folder("became-git");
    write(path.join(dir, "plan.md"), "one\n");
    await sync(a, dir, "became-git");

    gitIn(dir, a.env, "init", "-q", "-b", "main");
    gitIn(dir, a.env, "add", "-A");
    gitIn(dir, a.env, "commit", "-q", "-m", "their own git");
    write(path.join(dir, "plan.md"), "two\n");
    write(path.join(dir, "new.md"), "uncommitted, still saved\n");
    expect(await sync(a, dir, "became-git")).toMatchObject({
      ok: true,
      state: "synced",
      mode: "snapshot",
      pushed: true,
    });
    await getProject({ name: "became-git" }, b);
    const there = path.join(b.home, "projects", "became-git");
    expect(read(path.join(there, "plan.md"))).toBe("two\n");
    expect(read(path.join(there, "new.md"))).toContain("still saved");
    // Their git doesn't pick up Uno's versions, and is left alone.
    write(path.join(dir, "later.md"), "later\n");
    gitIn(dir, a.env, "add", "-A");
    expect(gitIn(dir, a.env, "status", "--porcelain")).not.toContain(".uno-git");
    expect(gitIn(dir, a.env, "log", "--format=%s")).toBe("their own git");
  });

  it("signs versions with the person and the computer", async () => {
    const a = { ...computer("a"), person: "Misha" };
    const dir = a.folder("signed");
    write(path.join(dir, "plan.md"), "one\n");
    await sync(a, dir, "signed");
    const log = gitIn(dir, { ...a.env, GIT_DIR: snapshotGitDir(dir) }, "log", "--format=%an|%s");
    expect(log).toBe("Misha (a)|Saved on a");
    expect(versionAuthor({ ...a, person: null })).toBe("Uno (a)");
    expect(versionAuthor({ ...a, person: "A <b>\n(c)" })).toBe("A bc (a)");
    const history = await projectHistory({ dir }, a);
    expect(history.versions[0]).toMatchObject({ person: "Misha", computer: "a", note: null });
  });

  it("build folders travel unless a project file lies next to them", async () => {
    const a = computer("a");
    const b = computer("b");
    const dir = a.folder("mixed");
    write(path.join(dir, "out", "report.pdf"), "the person's own output\n");
    write(path.join(dir, "build", "plan.md"), "building plan\n");
    write(path.join(dir, "site", "package.json"), "{}\n");
    write(path.join(dir, "site", "dist", "app.js"), "built\n");
    write(path.join(dir, "site", "src", "app.ts"), "source\n");
    await sync(a, dir, "mixed");
    await getProject({ name: "mixed" }, b);
    const there = path.join(b.home, "projects", "mixed");
    expect(read(path.join(there, "out", "report.pdf"))).toContain("own output");
    expect(read(path.join(there, "build", "plan.md"))).toContain("plan");
    expect(read(path.join(there, "site", "src", "app.ts"))).toBe("source\n");
    expect(exists(path.join(there, "site", "dist"))).toBe(false);
  });

  it("a folder saved under the old list picks up its build folders", async () => {
    const a = computer("a");
    const dir = a.folder("older");
    write(path.join(dir, "plan.md"), "plan\n");
    await sync(a, dir, "older");
    const exclude = path.join(snapshotGitDir(dir), "info", "exclude");
    fs.appendFileSync(exclude, "dist/\nbuild/\nout/\n");
    write(path.join(dir, "out", "result.csv"), "1,2\n");
    await sync(a, dir, "older");
    const files = gitIn(dir, { ...a.env, GIT_DIR: snapshotGitDir(dir) }, "ls-files");
    expect(files).toContain("out/result.csv");
  });

  it("goes back to an earlier version, and going back can be undone", async () => {
    const a = computer("a");
    const b = computer("b");
    const dir = a.folder("timeline");
    write(path.join(dir, "plan.md"), "yesterday\n");
    write(path.join(dir, "keep.md"), "keep\n");
    await sync(a, dir, "timeline");
    await getProject({ name: "timeline" }, b);
    write(path.join(dir, "plan.md"), "today\n");
    write(path.join(dir, "new.md"), "added today\n");
    await sync(a, dir, "timeline");
    write(path.join(dir, "plan.md"), "unsaved edit\n");

    const before = await projectHistory({ dir }, a);
    const yesterday = before.versions.at(-1);
    expect(before.versions.map((version) => version.note)).toEqual([null, null]);
    expect(before.versions[0]?.files).toEqual(
      expect.arrayContaining([
        { path: "new.md", change: "added" },
        { path: "plan.md", change: "changed" },
      ]),
    );

    const back = await restoreVersion({ dir, name: "timeline", version: yesterday?.id ?? "" }, a);
    expect(back).toMatchObject({ ok: true, state: "synced", pushed: true });
    expect(read(path.join(dir, "plan.md"))).toBe("yesterday\n");
    expect(exists(path.join(dir, "new.md"))).toBe(false);

    // On the other computer too.
    const there = path.join(b.home, "projects", "timeline");
    await sync(b, there, "timeline");
    expect(read(path.join(there, "plan.md"))).toBe("yesterday\n");

    // The unsaved edit was saved first, so it can be brought back.
    const after = await projectHistory({ dir }, a);
    expect(after.versions[0]?.note).toMatch(/^Went back to /);
    const edited = after.versions[1];
    expect(edited?.files).toEqual([{ path: "plan.md", change: "changed" }]);
    await restoreVersion(
      { dir, name: "timeline", version: edited?.id ?? "", files: ["plan.md"] },
      a,
    );
    expect(read(path.join(dir, "plan.md"))).toBe("unsaved edit\n");
    expect(exists(path.join(dir, "new.md"))).toBe(false);
    expect((await projectHistory({ dir }, a)).versions[0]?.note).toMatch(/^Brought back plan\.md/);
  });

  it("won't go back to something that isn't a version of this project", async () => {
    const a = computer("a");
    const dir = a.folder("guarded");
    write(path.join(dir, "plan.md"), "one\n");
    await sync(a, dir, "guarded");
    for (const version of ["--help", "HEAD", "f".repeat(40)]) {
      const result = await restoreVersion({ dir, name: "guarded", version }, a);
      expect(result).toMatchObject({ ok: false, state: "blocked" });
    }
    expect(read(path.join(dir, "plan.md"))).toBe("one\n");
  });

  it("pages the history", async () => {
    const a = computer("a");
    const dir = a.folder("paged");
    for (const round of [1, 2, 3]) {
      write(path.join(dir, "plan.md"), `${round}\n`);
      await sync(a, dir, "paged");
    }
    const first = await projectHistory({ dir, limit: 2 }, a);
    expect(first).toMatchObject({ more: true });
    expect(first.versions).toHaveLength(2);
    const rest = await projectHistory({ dir, limit: 2, skip: 2 }, a);
    expect(rest).toMatchObject({ more: false });
    expect(rest.versions).toHaveLength(1);
    const empty = await projectHistory({ dir: a.folder("nothing-here") }, a);
    expect(empty).toEqual({ mode: "snapshot", versions: [], more: false });
  });

  it("counts a file kept here once, also when it's all its folder holds", async () => {
    const a = computer("a");
    const dir = a.folder("data-only");
    write(path.join(dir, "plan.md"), "plan\n");
    write(path.join(dir, "data", "sample.csv"), "1,2\n");
    write(path.join(dir, "conf", ".env"), "API_KEY=x\n");
    await sync(a, dir, "data-only");

    await setLocalOnly({ dir, path: "data/sample.csv", localOnly: true }, a);
    const files = await projectFiles({ dir }, a);
    expect(files.localOnly).toEqual([{ path: "data/sample.csv", yours: true }]);
    expect(files.keyFiles).toEqual(["conf/.env"]);
  });

  it("marks the versions this person saved", async () => {
    const a = { ...computer("a"), person: "misha@x.io" };
    const b = { ...computer("b"), person: "anna" };
    const dir = a.folder("marks");
    write(path.join(dir, "plan.md"), "one\n");
    await sync(a, dir, "marks");
    expect((await projectHistory({ dir }, a)).versions[0]).toMatchObject({
      person: "misha@x.io",
      mine: true,
    });
    expect((await projectHistory({ dir }, b)).versions[0]).toMatchObject({
      person: "misha@x.io",
      mine: false,
    });
  });

  it("says what travels, what stays here, and lets the person choose", async () => {
    const a = computer("a");
    const b = computer("b");
    const dir = a.folder("classes");
    write(path.join(dir, "plan.md"), "plan\n");
    write(path.join(dir, "videos", "demo.mov"), "big\n");
    write(path.join(dir, ".env"), "API_KEY=x\n");
    write(path.join(dir, "node_modules", "x", "index.js"), "x\n");
    await sync(a, dir, "classes");
    await getProject({ name: "classes" }, b);
    const there = path.join(b.home, "projects", "classes");
    expect(exists(path.join(there, "videos", "demo.mov"))).toBe(true);

    let files = await projectFiles({ dir }, a);
    expect(files).toMatchObject({
      mode: "snapshot",
      synced: 2,
      keyFiles: [".env"],
      localOnly: [{ path: "node_modules/", yours: false }],
    });

    await setLocalOnly({ dir, path: "videos/", localOnly: true }, a);
    await sync(a, dir, "classes");
    files = await projectFiles({ dir }, a);
    expect(files.synced).toBe(1);
    expect(files.localOnly[0]).toEqual({ path: "videos/", yours: true });
    // Stays here, leaves the other computers.
    expect(exists(path.join(dir, "videos", "demo.mov"))).toBe(true);
    await sync(b, there, "classes");
    expect(exists(path.join(there, "videos"))).toBe(false);

    await setLocalOnly({ dir, path: "videos", localOnly: false }, a);
    await sync(a, dir, "classes");
    await sync(b, there, "classes");
    expect(exists(path.join(there, "videos", "demo.mov"))).toBe(true);

    await expect(setLocalOnly({ dir, path: "../up", localOnly: true }, a)).rejects.toThrow(
      "isn't a file",
    );
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
    expect(saved.message).toContain("stay on this computer until");
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

  it("names the other person in a conflict, not one's own other computer", async () => {
    const misha = { ...computer("misha-pc"), person: "Misha" };
    const anya = { ...computer("anya-pc"), person: "Anya" };
    const laptop = { ...computer("misha-laptop"), person: "Misha" };
    const dir = misha.folder("shared");
    write(path.join(dir, "plan.md"), "one\n");
    await sync(misha, dir, "shared");
    await getProject({ name: "shared" }, anya);
    await getProject({ name: "shared" }, laptop);
    const hers = path.join(anya.home, "projects", "shared");
    const mine = path.join(laptop.home, "projects", "shared");

    write(path.join(hers, "plan.md"), "anya\n");
    await sync(anya, hers, "shared");
    write(path.join(dir, "plan.md"), "misha\n");
    age(path.join(dir, "plan.md"), 3600);
    const clash = await sync(misha, dir, "shared");
    expect(clash.conflict).toMatchObject({ files: ["plan.md"], theirsPerson: "Anya" });
    expect(clash.conflict?.kept).toEqual({ "plan.md": "theirs" });

    await resolveConflict({ dir, name: "shared", keep: "dismiss" }, misha);
    write(path.join(dir, "plan.md"), "misha again\n");
    await sync(misha, dir, "shared");
    write(path.join(mine, "plan.md"), "laptop\n");
    age(path.join(mine, "plan.md"), 3600);
    const own = await sync(laptop, mine, "shared");
    expect(own.conflict).toMatchObject({ theirsPerson: null });
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

  it("a key in a commit waits with everything new; taking it out of the last commit isn't enough", async () => {
    const a = computer("a");
    const dir = repo(a, "history");
    expect(await sync(a, dir, "history")).toMatchObject({ pushed: true, held: [] });

    write(path.join(dir, "config.json"), `{ "token": "${FAKE_KEY}" }\n`);
    gitIn(dir, a.env, "add", "-A");
    gitIn(dir, a.env, "commit", "-q", "-m", "add config");
    write(path.join(dir, "config.json"), `{ "token": "gone" }\n`);
    gitIn(dir, a.env, "add", "-A");
    gitIn(dir, a.env, "commit", "-q", "-m", "take the key out");

    const result = await sync(a, dir, "history");
    expect(result).toMatchObject({ ok: true, pushed: false, held: ["config.json"] });
    expect(result.message).toContain("config.json");
    expect(result.message).not.toContain(FAKE_KEY);
    expect(result.message).not.toMatch(/\b(git|commit|branch)\b/i);

    // The cloud is untouched: a second computer gets the clean first version only.
    const b = computer("b");
    await getProject({ name: "history" }, b);
    const there = path.join(b.home, "projects", "history");
    expect(exists(path.join(there, "config.json"))).toBe(false);

    // Their changes still arrive while it waits.
    write(path.join(there, "from-b.md"), "b\n");
    gitIn(there, b.env, "add", "-A");
    gitIn(there, b.env, "commit", "-q", "-m", "b");
    await sync(b, there, "history");
    expect(await sync(a, dir, "history")).toMatchObject({ pulled: true, pushed: false });
    expect(read(path.join(dir, "from-b.md"))).toBe("b\n");

    // History rewritten without it: it all goes.
    gitIn(dir, a.env, "reset", "-q", "--soft", "uno/main");
    gitIn(dir, a.env, "commit", "-q", "-m", "config without the key");
    expect(await sync(a, dir, "history")).toMatchObject({ pushed: true, held: [] });
  });

  it("doesn't answer for what is already on another remote", async () => {
    const a = computer("a");
    const dir = repo(a, "cloned");
    write(path.join(dir, "fixture.txt"), `${FAKE_GITHUB}\n`);
    gitIn(dir, a.env, "add", "-A");
    gitIn(dir, a.env, "commit", "-q", "-m", "old fixture");
    const origin = path.join(root, "origin.git");
    gitIn(root, a.env, "init", "-q", "--bare", origin);
    gitIn(dir, a.env, "remote", "add", "origin", origin);
    gitIn(dir, a.env, "push", "-q", "origin", "main");
    expect(await sync(a, dir, "cloned")).toMatchObject({ pushed: true, held: [] });
  });

  it("reads new commits only once while they wait", async () => {
    const a = computer("a");
    const dir = repo(a, "cached");
    write(path.join(dir, "config.json"), `${FAKE_KEY}\n`);
    gitIn(dir, a.env, "add", "-A");
    gitIn(dir, a.env, "commit", "-q", "-m", "key");
    await sync(a, dir, "cached");
    const file = path.join(dir, ".git", "uno-held.json");
    const first = JSON.parse(read(file)) as { held: string[] };
    expect(first.held).toEqual(["config.json"]);
    fs.writeFileSync(file, JSON.stringify({ ...first, held: ["from-memory.txt"] }));
    expect((await sync(a, dir, "cached")).held).toEqual(["from-memory.txt"]);
  });

  it("signs merges as the person when the repository has no author", async () => {
    const a = { ...computer("a"), person: "Misha" };
    const dir = repo(a, "authors");
    await sync(a, dir, "authors");
    const b = computer("b");
    await getProject({ name: "authors" }, b);
    const there = path.join(b.home, "projects", "authors");
    write(path.join(there, "b.md"), "b\n");
    gitIn(there, b.env, "add", "-A");
    gitIn(there, b.env, "commit", "-q", "-m", "b");
    await sync(b, there, "authors");
    write(path.join(dir, "a.md"), "a\n");
    gitIn(dir, a.env, "add", "-A");
    gitIn(dir, a.env, "commit", "-q", "-m", "a");
    expect(await sync(a, dir, "authors")).toMatchObject({ pulled: true, pushed: true });
    expect(gitIn(dir, a.env, "log", "-1", "--merges", "--format=%an")).toBe("Misha (a)");
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

  it("finds build folders only next to a project file", () => {
    expect(
      builtFolders([
        "package.json",
        "dist/app.js",
        "dist/nested/out/x.js",
        "src/dist/own.txt",
        "docs/build/guide.md",
        "svc/Cargo.toml",
        "svc/out/a.bin",
        "svc/src/main.rs",
        "dotnet/App.csproj",
        "dotnet/build/x",
        "plain/out/report.pdf",
      ]),
    ).toEqual(["dist/", "dotnet/build/", "svc/out/"]);
    expect(builtFolders(["out/report.pdf", "build/plan.md", "dist/x"])).toEqual([]);
  });

  it("takes only paths inside the folder", () => {
    expect(safeRelative("./videos/")).toBe("videos");
    expect(safeRelative("a/b.txt")).toBe("a/b.txt");
    for (const bad of ["", "/etc/passwd", "../up", "a/../../b", ".git", ".uno-git/config", 3]) {
      expect(safeRelative(bad), String(bad)).toBeNull();
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

describe("a project that lives on GitHub or GitLab", { timeout: 60_000 }, () => {
  /** A bare repository in a folder stands in for the host: nothing here reaches a real one. */
  function host(at: Computer) {
    const bare = path.join(root, "host.git");
    gitIn(root, at.env, "init", "-q", "--bare", "--initial-branch=main", bare);
    return bare;
  }
  const hostLog = (at: Computer, bare: string) => gitIn(bare, at.env, "log", "--format=%s", "main");
  async function started(at: Computer, name = "site") {
    const dir = path.join(at.home, "projects", name);
    await startRepository({ dir, name }, at);
    const bare = host(at);
    gitIn(dir, at.env, "remote", "add", "origin", bare);
    return { dir, bare };
  }
  const commitAll = (at: Computer, dir: string, message: string) => {
    gitIn(dir, at.env, "add", "-A");
    gitIn(dir, at.env, "commit", "-q", "-m", message);
  };

  it("starts with its own git, one version, and keys and packages kept out", async () => {
    const a = computer("a");
    const dir = path.join(a.home, "projects", "site");
    await startRepository({ dir, name: "site" }, a);
    expect(read(path.join(dir, "README.md"))).toBe("# site\n");
    expect(gitIn(dir, a.env, "log", "--format=%s")).toBe("Initial commit");
    expect(gitIn(dir, a.env, "symbolic-ref", "--short", "HEAD")).toBe("main");
    write(path.join(dir, ".env"), `KEY=${FAKE_KEY}\n`);
    write(path.join(dir, ".env.example"), "KEY=\n");
    write(path.join(dir, "node_modules", "x.js"), "x\n");
    gitIn(dir, a.env, "add", "-A");
    expect(gitIn(dir, a.env, "diff", "--cached", "--name-only")).toBe(".env.example");
  });

  it("won't start in a folder that already has files", async () => {
    const a = computer("a");
    const dir = a.folder("taken");
    write(path.join(dir, "mine.txt"), "x\n");
    await expect(startRepository({ dir, name: "taken" }, a)).rejects.toThrow(/already has files/);
    expect(exists(path.join(dir, ".git"))).toBe(false);
  });

  it("pushes what's committed, pulls what's new there, and the Uno cloud stays in step", async () => {
    const a = computer("a");
    const { dir, bare } = await started(a);
    write(path.join(dir, "page.html"), "<h1>hi</h1>\n");
    commitAll(a, dir, "first page");

    const first = await syncProject({ dir, name: "site", hostRemote: "origin" }, a);
    expect(first).toMatchObject({ ok: true, state: "synced", mode: "git", pushed: true });
    expect(first.host).toMatchObject({ remote: "origin", state: "synced", pushed: true });
    expect(hostLog(a, bare).split("\n")).toEqual(["first page", "Initial commit"]);
    expect(gitIn(dir, a.env, "remote", "get-url", "uno")).toBe("uno::site");

    // Someone pushed to the host from elsewhere.
    const other = path.join(root, "elsewhere");
    gitIn(root, a.env, "clone", "-q", bare, other);
    write(path.join(other, "notes.md"), "from the web\n");
    commitAll(a, other, "from elsewhere");
    gitIn(other, a.env, "push", "-q", "origin", "HEAD:main");

    const second = await syncProject({ dir, name: "site", hostRemote: "origin" }, a);
    expect(second).toMatchObject({ ok: true, state: "synced", pulled: true });
    expect(read(path.join(dir, "notes.md"))).toBe("from the web\n");

    // Uncommitted work stays here: only saved versions leave.
    write(path.join(dir, "draft.md"), "not saved\n");
    await syncProject({ dir, name: "site", hostRemote: "origin" }, a);
    expect(hostLog(a, bare)).not.toContain("draft");
  });

  it("merges when both sides moved, and the merge goes back to the host", async () => {
    const a = computer("a");
    const { dir, bare } = await started(a);
    await syncProject({ dir, name: "site", hostRemote: "origin" }, a);
    const other = path.join(root, "elsewhere");
    gitIn(root, a.env, "clone", "-q", bare, other);
    write(path.join(other, "b.md"), "b\n");
    commitAll(a, other, "there");
    gitIn(other, a.env, "push", "-q", "origin", "HEAD:main");
    write(path.join(dir, "a.md"), "a\n");
    commitAll(a, dir, "here");

    const merged = await syncProject({ dir, name: "site", hostRemote: "origin" }, a);
    expect(merged).toMatchObject({ ok: true, state: "synced", pulled: true });
    expect(read(path.join(dir, "b.md"))).toBe("b\n");
    expect(hostLog(a, bare)).toContain("Merge changes from");
  });

  it("a key in a commit never reaches the host, and the value is never shown", async () => {
    const a = computer("a");
    const { dir, bare } = await started(a);
    await syncProject({ dir, name: "site", hostRemote: "origin" }, a);
    write(path.join(dir, "config.json"), `{ "token": "${FAKE_KEY}" }\n`);
    commitAll(a, dir, "with a key");

    const held = await syncProject({ dir, name: "site", hostRemote: "origin" }, a);
    expect(held.held).toContain("config.json");
    expect(held.host?.pushed).toBe(false);
    expect(JSON.stringify(held)).not.toContain(FAKE_KEY);
    expect(hostLog(a, bare)).not.toContain("with a key");
  });

  it("keeps the host's reading apart: a commit the cloud has is still read for the host", async () => {
    const a = computer("a");
    const { dir, bare } = await started(a);
    write(path.join(dir, "page.html"), "ok\n");
    commitAll(a, dir, "on the cloud only");
    await syncProject({ dir, name: "site" }, a);
    write(path.join(dir, "config.json"), `${FAKE_GITHUB}\n`);
    commitAll(a, dir, "the key");
    gitIn(dir, a.env, "push", "-q", "uno", "main:main");
    gitIn(dir, a.env, "fetch", "-q", "uno");

    const held = await syncProject({ dir, name: "site", hostRemote: "origin" }, a);
    expect(held.held).toContain("config.json");
    expect(exists(path.join(bare, "refs", "heads", "main"))).toBe(false);
  });

  it("reads the whole history before publishing, and leaves no value in the answer", async () => {
    const a = computer("a");
    const dir = path.join(a.home, "projects", "site");
    await startRepository({ dir, name: "site" }, a);
    expect(await keysBeforePublish({ dir }, a)).toEqual([]);
    write(path.join(dir, "config.json"), `${FAKE_KEY}\n`);
    commitAll(a, dir, "key");
    fs.rmSync(path.join(dir, "config.json"));
    commitAll(a, dir, "take it out");
    write(path.join(dir, "secret.pem"), "-----BEGIN-----\n");
    gitIn(dir, a.env, "add", "--force", "secret.pem");
    gitIn(dir, a.env, "commit", "-q", "-m", "a key file");

    const found = await keysBeforePublish({ dir }, a);
    expect(found).toEqual(["config.json", "secret.pem"]);
    expect(heldFromPublishMessage(found)).toContain("Nothing was published");
    expect(heldFromPublishMessage(found)).not.toContain(FAKE_KEY);
    expect(await keysBeforePublish({ dir: a.folder("no-such-folder") }, a)).toEqual([]);
  });

  it("works without the Uno cloud when this computer has no way to it", async () => {
    const a = computer("a");
    const { dir, bare } = await started(a);
    write(path.join(dir, "page.html"), "ok\n");
    commitAll(a, dir, "first page");
    const noCloud = { ...a, env: { ...a.env, [FAKE_STORAGE_ENV]: "" } };

    const result = await syncProject(
      { dir, name: "site", hostRemote: "origin", skipCloud: true },
      noCloud,
    );
    expect(result).toMatchObject({ ok: true, state: "synced", pushed: true });
    expect(hostLog(a, bare)).toContain("first page");
    expect(
      spawnSync("git", ["remote", "get-url", "uno"], { cwd: dir, env: a.env }).status,
    ).not.toBe(0);
  });

  it("a host that can't be reached says so; the Uno cloud still syncs", async () => {
    const a = computer("a");
    const { dir, bare } = await started(a);
    fs.rmSync(bare, { recursive: true });
    write(path.join(dir, "page.html"), "ok\n");
    commitAll(a, dir, "first page");

    const result = await syncProject({ dir, name: "site", hostRemote: "origin" }, a);
    expect(result).toMatchObject({ ok: true, state: "error", pushed: true });
    expect(result.host?.pushed).toBe(false);
    expect(result.message).toMatch(/^origin: /);
    expect(gitIn(dir, a.env, "ls-remote", "uno", "main")).toContain("refs/heads/main");
  });
});
