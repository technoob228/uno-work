import { spawn } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GIT_CREDENTIAL_HELPER_NAME,
  gitCredentialHelperScript,
  installGitCredentialHelper,
  type GitConfigResult,
} from "./gitCredentialHelper.ts";
import { installHelperForStateDir } from "./GithubAccountService.ts";

// ── The installer, against a pretend git config ───────────────────────

function fakeGitConfig(initial: Record<string, ReadonlyArray<string>> = {}) {
  const values = new Map<string, string[]>(
    Object.entries(initial).map(([key, list]) => [key.toLowerCase(), [...list]]),
  );
  const calls: string[][] = [];
  const run = async (args: ReadonlyArray<string>): Promise<GitConfigResult> => {
    calls.push([...args]);
    const [first, second, third] = args;
    if (first === "--get-all" || first === "--get") {
      const list = values.get((second ?? "").toLowerCase()) ?? [];
      return list.length === 0
        ? { code: 1, stdout: "" }
        : { code: 0, stdout: (first === "--get" ? list.slice(-1) : list).join("\n") + "\n" };
    }
    if (first === "--add") {
      const key = (second ?? "").toLowerCase();
      values.set(key, [...(values.get(key) ?? []), third ?? ""]);
      return { code: 0, stdout: "" };
    }
    values.set((first ?? "").toLowerCase(), [second ?? ""]);
    return { code: 0, stdout: "" };
  };
  return { values, calls, run };
}

function fakeFiles() {
  const files = new Map<string, string>();
  return {
    files,
    mkdir: async () => {},
    readFile: async (path: string) => files.get(path) ?? null,
    writeExecutable: async (path: string, content: string) => {
      files.set(path, content);
    },
    join: (...parts: ReadonlyArray<string>) => parts.join("/"),
  };
}

const HELPER_KEY = "credential.https://github.com.helper";
const PATH_KEY = "credential.https://github.com.usehttppath";

describe("installing git-credential-uno", () => {
  it("adds the helper for github.com only, after the helpers the person already has", async () => {
    const git = fakeGitConfig({ [HELPER_KEY]: ["/usr/bin/gh auth git-credential"] });
    const fs = fakeFiles();
    const result = await installGitCredentialHelper({
      binDir: "/state/bin",
      script: "#!/node\n// v1",
      gitConfigGlobal: git.run,
      ...fs,
    });
    expect(result).toEqual({
      helperPath: "/state/bin/git-credential-uno",
      wroteScript: true,
      addedHelper: true,
      setUseHttpPath: true,
    });
    // Theirs first: git asks helpers in order and stops at the first answer.
    expect(git.values.get(HELPER_KEY)).toEqual([
      "/usr/bin/gh auth git-credential",
      "/state/bin/git-credential-uno",
    ]);
    expect(git.values.get(PATH_KEY)).toEqual(["true"]);
    // Nothing outside the github.com section is touched.
    expect([...git.values.keys()].toSorted()).toEqual([HELPER_KEY, PATH_KEY].toSorted());
  });

  it("changes nothing the second time, and rewrites only a stale script", async () => {
    const git = fakeGitConfig();
    const fs = fakeFiles();
    const deps = { binDir: "/state/bin", gitConfigGlobal: git.run, ...fs };
    await installGitCredentialHelper({ ...deps, script: "v1" });
    const again = await installGitCredentialHelper({ ...deps, script: "v1" });
    expect(again).toMatchObject({ wroteScript: false, addedHelper: false, setUseHttpPath: false });
    expect(git.values.get(HELPER_KEY)).toEqual(["/state/bin/git-credential-uno"]);

    const updated = await installGitCredentialHelper({ ...deps, script: "v2" });
    expect(updated).toMatchObject({ wroteScript: true, addedHelper: false });
    expect(fs.files.get("/state/bin/git-credential-uno")).toBe("v2");
  });

  it("leaves a useHttpPath the person set themselves", async () => {
    const git = fakeGitConfig({ [PATH_KEY]: ["false"] });
    const result = await installGitCredentialHelper({
      binDir: "/state/bin",
      script: "v1",
      gitConfigGlobal: git.run,
      ...fakeFiles(),
    });
    expect(result.setUseHttpPath).toBe(false);
    expect(git.values.get(PATH_KEY)).toEqual(["false"]);
  });

  it("bakes paths in as data, whatever characters they hold", () => {
    const script = gitCredentialHelperScript({
      nodePath: "/opt/node/bin/node",
      settingsPath: `/var/lib/uno "work"/$&/settings.json`,
      baseUrl: "https://console.uno4.dev",
    });
    expect(script.startsWith("#!/opt/node/bin/node\n")).toBe(true);
    expect(script).toContain(JSON.stringify(`/var/lib/uno "work"/$&/settings.json`));
    expect(script).not.toContain("__SETTINGS_PATH__");
    expect(script).not.toContain("__BASE_URL__");
    // A runtime path with a space can't sit in a shebang.
    expect(
      gitCredentialHelperScript({
        nodePath: "/Applications/Uno Work.app/node",
        settingsPath: "/s.json",
        baseUrl: "https://console.uno4.dev",
      }).startsWith("#!/usr/bin/env node\n"),
    ).toBe(true);
  });
});

// ── The helper itself, run by real git against a pretend console ──────
//
// `git credential fill` is what `git clone` / `git push` do before talking to
// the remote; nothing here reaches github.com.

interface ConsoleCall {
  readonly method: string;
  readonly url: string;
  readonly auth: string;
  readonly body: unknown;
}

interface Stand {
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly calls: ConsoleCall[];
  reply: { status: number; body: unknown };
  readonly close: () => Promise<void>;
}

