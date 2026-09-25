import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureOpenCodeSessionEnvFiles,
  OPENCODE_SESSION_ENV_DIR_ENV,
  readOpenCodeSessionEnv,
  removeOpenCodeSessionEnv,
  withOpenCodeSessionEnvPlugin,
  writeOpenCodeSessionEnv,
} from "./opencodeSessionEnv.ts";

type ShellEnvHook = (
  input: { cwd: string; sessionID?: string },
  output: { env: Record<string, string> },
) => Promise<void>;

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-session-env-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[OPENCODE_SESSION_ENV_DIR_ENV];
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const loadHook = async (pluginUrl: string, serverUrl?: string): Promise<ShellEnvHook> => {
  const mod = (await import(`${pluginUrl}?t=${Date.now()}`)) as {
    UnoWorkSessionEnv: (input: unknown) => Promise<{ "shell.env": ShellEnvHook }>;
  };
  const hooks = await mod.UnoWorkSessionEnv({ serverUrl });
  return hooks["shell.env"];
};

describe("opencode session env plugin", () => {
  it("gives each session's shells its own variables and nothing to unknown sessions", async () => {
    const { pluginUrl, envDir } = ensureOpenCodeSessionEnvFiles(stateDir);
    process.env[OPENCODE_SESSION_ENV_DIR_ENV] = envDir;
    writeOpenCodeSessionEnv(envDir, "ses_a", { TOKEN: "a" });
    writeOpenCodeSessionEnv(envDir, "ses_b", { TOKEN: "b" });
    const hook = await loadHook(pluginUrl);

    const outA = { env: {} as Record<string, string> };
    await hook({ cwd: "/tmp", sessionID: "ses_a" }, outA);
    const outB = { env: {} as Record<string, string> };
    await hook({ cwd: "/tmp", sessionID: "ses_b" }, outB);
    const outNone = { env: {} as Record<string, string> };
    await hook({ cwd: "/tmp" }, outNone);
    const outTraversal = { env: {} as Record<string, string> };
    await hook({ cwd: "/tmp", sessionID: "../ses_a" }, outTraversal);

    expect(outA.env).toEqual({ TOKEN: "a" });
    expect(outB.env).toEqual({ TOKEN: "b" });
    expect(outNone.env).toEqual({});
    expect(outTraversal.env).toEqual({});

    removeOpenCodeSessionEnv(envDir, "ses_a");
    const afterRemove = { env: {} as Record<string, string> };
    await hook({ cwd: "/tmp", sessionID: "ses_a" }, afterRemove);
    expect(afterRemove.env).toEqual({});
  });

  it("subagent sessions inherit the variables of their parent", async () => {
    const { pluginUrl, envDir } = ensureOpenCodeSessionEnvFiles(stateDir);
    process.env[OPENCODE_SESSION_ENV_DIR_ENV] = envDir;
    writeOpenCodeSessionEnv(envDir, "ses_parent", { TOKEN: "parent" });
    const fetchMock = vi.fn(async (url: string) => {
      const id = url.split("/").pop();
      return new Response(JSON.stringify(id === "ses_child" ? { parentID: "ses_parent" } : {}), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const hook = await loadHook(pluginUrl, "http://127.0.0.1:4999/");

    const out = { env: {} as Record<string, string> };
    await hook({ cwd: "/tmp", sessionID: "ses_child" }, out);
    expect(out.env).toEqual({ TOKEN: "parent" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4999/session/ses_child",
      expect.anything(),
    );
  });

  it("rewrites the plugin only when it changed and keeps files private", () => {
    const first = ensureOpenCodeSessionEnvFiles(stateDir);
    const pluginPath = new URL(first.pluginUrl).pathname;
    const mtime = fs.statSync(pluginPath).mtimeMs;
    ensureOpenCodeSessionEnvFiles(stateDir);
    expect(fs.statSync(pluginPath).mtimeMs).toBe(mtime);
    expect(fs.statSync(first.envDir).mode & 0o777).toBe(0o700);
    writeOpenCodeSessionEnv(first.envDir, "ses_x", { A: "1" });
    expect(fs.statSync(path.join(first.envDir, "ses_x.json")).mode & 0o777).toBe(0o600);
    expect(writeOpenCodeSessionEnv(first.envDir, "../escape", { A: "1" })).toBe(false);
  });
});

describe("uno-work tool calls on a shared server", () => {
  type ToolHooks = {
    "tool.execute.before": (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ) => Promise<void>;
    "tool.execute.after": (input: {
      tool: string;
      sessionID: string;
      callID: string;
      args: Record<string, unknown>;
    }) => Promise<void>;
  };
  const loadToolHooks = async (pluginUrl: string): Promise<ToolHooks> => {
    const mod = (await import(`${pluginUrl}?t=${Date.now()}`)) as {
      UnoWorkSessionEnv: (input: unknown) => Promise<ToolHooks>;
    };
    return mod.UnoWorkSessionEnv({});
  };

  it("tags uno-work calls with their session and removes the tag afterwards", async () => {
    const { pluginUrl, envDir } = ensureOpenCodeSessionEnvFiles(stateDir);
    process.env[OPENCODE_SESSION_ENV_DIR_ENV] = envDir;
    writeOpenCodeSessionEnv(envDir, "ses_a", { UNO_WORK_BRIDGE_TOKEN: "tok-a" });
    const hooks = await loadToolHooks(pluginUrl);

    const args: Record<string, unknown> = { appId: "notes" };
    await hooks["tool.execute.before"](
      { tool: "uno-work_app_list", sessionID: "ses_a", callID: "c1" },
      { args },
    );
    expect(args).toEqual({ appId: "notes", __uno_work_session: "ses_a" });
    await hooks["tool.execute.after"]({
      tool: "uno-work_app_list",
      sessionID: "ses_a",
      callID: "c1",
      args,
    });
    expect(args).toEqual({ appId: "notes" });

    const other: Record<string, unknown> = { command: "ls" };
    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses_a", callID: "c2" },
      { args: other },
    );
    expect(other).toEqual({ command: "ls" });

    const forged: Record<string, unknown> = { __uno_work_session: "ses_b" };
    await hooks["tool.execute.before"](
      { tool: "uno-work_app_list", sessionID: "ses_a", callID: "c4" },
      { args: forged },
    );
    expect(forged).toEqual({ __uno_work_session: "ses_a" });
    const forgedUnknown: Record<string, unknown> = { __uno_work_session: "ses_a" };
    await hooks["tool.execute.before"](
      { tool: "uno-work_app_list", sessionID: "ses_nobody", callID: "c5" },
      { args: forgedUnknown },
    );
    expect(forgedUnknown).toEqual({});

    const unknown: Record<string, unknown> = {};
    await hooks["tool.execute.before"](
      { tool: "uno-work_app_list", sessionID: "ses_zz", callID: "c3" },
      { args: unknown },
    );
    expect(unknown).toEqual({});
  });

  it("reads back what the daemon wrote, never outside the directory", () => {
    const { envDir } = ensureOpenCodeSessionEnvFiles(stateDir);
    writeOpenCodeSessionEnv(envDir, "ses_a", { UNO_WORK_BRIDGE_TOKEN: "tok-a" });
    expect(readOpenCodeSessionEnv(envDir, "ses_a")).toEqual({ UNO_WORK_BRIDGE_TOKEN: "tok-a" });
    expect(readOpenCodeSessionEnv(envDir, "ses_missing")).toBeUndefined();
    expect(readOpenCodeSessionEnv(envDir, "../ses_a")).toBeUndefined();
  });
});

describe("withOpenCodeSessionEnvPlugin", () => {
  it("adds the plugin to existing config and keeps other plugins", () => {
    expect(JSON.parse(withOpenCodeSessionEnvPlugin(undefined, "file:///p.mjs") ?? "")).toEqual({
      plugin: ["file:///p.mjs"],
    });
    expect(
      JSON.parse(
        withOpenCodeSessionEnvPlugin(JSON.stringify({ a: 1, plugin: ["x"] }), "file:///p.mjs") ??
          "",
      ),
    ).toEqual({ a: 1, plugin: ["x", "file:///p.mjs"] });
    const once = withOpenCodeSessionEnvPlugin("{}", "file:///p.mjs");
    expect(withOpenCodeSessionEnvPlugin(once, "file:///p.mjs")).toBe(once);
  });

  it("leaves a config it can't parse untouched", () => {
    expect(withOpenCodeSessionEnvPlugin("not json", "file:///p.mjs")).toBe("not json");
    expect(withOpenCodeSessionEnvPlugin("[1]", "file:///p.mjs")).toBe("[1]");
  });
});
