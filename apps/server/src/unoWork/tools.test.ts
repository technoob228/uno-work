import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RuntimeMode, ServerSettings, UnoMachineApp } from "@t3tools/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { InboxPost } from "../inbox/inboxModel.ts";
import { handleMcpMessage } from "../mcp/mcpJsonRpc.ts";
import { validateArgs, type JsonSchema } from "./argsSchema.ts";
import { decideUnoWorkGate } from "./policy.ts";
import {
  UNO_WORK_MCP_SERVER,
  UNO_WORK_TOOLS,
  runUnoWorkTool,
  toolLevel,
  type UnoWorkTool,
  type UnoWorkToolDeps,
} from "./tools.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function app(overrides: Partial<UnoMachineApp> = {}): UnoMachineApp {
  return {
    id: "manifest:notes",
    source: "manifest",
    name: "Notes",
    description: null,
    icon: "📝",
    iconImage: null,
    status: "running",
    port: 3000,
    udpPorts: [],
    http: true,
    loopbackOnly: false,
    detail: null,
    url: null,
    localUrl: "http://localhost:3000/",
    publication: null,
    canStart: false,
    canStop: true,
    ...overrides,
  } as UnoMachineApp;
}

interface Recorded {
  approvals: Array<{ tool: string; title: string; sensitive: boolean }>;
  actions: Array<{ appId: string; action: string }>;
  inbox: InboxPost[];
  bridge: Array<{ method: string; path: string; body?: unknown }>;
  createdBoxes: number;
}

function makeDeps(
  options: {
    runtimeMode?: RuntimeMode;
    approval?: "approved" | "denied" | "timeout" | "no_client";
    agentAccess?: "off" | "read" | "manage";
    apiKey?: string;
  } = {},
): { deps: UnoWorkToolDeps; recorded: Recorded; home: string } {
  const home = mkdtempSync(path.join(os.tmpdir(), "uno-work-tools-"));
  tempDirs.push(home);
  const recorded: Recorded = { approvals: [], actions: [], inbox: [], bridge: [], createdBoxes: 0 };
  const apps = {
    apps: [app()],
    manifestDir: "~/.uno/apps",
    scannedAt: "",
    publishBlockedReason: null,
    warnings: [],
  };
  const settings = {
    uno: { apiKey: options.apiKey ?? "unollm_test", agentAccess: options.agentAccess ?? "read" },
    agentThreadsScope: "own-project",
    providerInstances: {},
  } as unknown as ServerSettings;
  const deps: UnoWorkToolDeps = {
    caller: {
      threadId: "thread-1",
      threadTitle: "Build notes",
      runtimeMode: options.runtimeMode ?? "full-access",
      cwd: path.join(home, "projects", "notes"),
    },
    home,
    manifestDir: path.join(home, ".uno", "apps"),
    pluginsDir: path.join(home, ".t3", "plugins"),
    bridge: (input) =>
      Effect.sync(() => {
        recorded.bridge.push(input);
        return { status: 200, body: { ok: true } };
      }),
    requestApproval: (input) =>
      Effect.sync(() => {
        recorded.approvals.push(input);
        return options.approval ?? "approved";
      }),
    machineApps: {
      list: Effect.succeed(apps),
      action: (input) =>
        Effect.sync(() => {
          recorded.actions.push(input);
          return apps;
        }),
    },
    resources: Effect.succeed({
      platform: "linux",
      sampledAt: "",
      cpuCount: 2,
      cpuPct: 10,
      load1: 0.1,
      memory: {
        totalMb: 4096,
        usedMb: 1024,
        cacheMb: 0,
        freeMb: 3072,
        availableMb: 3072,
        swapTotalMb: 0,
        swapUsedMb: 0,
      },
      volumes: [{ label: "disk", mount: "/", totalGb: 20, usedGb: 5, freeGb: 15 }],
      netRxBps: null,
      netTxBps: null,
      history: [],
      historyStepS: 5,
      groups: [],
      processCount: 10,
      docker: "ok",
      notes: [],
    }),
    computerState: Effect.succeed({
      linked: true,
      own: false,
      box: null,
      candidates: [],
      error: null,
      fetchedAt: "",
    }),
    files: {
      list: () => Effect.succeed({ path: home, rootPath: home, parentPath: null, entries: [] }),
      stat: (input) =>
        Effect.succeed({
          name: "x",
          path: input.path,
          kind: "file",
          size: 1,
          modifiedAt: "",
          hidden: false,
          isSymlink: false,
        }),
      createShare: (input) =>
        Effect.succeed({
          id: "s1",
          token: "t",
          path: input.path,
          name: "x",
          kind: "file",
          createdAt: "",
          expiresAt: null,
          revokedAt: null,
          hasPassword: false,
          access: "view",
          accessCount: 0,
          lastAccessedAt: null,
          urlPath: "/s/t",
        } as never),
      publishSite: () =>
        Effect.succeed({ slug: "site", url: "https://site.example", filesCount: 1, sizeBytes: 10 }),
      cloudState: Effect.succeed({} as never),
      cloudList: () => Effect.succeed({} as never),
    },
    inboxPost: (post) =>
      Effect.sync(() => {
        recorded.inbox.push(post);
        return { id: "inb_1" };
      }),
    messengerNotify: () => Effect.succeed({ delivered: 1 }),
    openInApp: () => Effect.succeed({ ok: true }),
    account: {
      cloudState: Effect.succeed({
        connected: true,
        account: null,
        boxes: [],
        fetchedAt: "",
        error: null,
      }),
      resizeOptions: Effect.succeed({
        availability: "ok",
        message: null,
        current: null,
        max: null,
        planMax: null,
        planName: "Plus",
        ramStepMb: 512,
        upgradeUrl: "https://console.uno4.dev/billing",
        canResize: true,
      } as never),
      createBox: () =>
        Effect.sync(() => {
          recorded.createdBoxes += 1;
          return { jobId: "job-1" };
        }),
      createBoxStatus: () => Effect.succeed({} as never),
    },
    settings: Effect.succeed(settings),
    readLogTail: () => Effect.succeed("hello from the app"),
  };
  return { deps, recorded, home };
}

