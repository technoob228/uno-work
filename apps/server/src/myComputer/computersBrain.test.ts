/**
 * Computers lifecycle, backend: M7 signed frames, the workspace tools'
 * helpers, the scan and copy commands (run for real in `sh` against a
 * made-up home), plans and wait marks.
 */
import { execFileSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  chosenKeysCommand,
  displayPathOf,
  parseEnvLines,
  parseScan,
  scanCommand,
} from "./bringWork.ts";
import { CLAUDE_WORKSPACE_ALIASES, claudeWorkspaceOptions } from "./computerWorkspaceHarness.ts";
import { makeWaitMarks, planOf } from "./ComputerWorkspaces.ts";
import { computerRow, startFakeConsole, waitFor, type FakeConsole } from "./fakeConsole.testkit.ts";
import { keyOwner, loadOrCreateBoxKey, signFrame } from "./frameSigning.ts";
import { createMyComputerCore, parseComputers, parseComputersMeta } from "./myComputerCore.ts";
import { packCommand, parsePackAnswer } from "./projectCopy.ts";
import {
  countOccurrences,
  globToRegExp,
  grepCommand,
  listFilesCommand,
  numberLines,
  resolveOnComputer,
  shQuote,
} from "./workspaceTools.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "computers-brain-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sh = (command: string, env: Record<string, string> = {}) =>
  execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { ...process.env, ...env } });

describe("M7: this computer's key and signed frames", () => {
  it("keeps one key per owner, makes a new one for another owner (an image clone)", async () => {
    const first = await loadOrCreateBoxKey(dir, "box:7");
    const again = await loadOrCreateBoxKey(dir, "box:7");
    expect(again.kid).toBe(first.kid);
    expect(statSync(path.join(dir, "my-computer", "box-key.json")).mode & 0o777).toBe(0o600);
    const clone = await loadOrCreateBoxKey(dir, "box:8");
    expect(clone.kid).not.toBe(first.kid);
    expect(Buffer.from(first.publicKey, "base64")).toHaveLength(32);
    expect(first.kid).toMatch(/^[0-9a-f]{16}$/);
  });

  it("owner: the box id, else a fingerprint of the token, else nothing", () => {
    expect(keyOwner({ boxId: 5, token: "t" })).toBe("box:5");
    expect(keyOwner({ boxId: null, token: "uno_box_x" })).toMatch(/^token:[0-9a-f]{16}$/);
    expect(keyOwner({ boxId: null, token: "" })).toBe("");
  });

  it("signs the inner JSON with id, computer, time and nonce; the signature verifies", async () => {
    const key = await loadOrCreateBoxKey(dir, "box:1");
    const envelope = signFrame({
      key,
      id: "9",
      computerId: "c1",
      frame: { op: "exec", cmd: "ls" },
      now: 1_000,
    });
    expect(envelope).toMatchObject({ v: 2, id: "9", kid: key.kid });
    const inner = JSON.parse(envelope.p) as Record<string, unknown>;
    expect(inner).toMatchObject({ op: "exec", cmd: "ls", id: "9", computerId: "c1", ts: 1_000 });
    expect(typeof inner.nonce).toBe("string");
    const publicKey = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(key.publicKey, "base64").toString("base64url"),
      },
      format: "jwk",
    });
    expect(
      verify(null, Buffer.from(envelope.p), publicKey, Buffer.from(envelope.sig, "base64")),
    ).toBe(true);
    // Another frame, another nonce.
    const second = signFrame({
      key,
      id: "9",
      computerId: "c1",
      frame: { op: "exec", cmd: "ls" },
      now: 1_000,
    });
    expect(JSON.parse(second.p).nonce).not.toBe(inner.nonce);
  });
});

describe("the console's extra fields", () => {
  it("reads mode, M7 state, the flag and the helper version", () => {
    const body = {
      enabled: true,
      lifecycle: true,
      helper: { latestVersion: "2026.11.03" },
      computers: [
        computerRow({ id: "c1", mode: "full", signedFrames: true, trustsThisBox: false }),
        computerRow({ id: "c2" }),
      ],
    };
    const meta = parseComputersMeta(body);
    expect(meta.lifecycle).toBe(true);
    expect(meta.latestHelperVersion).toBe("2026.11.03");
    expect(meta.computers.get("c1")).toEqual({
      mode: "full",
      signedFrames: true,
      trustsThisBox: false,
    });
    expect(meta.computers.get("c2")).toEqual({
      mode: null,
      signedFrames: false,
      trustsThisBox: null,
    });
    const status = parseComputers(body);
    expect(status.lifecycle).toBe(true);
    expect(status.computers[0]).toMatchObject({ mode: "full", trustsThisComputer: false });
    expect(status.computers[1]!.mode).toBeUndefined();
  });
});

