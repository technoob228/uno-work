/**
 * "Bring your work" for developers (13.11): where projects are looked for,
 * which key names are found, and what never comes over. The commands run for
 * real in `sh` against a made-up home; the whole bring runs against a fake
 * computer whose commands also run in `sh`, so the copy and the key reading
 * are the real ones.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SCAN_ROOTS,
  chosenKeysCommand,
  createBringWork,
  parseEnvLines,
  parseScan,
  scanCommand,
} from "./bringWork.ts";
import type { ExecInput, MyComputerCore, ReadInput } from "./myComputerCore.ts";
import { packCommand, parsePackAnswer, settleTrackedEnvFiles } from "./projectCopy.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "bring-work-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sh = (command: string, env: Record<string, string> = {}) =>
  execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { ...process.env, ...env } });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

function repo(at: string) {
  mkdirSync(path.join(at, ".git"), { recursive: true });
  return at;
}

describe("the scan: where developers keep projects", () => {
  it("looks one level into every usual folder, git folders only", () => {
    const home = path.join(dir, "home");
    const found = SCAN_ROOTS.map((root) =>
      repo(path.join(home, root, `app-${root.replace("/", "-")}`)),
    );
    // Not a repository, and a repository two levels down: neither is a project.
    mkdirSync(path.join(home, "code", "notes"), { recursive: true });
    repo(path.join(home, "code", "group", "deep"));
    // A folder that isn't one of the usual ones.
    repo(path.join(home, "Desktop", "x"));
    const parsed = parseScan(sh(scanCommand([], false), { HOME: home }));
    expect(parsed.projects.map((entry) => entry.path)).toEqual(found);
    expect(parsed.projects.every((entry) => entry.git && !entry.chat)).toBe(true);
  });

  it("one row per folder: a symlinked root and a chat in a listed folder", () => {
    const home = path.join(dir, "home");
    const app = repo(path.join(home, "Developer", "app"));
    // ~/code → ~/Developer: the same folder twice.
    symlinkSync(path.join(home, "Developer"), path.join(home, "code"));
    const elsewhere = path.join(dir, "work", "api");
    mkdirSync(elsewhere, { recursive: true });
    const parsed = parseScan(sh(scanCommand([app, elsewhere], false), { HOME: home }));
    // ~/code comes first in the list: its spelling stays, the chat in ~/Developer/app marks it.
    expect(parsed.projects.map((entry) => [entry.path, entry.chat])).toEqual([
      [path.join(home, "code", "app"), true],
      [elsewhere, true],
    ]);
  });

  it("a chat folder reached through another spelling still marks the project", () => {
    const home = path.join(dir, "home");
    const app = repo(path.join(home, "projects", "app"));
    symlinkSync(path.join(home, "projects"), path.join(dir, "alias"));
    const parsed = parseScan(
      sh(scanCommand([path.join(dir, "alias", "app")], false), { HOME: home }),
    );
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0]).toMatchObject({ path: app, chat: true });
  });

  it("keeps the overall limit of 200 projects", () => {
    const home = path.join(dir, "home");
    for (let index = 0; index < 120; index++) repo(path.join(home, "projects", `p${index}`));
    for (let index = 0; index < 120; index++) repo(path.join(home, "code", `c${index}`));
    const parsed = parseScan(sh(scanCommand([], false), { HOME: home }));
    expect(parsed.projects).toHaveLength(200);
  });

  it("key names from .env and .env.local, once each — never a value", () => {
    const home = path.join(dir, "home");
    const app = repo(path.join(home, "code", "app"));
    writeFileSync(path.join(app, ".env"), "export OPENAI_KEY=sk-from-env\nSHARED=env-value\n");
    writeFileSync(path.join(app, ".env.local"), "SHARED=local-value\nLOCAL_ONLY='q v'\n");
    writeFileSync(path.join(app, ".env.production"), "PROD_SECRET=prod-value\n");
    const output = sh(scanCommand([], false), { HOME: home });
    for (const value of ["sk-from-env", "env-value", "local-value", "q v", "prod-value"]) {
      expect(output).not.toContain(value);
    }
    expect(parseScan(output).projects[0]!.keys).toEqual(["LOCAL_ONLY", "OPENAI_KEY", "SHARED"]);
  });

  it("the Windows command looks in the same folders and the real Documents", () => {
    const command = scanCommand(["C:\\Users\\m\\chat's"], true);
    for (const root of SCAN_ROOTS) expect(command).toContain(`'${root.replace("/", "\\")}'`);
    expect(command).toContain("GetFolderPath('MyDocuments')");
    expect(command).toContain("'.env', '.env.local'");
    expect(command).toContain("OrdinalIgnoreCase");
    expect(command).toContain("'C:\\Users\\m\\chat''s'");
    expect(command).toContain("-First 200");
  });
});

describe("reading the chosen keys", () => {
  it(".env, then .env.local wins; an unchosen key is never printed", () => {
    const project = path.join(dir, "p");
    mkdirSync(project);
    writeFileSync(path.join(project, ".env"), "A=from-env\nB=only-env\nSECRET=never-env\n");
    writeFileSync(path.join(project, ".env.local"), "A=from-local\nSECRET=never-local\n");
    const output = sh(chosenKeysCommand(project, ["A", "B"], false));
    expect(output).not.toContain("never");
    expect(Object.fromEntries(parseEnvLines(output))).toEqual({ A: "from-local", B: "only-env" });
    // Only .env.local, and no safe name at all.
    rmSync(path.join(project, ".env"));
    expect(Object.fromEntries(parseEnvLines(sh(chosenKeysCommand(project, ["A"], false))))).toEqual(
      { A: "from-local" },
    );
    expect(sh(chosenKeysCommand(project, ["bad name"], false))).toBe("");
  });
});

describe("what never comes over as a file", () => {
  it("no .env* with values in the archive, at any depth", () => {
    const project = path.join(dir, "proj");
    mkdirSync(path.join(project, "apps", "web"), { recursive: true });
    writeFileSync(path.join(project, "index.js"), "1");
    for (const name of [".env", ".env.local", ".env.production", ".env.development.local"]) {
      writeFileSync(path.join(project, name), `KEY=${name}-value`);
    }
    writeFileSync(path.join(project, "apps", "web", ".env.local"), "KEY=nested-value");
    writeFileSync(path.join(project, ".env.example"), "KEY=");
    const answer = parsePackAnswer(sh(packCommand(project, false), { TMPDIR: dir }));
    const listing = execFileSync("tar", ["-tzf", answer!.file], { encoding: "utf8" });
    expect(listing).toContain("index.js");
    expect(listing.split("\n").filter((entry) => /(^|\/)\.env/.test(entry))).toEqual([]);
    rmSync(answer!.file);
  });

  it("tracked templates come back from the repository's history, other tracked .env* stay out", async () => {
    const project = path.join(dir, "repo");
    mkdirSync(path.join(project, "config"), { recursive: true });
    git(dir, "init", "-q", project);
    writeFileSync(path.join(project, ".env.example"), "API_KEY=\n");
    writeFileSync(path.join(project, "config", ".env.sample"), "DB_URL=\n");
    writeFileSync(path.join(project, ".env.development"), "PUBLIC_URL=http://localhost\n");
    writeFileSync(path.join(project, "index.js"), "1");
    git(project, "add", "-A");
    git(project, "commit", "-qm", "init");
    // The laptop's own edits are never what comes back.
    writeFileSync(path.join(project, ".env.example"), "API_KEY=sk-local-edit\n");
    // What the copy leaves: every .env* file out.
    for (const name of [".env.example", "config/.env.sample", ".env.development"]) {
      rmSync(path.join(project, name));
    }
    const result = await settleTrackedEnvFiles(project);
    expect(result.restored.toSorted()).toEqual([".env.example", "config/.env.sample"]);
    expect(result.hidden).toEqual([".env.development"]);
    expect(readFileSync(path.join(project, ".env.example"), "utf8")).toBe("API_KEY=\n");
    expect(existsSync(path.join(project, ".env.development"))).toBe(false);
    // Nothing looks deleted: an agent's `git add -A` commits no deletion.
    expect(git(project, "status", "--porcelain")).toBe("");
  });

  it("does nothing in a folder that isn't a repository", async () => {
    mkdirSync(path.join(dir, "plain"));
    await expect(settleTrackedEnvFiles(path.join(dir, "plain"))).resolves.toEqual({
      restored: [],
      hidden: [],
    });
  });
});

describe("bringing a project over (fake computer, real sh)", () => {
  it("copies without .env*, keeps only the chosen keys, logs no value", async () => {
    const laptopHome = path.join(dir, "laptop");
    const app = repo(path.join(laptopHome, "code", "shop"));
    writeFileSync(path.join(app, "index.js"), "1");
    writeFileSync(path.join(app, ".env"), "STRIPE_KEY=sk-env\nUNCHOSEN=never-read\n");
    writeFileSync(path.join(app, ".env.local"), "STRIPE_KEY=sk-local\nBROKEN=broken-value\n");
    const cloudHome = path.join(dir, "cloud");
    mkdirSync(cloudHome);

    const commands: Array<string> = [];
    const core = {
      status: async () => ({
        enabled: true,
        computers: [
          {
            id: "41",
            name: "MacBook",
            os: "darwin",
            arch: "arm64",
            online: true,
            connectedAt: null,
            lastSeenAt: null,
            helperVersion: "0.4.0",
          },
        ],
      }),
      exec: async (input: ExecInput) => {
        commands.push(input.cmd);
        let text = "";
        let exitCode = 0;
        try {
          text = sh(input.cmd, { HOME: laptopHome, TMPDIR: dir });
        } catch (error) {
          text = String((error as { stdout?: string }).stdout ?? "");
          exitCode = (error as { status?: number }).status ?? 1;
        }
        return { text, cutBytes: 0, exitCode, signal: null, timedOut: false, durationMs: 1 };
      },
      read: async (input: ReadInput) => {
        const handle = await open(input.path, "r");
        try {
          const buffer = Buffer.alloc(input.maxBytes);
          const { bytesRead } = await handle.read(buffer, 0, input.maxBytes, input.offset ?? 0);
          return {
            data: buffer.subarray(0, bytesRead),
            offset: input.offset ?? 0,
            eof: bytesRead < input.maxBytes,
          };
        } finally {
          await handle.close();
        }
      },
    } as unknown as MyComputerCore;

    const saved = new Map<string, string>();
    const warnings: Array<string> = [];
    const bring = createBringWork({
      stateDir: path.join(dir, "state"),
      home: cloudHome,
      core,
      chatFolders: async () => [],
      projectFor: async () => "project-shop",
      syncOn: async () => undefined,
      setKey: async (_projectId, name, value) => {
        if (name === "BROKEN") throw new Error("vault refused it");
        saved.set(name, value);
      },
      warn: (message) => warnings.push(message),
    });

    await bring.scan("41");
    await expect.poll(async () => (await bring.status("41")).scan.state).toBe("ready");
    const scanned = (await bring.status("41")).scan.projects;
    expect(scanned.map((entry) => [entry.name, entry.keys])).toEqual([
      ["shop", ["BROKEN", "STRIPE_KEY", "UNCHOSEN"]],
    ]);

    await bring.bring("41", [{ path: app, keys: ["STRIPE_KEY", "BROKEN"] }]);
    await expect.poll(async () => (await bring.status("41")).bring.state).toBe("done");
    const result = (await bring.status("41")).bring.results[0]!;
    const folder = path.join(cloudHome, "projects", "shop");
    expect(result).toMatchObject({ ok: true, keysSaved: 1, projectId: "project-shop", folder });
    expect(result.message).toContain("1 of the chosen keys");

    // The copy: the code, no key file.
    expect(readdirSync(folder).toSorted()).toEqual([".git", "index.js"]);
    // The vault: the chosen key, its .env.local value; the unchosen one never read.
    expect(Object.fromEntries(saved)).toEqual({ STRIPE_KEY: "sk-local" });
    expect(commands.join("\n")).not.toContain("UNCHOSEN");
    // Logs: the key's name and why, never a value.
    expect(warnings).toHaveLength(1);
    for (const value of ["sk-env", "sk-local", "broken-value", "never-read"]) {
      expect(warnings.join("\n")).not.toContain(value);
      expect(result.message ?? "").not.toContain(value);
    }
  });
});
