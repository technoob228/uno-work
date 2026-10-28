/**
 * `uno project sync|get|ls` end to end: the real `uno` command and real git,
 * the cloud kept in a folder (UNO_GIT_FAKE_STORAGE_DIR), a temp HOME.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FAKE_STORAGE_ENV } from "./git-remote-uno.mjs";
import { planCommand } from "./uno-cli.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "uno-cli.mjs");

let root = "";
let home = "";
let env: NodeJS.ProcessEnv = {};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uno-project-")));
  home = path.join(root, "home");
  const bin = path.join(root, "bin");
  for (const dir of [home, bin, path.join(root, "cloud")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "git-remote-uno"),
    `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(path.join(here, "git-remote-uno.mjs")).href)}).then((h) => h.main(process.argv.slice(2)));\n`,
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
    [FAKE_STORAGE_ENV]: path.join(root, "cloud"),
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function uno(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function repo(dirName: string, file = "index.html") {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, file), `${dirName}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

describe("uno project", { timeout: 60_000 }, () => {
  it("plans names and folders, refusing names that can't be", () => {
    const where = { cwd: "/home/me/x", home: "/home/me" };
    expect(planCommand(["project", "get", "notes"], where)).toEqual({
      kind: "project-get",
      name: "notes",
      dir: "/home/me/projects/notes",
    });
    expect(planCommand(["project", "sync", "--name", "site"], where)).toEqual({
      kind: "project-sync",
      dir: "/home/me/x",
      name: "site",
    });
    expect(planCommand(["project", "get", "Bad/Name"], where)).toMatchObject({
      kind: "usage-error",
    });
  });

  it("saves a project here and gets it on another computer, both ways", () => {
    const a = repo("My Site");
    const saved = uno(a, "project", "sync");
    expect(saved.stderr).not.toMatch(/^uno: /m);
    expect(saved.code).toBe(0);
    expect(saved.stdout).toContain(
      "Saved to your Uno cloud as my-site. On another computer: uno project get my-site",
    );
    expect(git(a, "remote", "get-url", "uno")).toBe("uno::my-site");

    // "Another computer": a fresh folder, the default place ~/projects/<name>.
    const got = uno(root, "project", "get", "my-site");
    expect(got.code).toBe(0);
    const b = path.join(home, "projects", "my-site");
    expect(fs.readFileSync(path.join(b, "index.html"), "utf8")).toBe("My Site\n");

    fs.writeFileSync(path.join(b, "about.html"), "about\n");
    git(b, "add", "-A");
    git(b, "commit", "-q", "-m", "about");
    git(b, "tag", "v1");
    expect(uno(b, "project", "sync").code).toBe(0);

    // Back on the first computer: get again = bring it up to date.
    const again = uno(root, "project", "get", "my-site", a);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("up to date");
    expect(fs.existsSync(path.join(a, "about.html"))).toBe(true);

    const listed = uno(root, "project", "ls");
    expect(listed.stdout).toMatch(/^my-site {2}saved \d{4}-\d\d-\d\d \d\d:\d\d {2}from /);
  });

  it("won't mix a different project into a name that's taken", () => {
    expect(uno(repo("one/app"), "project", "sync").code).toBe(0);
    const other = repo("two/app");
    const refused = uno(other, "project", "sync");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('"app" in the Uno cloud is a different project');
    expect(refused.stderr).toContain("uno project sync --name app-2");
    // Nothing was left behind: no remote, no scratch refs.
    expect(git(other, "remote")).toBe("");
    expect(git(other, "for-each-ref", "refs/uno-check/")).toBe("");

    expect(uno(other, "project", "sync", "--name", "app-2").code).toBe(0);
    expect(
      uno(root, "project", "ls")
        .stdout.split("\n")
        .map((line) => line.split(" ")[0]),
    ).toEqual(expect.arrayContaining(["app", "app-2"]));
  });

  it("says what to do in an empty folder, without commits, and for an unknown name", () => {
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    const empty = uno(plain, "project", "sync");
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("Nothing to sync yet");

    git(plain, "init", "-q");
    expect(uno(plain, "project", "sync").stderr).toContain("Nothing to save yet");

    const missing = uno(root, "project", "get", "nope");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('There\'s no project "nope" in your Uno cloud');
  });

  it("keeps a folder without git in the cloud and gets it elsewhere, without .env", () => {
    const docs = path.join(root, "Docs");
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, "notes.md"), "notes\n");
    fs.writeFileSync(path.join(docs, ".env"), "KEY=1\n");
    const saved = uno(docs, "project", "sync");
    expect(saved.stderr).toBe("");
    expect(saved.stdout).toContain("Saved to your Uno cloud as docs");
    expect(fs.existsSync(path.join(docs, ".git"))).toBe(false);

    const there = path.join(root, "elsewhere");
    const got = uno(root, "project", "get", "docs", there, "--json");
    expect(got.code).toBe(0);
    expect(JSON.parse(got.stdout)).toMatchObject({ ok: true, state: "synced", mode: "snapshot" });
    expect(fs.readFileSync(path.join(there, "notes.md"), "utf8")).toBe("notes\n");
    expect(fs.existsSync(path.join(there, ".env"))).toBe(false);
  });
});