const tool = (name: string): UnoWorkTool => {
  const found = UNO_WORK_TOOLS.find((entry) => entry.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

const run = (name: string, deps: UnoWorkToolDeps, args: unknown = {}) =>
  Effect.runPromise(Effect.result(runUnoWorkTool(tool(name), deps, args)));

function collectSchemaProblems(schema: JsonSchema, at: string, problems: string[]) {
  if (schema.type === "object") {
    if (schema.additionalProperties !== false)
      problems.push(`${at}: additionalProperties must be false`);
    for (const key of schema.required ?? []) {
      if (!(key in schema.properties)) problems.push(`${at}: required "${key}" is not a property`);
    }
    for (const [key, property] of Object.entries(schema.properties)) {
      collectSchemaProblems(property, `${at}.${key}`, problems);
    }
  }
  if (schema.type === "string" && schema.pattern) {
    try {
      expect(new RegExp(schema.pattern)).toBeInstanceOf(RegExp);
    } catch {
      problems.push(`${at}: bad pattern`);
    }
  }
  if (schema.type === "array") collectSchemaProblems(schema.items, `${at}[]`, problems);
}

describe("uno-work tool catalogue", () => {
  it("has unique, self-describing tools with strict schemas", () => {
    const names = UNO_WORK_TOOLS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    const problems: string[] = [];
    for (const entry of UNO_WORK_TOOLS) {
      expect(entry.name).toMatch(/^[a-z][a-z0-9_]{2,40}$/);
      expect(entry.description.length, entry.name).toBeGreaterThan(40);
      collectSchemaProblems(entry.inputSchema, entry.name, problems);
    }
    expect(problems).toEqual([]);
  });

  it("covers every area the founder asked for", () => {
    const names = new Set(UNO_WORK_TOOLS.map((entry) => entry.name));
    for (const required of [
      "computer_status",
      "apps_list",
      "app_start",
      "app_stop",
      "app_show_on_internet",
      "app_logs",
      "app_register",
      "app_add_widget",
      "files_list",
      "file_share_link",
      "file_open",
      "cloud_list",
      "drive_find",
      "drive_save",
      "drive_share_link",
      "chats_list",
      "chat_create",
      "chat_message",
      "chat_status",
      "notify",
      "open_in_panel",
      "site_publish",
      "account_overview",
      "computer_create",
      "settings_read",
    ]) {
      expect(names.has(required), required).toBe(true);
    }
  });

  it("marks exposing, deleting and billable tools sensitive, reads safe", () => {
    for (const name of [
      "app_show_on_internet",
      "app_remove",
      "file_share_link",
      "drive_share_link",
      "site_publish",
      "computer_create",
    ]) {
      expect(toolLevel(tool(name), {}), name).toBe("sensitive");
    }
    for (const name of [
      "computer_status",
      "apps_list",
      "app_logs",
      "files_list",
      "chats_list",
      "chat_status",
      "account_overview",
      "settings_read",
      "uno_guide",
      "notify",
      "open_in_panel",
    ]) {
      expect(toolLevel(tool(name), {}), name).toBe("safe");
    }
    for (const name of [
      "app_start",
      "app_stop",
      "app_register",
      "app_add_widget",
      "chat_create",
      "chat_message",
    ]) {
      expect(toolLevel(tool(name), {}), name).toBe("change");
    }
    expect(toolLevel(tool("browser_command"), { command: "screenshot" })).toBe("safe");
    expect(toolLevel(tool("browser_command"), { command: "evaluate" })).toBe("change");
  });

  it("publishes MCP annotations that match the levels", async () => {
    const { deps } = makeDeps();
    const outcome = await Effect.runPromise(
      handleMcpMessage(UNO_WORK_MCP_SERVER, deps, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    const tools = (
      outcome as {
        body: { result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> } };
      }
    ).body.result.tools;
    expect(tools.find((entry) => entry.name === "site_publish")?.annotations.destructiveHint).toBe(
      true,
    );
    expect(tools.find((entry) => entry.name === "apps_list")?.annotations.readOnlyHint).toBe(true);
    const init = await Effect.runPromise(
      handleMcpMessage(UNO_WORK_MCP_SERVER, deps, {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {},
      }),
    );
    expect(JSON.stringify(init)).toContain('"name":"uno-work"');
    expect(JSON.stringify(init)).toContain("instructions");
  });
});

describe("argument validation", () => {
  it("rejects unknown fields, wrong types and missing required fields", () => {
    const schema = tool("app_register").inputSchema;
    expect(validateArgs(schema, { id: "notes", name: "Notes" })).toBeNull();
    expect(validateArgs(schema, { id: "notes" })).toContain("name is required");
    expect(validateArgs(schema, { id: "Notes!", name: "x" })).toContain("must match");
    expect(validateArgs(schema, { id: "notes", name: "x", port: 70000 })).toContain(
      "at most 65535",
    );
    expect(validateArgs(schema, { id: "notes", name: "x", evil: 1 })).toContain(
      "not a known field",
    );
    expect(validateArgs(schema, { id: "notes", name: "x", ai: { chat: "yes" } })).toContain(
      "true or false",
    );
  });

  it("returns a readable tool error instead of running", async () => {
    const { deps, recorded } = makeDeps();
    const result = await run("app_start", deps, {});
    expect(result._tag).toBe("Failure");
    expect(recorded.actions).toEqual([]);
  });
});

describe("approval gate", () => {
  it("follows the chat's mode for changes and always asks for sensitive tools", () => {
    expect(decideUnoWorkGate("safe", "approval-required")).toBe("run");
    expect(decideUnoWorkGate("change", "approval-required")).toBe("ask");
    expect(decideUnoWorkGate("change", "auto-accept-edits")).toBe("run");
    expect(decideUnoWorkGate("change", "full-access")).toBe("run");
    expect(decideUnoWorkGate("sensitive", "full-access")).toBe("ask");
  });

  it("runs a change without asking in full access", async () => {
    const { deps, recorded } = makeDeps({ runtimeMode: "full-access" });
    const result = await run("app_stop", deps, { appId: "notes" });
    expect(result._tag).toBe("Success");
    expect(recorded.approvals).toEqual([]);
    expect(recorded.actions).toEqual([{ appId: "manifest:notes", action: "stop" }]);
  });

  it("asks for a change in Ask mode and runs it once allowed", async () => {
    const { deps, recorded } = makeDeps({ runtimeMode: "approval-required" });
    const result = await run("app_stop", deps, { appId: "notes" });
    expect(result._tag).toBe("Success");
    expect(recorded.approvals).toEqual([
      { tool: "app_stop", title: "Stop “Notes”", sensitive: false },
    ]);
  });

  it("always asks before showing an app on the internet, and does nothing when declined", async () => {
    const { deps, recorded } = makeDeps({ runtimeMode: "full-access", approval: "denied" });
    const result = await run("app_show_on_internet", deps, { appId: "notes" });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toContain("declined");
    expect(recorded.approvals[0]?.sensitive).toBe(true);
    expect(recorded.actions).toEqual([]);
  });

  it("refuses when nobody can be asked", async () => {
    const { deps, recorded } = makeDeps({ approval: "no_client" });
    const result = await run("site_publish", deps, { path: "~/site" });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toContain("isn't open");
    expect(recorded.bridge).toEqual([]);
  });

  it("never asks for reads", async () => {
    const { deps, recorded } = makeDeps({ runtimeMode: "approval-required" });
    await run("apps_list", deps, {});
    await run("computer_status", deps, {});
    await run("app_logs", deps, { appId: "notes" });
    expect(recorded.approvals).toEqual([]);
  });
});

describe("apps and widgets", () => {
  it("registers a validated manifest and keeps an earlier widget", async () => {
    const { deps, home } = makeDeps();
    const widget = await run("app_register", deps, {
      id: "notes",
      name: "Notes",
      icon: "📝",
      port: 3000,
      command: "node server.js",
      cwd: "~/projects/notes",
      notify: true,
    });
    expect(widget._tag).toBe("Success");
    const file = path.join(home, ".uno", "apps", "notes.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      name: "Notes",
      port: 3000,
      notify: true,
    });

    const added = await run("app_add_widget", deps, {
      appId: "notes",
      path: "/widget",
      size: "small",
    });
    expect(added._tag).toBe("Success");
    expect(JSON.parse(readFileSync(file, "utf8")).widget).toEqual({
      path: "/widget",
      size: "small",
    });

    await run("app_register", deps, {
      id: "notes",
      name: "Notes 2",
      port: 3001,
      command: "node server.js",
    });
    const again = JSON.parse(readFileSync(file, "utf8"));
    expect(again.name).toBe("Notes 2");
    expect(again.widget).toEqual({ path: "/widget", size: "small" });
  });

  it("forgives a path or a local address put in url", async () => {
    const { deps, home } = makeDeps();
    const asPath = await run("app_register", deps, {
      id: "focus",
      name: "Focus",
      port: 8400,
      url: "/widget",
      command: "python3 app.py",
    });
    expect(asPath._tag).toBe("Success");
    const manifest = JSON.parse(
      readFileSync(path.join(home, ".uno", "apps", "focus.json"), "utf8"),
    );
    expect(manifest.url).toBeUndefined();
    expect(manifest.path).toBe("/widget");
    const local = await run("app_register", deps, {
      id: "local",
      name: "Local",
      port: 8124,
      url: "http://localhost:8124/?x=1",
      command: "node s.js",
    });
    expect(local._tag).toBe("Success");
    const junk = await run("app_register", deps, {
      id: "junk",
      name: "Junk",
      port: 1,
      url: "widget",
    });
    expect(junk._tag === "Failure" && junk.failure.message).toContain("not an address");
  });

  it("refuses a manifest the daemon would skip", async () => {
    const { deps } = makeDeps();
    const result = await run("app_register", deps, { id: "empty", name: "Empty" });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure.message).toContain("needs a port, a url or a command");
    const outside = await run("app_register", deps, { id: "x", name: "X", port: 1, cwd: "/etc" });
    expect(outside._tag).toBe("Failure");
  });

  it("tells the model a repeated widget call is already done", async () => {
    const { deps } = makeDeps();
    await run("app_register", deps, { id: "w", name: "W", port: 3000, command: "node s.js" });
    const first = await run("app_add_widget", deps, { appId: "w", path: "/widget" });
    const second = await run("app_add_widget", deps, { appId: "w", path: "/widget" });
    expect(first._tag === "Success" && JSON.stringify(first.success)).toContain("Widget saved");
    expect(second._tag === "Success" && JSON.stringify(second.success)).toContain("already set");
  });

  it("can't add a widget to an app that isn't registered", async () => {
    const { deps } = makeDeps();
    const result = await run("app_add_widget", deps, { appId: "ghost", path: "/widget" });
    expect(result._tag).toBe("Failure");
  });

  it("keeps widget paths on the app itself", () => {
    const schema = tool("app_add_widget").inputSchema;
    expect(validateArgs(schema, { appId: "notes", path: "https://evil.example" })).toContain(
      "must match",
    );
  });

  it("reads an app's logs", async () => {
    const { deps } = makeDeps();
    const result = await run("app_logs", deps, { appId: "Notes" });
    expect(result._tag === "Success" && String(result.success)).toContain("hello from the app");
  });
});

describe("telling and showing", () => {
  it("notifies the Inbox as this chat, opening the chat by default", async () => {
    const { deps, recorded } = makeDeps();
    const result = await run("notify", deps, { title: "Notes app is ready" });
    expect(result._tag).toBe("Success");
    expect(recorded.inbox[0]).toMatchObject({
      kind: "agent.done",
      source: { kind: "agent", id: "thread-1", name: "Build notes" },
      title: "Notes app is ready",
      open: { kind: "thread", threadId: "thread-1" },
    });
  });

  it("opens where the notification points", async () => {
    const { deps, recorded, home } = makeDeps();
    await run("notify", deps, { title: "Report", level: "error", open: { file: "~/r.docx" } });
    expect(recorded.inbox[0]).toMatchObject({
      kind: "agent.error",
      open: { kind: "file", path: path.join(home, "r.docx") },
    });
  });

  it("opens files in the panel through the bridge with absolute paths", async () => {
    const { deps, recorded, home } = makeDeps();
    await run("open_in_panel", deps, { file: "report.html" });
    expect(recorded.bridge[0]).toMatchObject({
      method: "POST",
      path: "/api/browser/open",
      body: { file: path.join(home, "projects", "notes", "report.html") },
    });
    const both = await run("open_in_panel", deps, { url: "https://a.example", file: "x" });
    expect(both._tag).toBe("Failure");
    const truncated = await run("open_in_panel", deps, { url: "http://" });
    expect(truncated._tag === "Failure" && truncated.failure.message).toContain(
      "not a complete address",
    );
  });

  it("opens an app of this computer by its id", async () => {
    const { deps, recorded } = makeDeps();
    const result = await run("open_in_panel", deps, { appId: "notes", path: "/widget" });
    expect(result._tag).toBe("Success");
    expect(recorded.bridge[0]).toMatchObject({ body: { url: "http://localhost:3000/widget" } });
  });

  it("starts chats through the threads bridge, in any folder", async () => {
    const { deps, recorded, home } = makeDeps();
    await run("chat_create", deps, { text: "Write tests", cwd: "~/projects/site" });
    expect(recorded.bridge[0]).toMatchObject({
      path: "/api/threads",
      body: { text: "Write tests", cwd: path.join(home, "projects", "site") },
    });
    const bad = await run("chat_message", deps, { threadId: "../../etc", text: "hi" });
    expect(bad._tag).toBe("Failure");
  });
});

describe("account safety", () => {
  it("won't read the account when agent access is off", async () => {
    const { deps } = makeDeps({ agentAccess: "off" });
    const result = await run("account_overview", deps);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toContain("turned agent access");
  });

  it("reads plan and upgrade link with read access", async () => {
    const { deps } = makeDeps({ agentAccess: "read" });
    const result = await run("account_overview", deps);
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.success).toMatchObject({
        plan: { name: "Plus", upgradeUrl: "https://console.uno4.dev/billing" },
        canCreateComputers: false,
      });
      expect(JSON.stringify(result.success)).not.toContain("unollm_test");
    }
  });

  it("creates computers only with Manage, and only after the person allows it", async () => {
    const readOnly = makeDeps({ agentAccess: "read" });
    const refused = await run("computer_create", readOnly.deps, { name: "second" });
    expect(refused._tag).toBe("Failure");
    expect(readOnly.recorded.createdBoxes).toBe(0);

    const manage = makeDeps({ agentAccess: "manage" });
    const created = await run("computer_create", manage.deps, { name: "second" });
    expect(created._tag).toBe("Success");
    expect(manage.recorded.approvals[0]).toMatchObject({
      tool: "computer_create",
      sensitive: true,
    });
    expect(manage.recorded.createdBoxes).toBe(1);

    const declined = makeDeps({ agentAccess: "manage", approval: "denied" });
    await run("computer_create", declined.deps, { name: "second" });
    expect(declined.recorded.createdBoxes).toBe(0);
  });

  it("never returns keys from settings", async () => {
    const { deps } = makeDeps({ apiKey: "uno_usr_secret" });
    const result = await run("settings_read", deps);
    expect(JSON.stringify(result)).not.toContain("uno_usr_secret");
  });
});