describe("signed channels against a fake console", () => {
  let fake: FakeConsole;
  beforeEach(async () => {
    fake = await startFakeConsole();
  });
  afterEach(async () => {
    await fake.close();
  });

  const makeCore = () =>
    createMyComputerCore({
      token: async () => fake.token,
      boxId: async () => 42,
      baseUrl: () => fake.baseUrl,
      stateDir: dir,
    });

  it("a helper of M7 gets v2 frames; this computer's key is registered first", async () => {
    fake.listing = {
      status: 200,
      body: {
        enabled: true,
        computers: [computerRow({ signedFrames: true, trustsThisBox: true })],
      },
    };
    fake.helper = (frame, reply) => reply({ type: "result", entries: [] });
    const core = makeCore();
    try {
      await core.status();
      await core.list({ computerId: "c1", path: "~" });
      const frame = fake.frames()[0]!;
      expect(frame.v).toBe(2);
      expect(typeof frame.sig).toBe("string");
      const inner = JSON.parse(String(frame.p)) as Record<string, unknown>;
      expect(inner).toMatchObject({ op: "list", path: "~", computerId: "c1" });
      await waitFor(() =>
        fake.requests.some((request) => request.path === "/api/v1/work/computers/box-key"),
      );
      const put = fake.requests.find(
        (request) => request.path === "/api/v1/work/computers/box-key",
      )!;
      expect(put.method).toBe("PUT");
      expect(
        Buffer.from(String((put.body as { publicKey: string }).publicKey), "base64"),
      ).toHaveLength(32);
    } finally {
      core.closeAll();
    }
  });

  it("an older helper keeps getting v1 frames (the transition)", async () => {
    fake.listing = { status: 200, body: { enabled: true, computers: [computerRow()] } };
    fake.helper = (frame, reply) => reply({ type: "result", entries: [] });
    const core = makeCore();
    try {
      await core.status();
      await core.list({ computerId: "c1", path: "~" });
      expect(fake.frames()[0]).toMatchObject({ v: 1, op: "list" });
    } finally {
      core.closeAll();
    }
  });

  it("a helper that doesn't trust this computer: a clear sentence, nothing sent", async () => {
    fake.listing = {
      status: 200,
      body: {
        enabled: true,
        computers: [computerRow({ signedFrames: true, trustsThisBox: false })],
      },
    };
    const core = makeCore();
    try {
      await core.status();
      await expect(core.list({ computerId: "c1", path: "~" })).rejects.toThrow(
        /doesn't trust this cloud computer/,
      );
      expect(fake.channels).toHaveLength(0);
    } finally {
      core.closeAll();
    }
  });

  it("the helper's refusal code becomes a sentence the agent can act on", async () => {
    fake.listing = {
      status: 200,
      body: {
        enabled: true,
        computers: [computerRow({ signedFrames: true, trustsThisBox: true })],
      },
    };
    fake.helper = (frame, reply) => reply({ type: "error", code: "stale_frame", message: "x" });
    const core = makeCore();
    try {
      await core.status();
      await expect(core.list({ computerId: "c1", path: "~" })).rejects.toThrow(/clock/);
    } finally {
      core.closeAll();
    }
  });

  it("setMode is a PATCH with the mode", async () => {
    fake.listing = { status: 200, body: { enabled: true, computers: [computerRow()] } };
    const core = makeCore();
    await core.setMode("c1", "full");
    const patch = fake.requests.find((request) => request.method === "PATCH")!;
    expect(patch.path).toBe("/api/v1/work/computers/c1");
    expect(patch.body).toEqual({ mode: "full" });
  });
});