const stands: Stand[] = [];
afterEach(async () => {
  for (const stand of stands.splice(0)) await stand.close();
});

async function makeStand(options?: { readonly machineToken?: boolean }): Promise<Stand> {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "uno-git-cred-"));
  const calls: ConsoleCall[] = [];
  const stand: Stand = {
    dir,
    calls,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_GLOBAL: NodePath.join(dir, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    reply: {
      status: 200,
      body: {
        username: "x-access-token",
        token: "ghs_onehour",
        expires_at: "2099-01-01T00:00:00Z",
        access: "write",
        repo: "octocat/site",
      },
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
  const server = NodeHttp.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(raw);
      } catch {}
      calls.push({
        method: request.method ?? "",
        url: request.url ?? "",
        auth: request.headers.authorization ?? "",
        body,
      });
      response.writeHead(stand.reply.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(stand.reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const settingsPath = NodePath.join(dir, "settings.json");
  NodeFS.writeFileSync(
    settingsPath,
    JSON.stringify(
      options?.machineToken === false
        ? { uno: { apiKey: "unollm_x" } }
        : { uno: { boxToken: "uno_agt_machine", boxId: 2385 } },
    ),
  );
  await installHelperForStateDir({
    stateDir: dir,
    settingsPath,
    baseUrl: `http://127.0.0.1:${port}`,
    env: stand.env,
  });
  stands.push(stand);
  return stand;
}

function git(
  stand: Stand,
  args: ReadonlyArray<string>,
  stdin: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Asynchronous on purpose: the pretend console lives in this process.
    const child = spawn("git", [...args], { env: stand.env, cwd: stand.dir });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const ask = (host: string, path: string) => `protocol=https\nhost=${host}\npath=${path}\n\n`;

describe("git asks git-credential-uno", () => {
  it("gets a one-repository token from the console with the machine token", async () => {
    const stand = await makeStand();
    const result = await git(stand, ["credential", "fill"], ask("github.com", "octocat/site.git"));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("username=x-access-token\n");
    expect(result.stdout).toContain("password=ghs_onehour\n");
    expect(stand.calls).toEqual([
      {
        method: "POST",
        url: "/api/v1/boxes/2385/work/git/github/token",
        auth: "Bearer uno_agt_machine",
        body: { repo: "octocat/site", access: "write" },
      },
    ]);
  });

  it("keeps nothing on disk: not the token, not after git says it worked", async () => {
    const stand = await makeStand();
    const filled = await git(stand, ["credential", "fill"], ask("github.com", "octocat/site.git"));
    // What git does after a successful push.
    await git(stand, ["credential", "approve"], filled.stdout);
    const leftovers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
        const full = NodePath.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (NodeFS.readFileSync(full, "utf8").includes("ghs_onehour")) leftovers.push(full);
      }
    };
    walk(stand.dir);
    expect(leftovers).toEqual([]);
    // Approve did not ask the console for anything either.
    expect(stand.calls).toHaveLength(1);
  });

  it("stays out of the way for other hosts", async () => {
    const stand = await makeStand();
    const result = await git(stand, ["credential", "fill"], ask("gitlab.com", "octocat/site.git"));
    expect(result.code).not.toBe(0); // no helper answered, prompts are off
    expect(stand.calls).toHaveLength(0);
  });

  it("says what to do when GitHub isn't connected, and gives git nothing", async () => {
    const stand = await makeStand();
    stand.reply = {
      status: 409,
      body: { error: "GITHUB_NOT_CONNECTED", code: "GITHUB_NOT_CONNECTED" },
    };
    const result = await git(stand, ["credential", "fill"], ask("github.com", "octocat/site.git"));
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("password=");
    expect(result.stderr).toContain("Uno: GitHub isn't connected to your Uno account yet");

    stand.reply = {
      status: 404,
      body: { error: "GITHUB_REPO_NOT_ALLOWED", code: "GITHUB_REPO_NOT_ALLOWED" },
    };
    const other = await git(stand, ["credential", "fill"], ask("github.com", "octocat/secret"));
    expect(other.stderr).toContain("Uno isn't allowed into octocat/secret");
  });

  it("is silent with an older console and off a linked computer", async () => {
    const old = await makeStand();
    old.reply = { status: 404, body: { error: "NOT_FOUND" } };
    const result = await git(old, ["credential", "fill"], ask("github.com", "octocat/site"));
    expect(result.stderr).not.toContain("Uno:");

    const unlinked = await makeStand({ machineToken: false });
    await git(unlinked, ["credential", "fill"], ask("github.com", "octocat/site"));
    expect(unlinked.calls).toHaveLength(0);
  });

  it("tells a read-only sign-in apart (push is not allowed yet)", async () => {
    const stand = await makeStand();
    stand.reply = {
      status: 200,
      body: { username: "x-access-token", token: "ghs_readonly", access: "read" },
    };
    const result = await git(stand, ["credential", "fill"], ask("github.com", "octocat/site"));
    expect(result.stdout).toContain("password=ghs_readonly\n");
    expect(result.stderr).toContain("read only");
  });

  it("registers itself where git finds it", async () => {
    const stand = await makeStand();
    const helpers = await git(
      stand,
      ["config", "--global", "--get-all", "credential.https://github.com.helper"],
      "",
    );
    expect(helpers.stdout.trim()).toBe(NodePath.join(stand.dir, "bin", GIT_CREDENTIAL_HELPER_NAME));
    const mode = NodeFS.statSync(NodePath.join(stand.dir, "bin", GIT_CREDENTIAL_HELPER_NAME)).mode;
    expect(mode & 0o777).toBe(0o700);
  });
});