describe("guides", () => {
  it("serves every topic", async () => {
    const { deps } = makeDeps();
    for (const topic of [
      "overview",
      "apps",
      "app-sdk",
      "widgets",
      "storage",
      "notify",
      "browser",
      "chats",
      "secrets",
      "account",
      "plugins",
    ]) {
      const result = await run("uno_guide", deps, { topic });
      expect(result._tag, topic).toBe("Success");
      if (result._tag === "Success")
        expect(String(result.success).length, topic).toBeGreaterThan(200);
    }
  });
});

// Keep the fixture writer honest about manifests written by hand too.
describe("existing manifests", () => {
  it("updates a hand-written manifest with a widget", async () => {
    const { deps, home } = makeDeps();
    const dir = path.join(home, ".uno", "apps");
    await Effect.runPromise(
      Effect.promise(() =>
        import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true })),
      ),
    );
    writeFileSync(path.join(dir, "todo.json"), JSON.stringify({ name: "Todo", port: 4000 }));
    const result = await run("app_add_widget", deps, { appId: "manifest:todo", path: "/w" });
    expect(result._tag).toBe("Success");
    expect(JSON.parse(readFileSync(path.join(dir, "todo.json"), "utf8"))).toMatchObject({
      name: "Todo",
      port: 4000,
      widget: { path: "/w" },
    });
  });
});