describe("workspace tools: paths, lines, edits, globs", () => {
  const plan = { computerId: "c1", computerName: "MacBook", path: "/Users/m/projects/app" };

  it("resolves paths inside the project, keeps absolute and ~", () => {
    expect(resolveOnComputer(plan, "src/a.ts")).toBe("/Users/m/projects/app/src/a.ts");
    expect(resolveOnComputer(plan, undefined)).toBe("/Users/m/projects/app");
    expect(resolveOnComputer(plan, "/etc/hosts")).toBe("/etc/hosts");
    expect(resolveOnComputer(plan, "~/notes.txt")).toBe("~/notes.txt");
    const win = { ...plan, path: "C:\\Users\\m\\app" };
    expect(resolveOnComputer(win, "src\\a.ts")).toBe("C:\\Users\\m\\app\\src\\a.ts");
    expect(resolveOnComputer(win, "D:\\x")).toBe("D:\\x");
  });

  it("numbers lines like cat -n, from an offset, with a limit", () => {
    const shown = numberLines("a\nb\nc\nd\n", 2, 2);
    expect(shown.body).toBe("     2\tb\n     3\tc");
    expect(shown.total).toBe(4);
  });

  it("counts occurrences without overlap", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abc", "x")).toBe(0);
  });

  it("globs like agents expect", () => {
    expect(globToRegExp("*.ts").test("src/deep/a.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("lib/a.ts")).toBe(false);
    expect(globToRegExp("*.{json,yaml}").test("conf/x.yaml")).toBe(true);
    expect(globToRegExp("test_?.py").test("test_1.py")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });

  it("quotes anything for sh", () => {
    expect(sh(`printf %s ${shQuote("it's $HOME `x`")}`)).toBe("it's $HOME `x`");
  });

  it("finds files and searches in one command (run in sh)", () => {
    const project = path.join(dir, "proj");
    mkdirSync(path.join(project, "src"), { recursive: true });
    mkdirSync(path.join(project, "node_modules", "x"), { recursive: true });
    writeFileSync(path.join(project, "src", "a.ts"), "const needle = 1;\nother\n");
    writeFileSync(path.join(project, "node_modules", "x", "b.ts"), "needle\n");
    const files = sh(listFilesCommand(project, false)).trim().split("\n").toSorted();
    expect(files).toEqual(["src/a.ts"]);
    const found = sh(
      grepCommand(
        { pattern: "need[l]e", dir: project, ignoreCase: false, mode: "content", headLimit: 10 },
        false,
      ),
    );
    expect(found).toContain("a.ts:1:const needle = 1;");
    expect(found).not.toContain("node_modules");
    const names = sh(
      grepCommand(
        {
          pattern: "NEEDLE",
          dir: project,
          ignoreCase: true,
          mode: "files_with_matches",
          headLimit: 10,
        },
        false,
      ),
    );
    expect(names.trim()).toBe(path.join(project, "src", "a.ts"));
    // No ripgrep there: plain grep, same answer.
    const plain = sh(
      grepCommand(
        { pattern: "need[l]e", dir: project, ignoreCase: false, mode: "count", headLimit: 10 },
        false,
      ),
      { PATH: "/usr/bin:/bin" },
    );
    expect(plain.trim()).toBe(`${path.join(project, "src", "a.ts")}:1`);
    // Claude's Grep fields: lines after, a file type, skipping lines; rg and grep alike.
    writeFileSync(path.join(project, "src", "b.py"), "needle\n");
    for (const env of [{}, { PATH: "/usr/bin:/bin" }]) {
      const after = sh(
        grepCommand(
          {
            pattern: "need[l]e",
            dir: project,
            ignoreCase: false,
            mode: "content",
            after: 1,
            type: "ts",
            headLimit: 10,
          },
          false,
        ),
        env,
      );
      expect(after).toContain("a.ts:1:const needle = 1;");
      expect(after).toContain("other");
      expect(after).not.toContain("b.py");
      const skipped = sh(
        grepCommand(
          {
            pattern: "need[l]e",
            dir: project,
            ignoreCase: false,
            mode: "files_with_matches",
            offset: 1,
            headLimit: 10,
          },
          false,
        ),
        env,
      );
      expect(skipped.trim().split("\n")).toHaveLength(1);
    }
  });

  it("leaves out what LS is told to ignore", () => {
    expect(globToRegExp("node_modules").test("node_modules")).toBe(true);
    expect(globToRegExp("*.log").test("app.log")).toBe(true);
    expect(globToRegExp("*.log").test("app.ts")).toBe(false);
  });

  it("Claude's built-ins point at the workspace tools", () => {
    const options = claudeWorkspaceOptions(plan);
    expect(options.disallowedTools).toContain("Bash");
    expect(options.disallowedTools).toContain("Edit");
    expect(CLAUDE_WORKSPACE_ALIASES.Bash).toBe("mcp__uno-work__workspace_bash");
    expect(options.note).toContain("/Users/m/projects/app");
    expect(options.note).toContain("mcp__uno-work__workspace_grep");
  });
});

describe("bring your work: the scan (run in sh) and the keys", () => {
  it("lists git folders in ~/projects and chat folders, with key NAMES only", () => {
    const home = path.join(dir, "home");
    const app = path.join(home, "projects", "app");
    const plain = path.join(home, "projects", "plain");
    const elsewhere = path.join(dir, "work", "api");
    mkdirSync(path.join(app, ".git"), { recursive: true });
    mkdirSync(plain, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(
      path.join(app, ".env"),
      "# comment\nexport OPENAI_KEY=sk-secret-value\nDB_URL = postgres://u:p@h/db\nnot a key\n1BAD=x\n",
    );
    const output = sh(scanCommand([elsewhere, path.join(dir, "missing")], false), { HOME: home });
    expect(output).not.toContain("sk-secret-value");
    expect(output).not.toContain("postgres://");
    const parsed = parseScan(output);
    expect(parsed.home).toBe(home);
    expect(parsed.projects.map((entry) => entry.path)).toEqual([app, elsewhere]);
    expect(parsed.projects[0]).toEqual({ path: app, git: true, keys: ["DB_URL", "OPENAI_KEY"] });
    expect(parsed.projects[1]!.git).toBe(false);
    expect(displayPathOf(app, home)).toBe("~/projects/app");
  });

  it("works with no chat folders at all", () => {
    const home = path.join(dir, "home");
    mkdirSync(path.join(home, "projects", "x", ".git"), { recursive: true });
    expect(parseScan(sh(scanCommand([], false), { HOME: home })).projects).toHaveLength(1);
  });

  it("reads only the chosen keys' lines, and parses dotenv values", () => {
    const project = path.join(dir, "p");
    mkdirSync(project);
    writeFileSync(
      path.join(project, ".env"),
      `A=1\nexport B="two words"\nC='single'\nD=plain # note\nSECRET=never\n`,
    );
    const output = sh(
      chosenKeysCommand(project, ["A", "B", "C", "D", "bad name; rm -rf /"], false),
    );
    expect(output).not.toContain("never");
    const values = parseEnvLines(output);
    expect(Object.fromEntries(values)).toEqual({ A: "1", B: "two words", C: "single", D: "plain" });
  });
});

describe("copying a project over (pack command run in sh)", () => {
  it("packs without .env and node_modules and says where the archive is", () => {
    const project = path.join(dir, "proj");
    mkdirSync(path.join(project, "node_modules", "m"), { recursive: true });
    mkdirSync(path.join(project, ".git"), { recursive: true });
    writeFileSync(path.join(project, "index.js"), "1");
    writeFileSync(path.join(project, ".env"), "KEY=secret");
    writeFileSync(path.join(project, ".git", "HEAD"), "ref");
    writeFileSync(path.join(project, "node_modules", "m", "x.js"), "1");
    const answer = parsePackAnswer(sh(packCommand(project, false), { TMPDIR: dir }));
    expect(answer).not.toBeNull();
    expect(answer!.bytes).toBe(statSync(answer!.file).size);
    const listing = execFileSync("tar", ["-tzf", answer!.file], { encoding: "utf8" });
    expect(listing).toContain("index.js");
    expect(listing).toContain(".git/HEAD");
    expect(listing).not.toContain(".env");
    expect(listing).not.toContain("node_modules");
    rmSync(answer!.file);
  });

  it("parses a path with spaces", () => {
    expect(parsePackAnswer("x\nUNO_COPY /tmp/a b/c.tgz 123\n")).toEqual({
      file: "/tmp/a b/c.tgz",
      bytes: 123,
    });
    expect(parsePackAnswer("nothing")).toBeNull();
  });
});

describe("where a chat's project is", () => {
  it("the project's computer, else an imported chat's folder, else here", () => {
    const computer = { computerId: "c1", computerName: "MacBook", path: "/x" };
    expect(planOf({ projectId: "p" }, { computer })).toEqual(computer);
    expect(
      planOf(
        { projectId: "p", source: { computerId: "c2", computerName: "PC", cwd: "/y" } },
        { computer: null },
      ),
    ).toEqual({ computerId: "c2", computerName: "PC", path: "/y" });
    expect(
      planOf({ projectId: "p", source: { computerId: "c2", computerName: "PC", cwd: null } }, null),
    ).toBeNull();
    expect(planOf({ projectId: "p" }, null)).toBeNull();
  });

  it("one wait mark per chat however many calls wait", async () => {
    const applied: Array<string | null> = [];
    const mark = makeWaitMarks<string>((threadId, value) =>
      Effect.sync(() => {
        applied.push(value === null ? null : `${threadId}:${value}`);
      }),
    );
    await Effect.runPromise(mark("t", "a"));
    await Effect.runPromise(mark("t", "b"));
    await Effect.runPromise(mark("t", null));
    expect(applied).toEqual(["t:a"]);
    await Effect.runPromise(mark("t", null));
    expect(applied).toEqual(["t:a", null]);
    await Effect.runPromise(mark("t", null));
    expect(applied).toEqual(["t:a", null]);
  });
});
