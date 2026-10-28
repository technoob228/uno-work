import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RuntimeMode, ServerSettings, UnoMachineApp } from "@t3tools/contracts";
import { describeToolActivity } from "@t3tools/shared/toolResultPresentation";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { InboxPost } from "../inbox/inboxModel.ts";
import { handleMcpMessage } from "../mcp/mcpJsonRpc.ts";
import { validateArgs, type JsonSchema } from "./argsSchema.ts";
import {
  MAIL_NOT_ENABLED_MESSAGE,
  attachmentRefusal,
  attachmentTarget,
  fileNameFromContentDisposition,
  safeAttachmentName,
  type MailOwner,
} from "./mailTools.ts";
import {
  consoleRequest,
  consoleToken,
  type ConsoleReply,
  type ConsoleRequest,
} from "./consoleClient.ts";
import { decideUnoWorkGate } from "./policy.ts";
import {
  BOT_STARTING_NEXT,
  BOT_WAITING_FOR_TOKEN_NEXT,
  UNO_WORK_MCP_SERVER,
  UNO_WORK_TOOLS,
  observerRefusal,
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
  approvals: Array<{
    tool: string;
    title: string;
    detail?: string;
    sensitive: boolean;
    clientAction?: { kind: string; slug: string };
  }>;
  actions: Array<{ appId: string; action: string }>;
  inbox: InboxPost[];
  bridge: Array<{ method: string; path: string; body?: unknown }>;
  console: ConsoleRequest[];
  createdBoxes: number;
  appPanel: Array<{ url: string; name: string }>;
  told: string[];
  later: Array<(outcome: "approved" | "denied" | "timeout") => Effect.Effect<void>>;
}

function makeDeps(
  options: {
    runtimeMode?: RuntimeMode;
    approval?: "approved" | "denied" | "timeout" | "queued";
    agentAccess?: "off" | "read" | "manage";
    apiKey?: string;
    console?: (request: ConsoleRequest) => ConsoleReply;
    apps?: UnoMachineApp[];
    hostedMachine?: boolean;
    windowOpen?: boolean;
    orchestrator?: boolean;
  } = {},
): { deps: UnoWorkToolDeps; recorded: Recorded; home: string } {
  const home = mkdtempSync(path.join(os.tmpdir(), "uno-work-tools-"));
  tempDirs.push(home);
  const recorded: Recorded = {
    approvals: [],
    actions: [],
    inbox: [],
    bridge: [],
    console: [],
    createdBoxes: 0,
    appPanel: [],
    told: [],
    later: [],
  };
  const apps = {
    apps: options.apps ?? [app()],
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
    requestApproval: ({ later, ...input }) =>
      Effect.sync(() => {
        recorded.approvals.push(input);
        if (later) recorded.later.push(later);
        return options.approval ?? "approved";
      }),
    tellChat: (text) => Effect.sync(() => void recorded.told.push(text)),
    ...(options.orchestrator ? { orchestratorOnly: Effect.succeed({ name: "Uno" }) } : {}),
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
    openAppInPanel: (input) =>
      Effect.sync(() => {
        if (options.windowOpen === false) return { ok: false };
        recorded.appPanel.push(input);
        return { ok: true };
      }),
    hostedMachine: options.hostedMachine ?? false,
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
    console: {
      request: (request) =>
        Effect.sync(() => {
          recorded.console.push(request);
          return options.console?.(request) ?? { status: 200, body: {} };
        }),
    },
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
      "drive_get",
      "drive_share_link",
      "chats_list",
      "chat_create",
      "chat_message",
      "chat_status",
      "notify",
      "open_in_panel",
      "site_publish",
      "site_unpublish",
      "sites_list",
      "site_set_password",
      "site_forms_get",
      "site_forms_set",
      "db_create",
      "db_list",
      "db_connection",
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
      "db_create",
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
      "sites_list",
      "site_forms_get",
      "site_publish",
      "db_list",
      "uno_guide",
      "notify",
      "open_in_panel",
      "mail_address",
      "mail_list",
      "mail_read",
      "mail_attachment_save",
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
      "db_connection",
      "mail_send",
    ]) {
      expect(toolLevel(tool(name), {}), name).toBe("change");
    }
    // Misha 02.10: a plain site goes up without an Allow; the risky site
    // changes still ask.
    expect(toolLevel(tool("site_set_password"), { slug: "a" })).toBe("safe");
    expect(toolLevel(tool("site_set_password"), { slug: "a", remove: true })).toBe("sensitive");
    expect(toolLevel(tool("site_forms_set"), { slug: "a", email: "me@x.io" })).toBe("safe");
    expect(toolLevel(tool("site_forms_set"), { slug: "a", webhookUrl: "https://x.io/h" })).toBe(
      "sensitive",
    );
    expect(toolLevel(tool("site_forms_set"), { slug: "a", webhookUrl: "" })).toBe("safe");
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
    expect(tools.find((entry) => entry.name === "app_remove")?.annotations.destructiveHint).toBe(
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

  it("an Observer's chat gets no change tools, safe ones still run (preset 21.10)", async () => {
    const { deps, recorded } = makeDeps({ runtimeMode: "full-access" });
    const observed = { ...deps, presetRefusal: Effect.succeed(observerRefusal("Scout")) };
    const refused = await run("app_stop", observed, { appId: "notes" });
    expect(refused._tag).toBe("Failure");
    if (refused._tag === "Failure") expect(refused.failure.message).toContain("only reads");
    expect(recorded.actions).toEqual([]);
    expect(recorded.approvals).toEqual([]);
    const listed = await run("apps_list", observed);
    expect(listed._tag).toBe("Success");
    // Not an Observer: the usual gate.
    const allowed = await run(
      "app_stop",
      { ...deps, presetRefusal: Effect.succeed(null) },
      { appId: "notes" },
    );
    expect(allowed._tag).toBe("Success");
  });

  it('"Cautious": outward calls wait for the Allow whatever the mode; own work runs (23.10)', async () => {
    const { deps, recorded } = makeDeps({ runtimeMode: "full-access" });
    const asking = { ...deps, asksFirst: Effect.succeed({ name: "Scout" }) };
    // Taking an app off the internet isn't outward: it runs.
    const own = await run("app_stop", asking, { appId: "notes" });
    expect(own._tag).toBe("Success");
    expect(recorded.approvals).toEqual([]);
    // Deleting an app asks, and the card says why.
    const removed = await run("app_remove", asking, { appId: "notes" });
    expect(removed._tag).toBe("Success");
    expect(recorded.approvals).toHaveLength(1);
    expect(recorded.approvals[0]!.detail).toContain("Scout is Cautious");
    // "Autonomous": a site goes up without asking (decision 02.10)…
    expect(decideUnoWorkGate("safe", "full-access")).toBe("run");
    // …but for an "Cautious" assistant even a "safe" outward call asks.
    expect(decideUnoWorkGate("safe", "full-access", true)).toBe("ask");
    expect(decideUnoWorkGate("change", "auto-accept-edits", true)).toBe("ask");
  });

  it('"Cautious": a site that would go up on its own waits, and a declined one never does', async () => {
    const { deps, recorded, home } = makeDeps({ runtimeMode: "full-access", approval: "denied" });
    const asking = { ...deps, asksFirst: Effect.succeed({ name: "Scout" }) };
    const refused = await run("site_publish", asking, { path: "~/site", slug: "menu" });
    expect(refused._tag).toBe("Failure");
    if (refused._tag === "Failure") expect(refused.failure.message).toContain("declined");
    expect(recorded.approvals).toEqual([
      expect.objectContaining({ tool: "site_publish", title: "Publish site “menu”" }),
    ]);
    // Not published: the chat that made it was never noted.
    expect(existsSync(path.join(home, ".uno", "site-chats.json"))).toBe(false);
    // The person's own chat (no assistant): the usual gate.
    const mine = await run(
      "app_stop",
      { ...deps, asksFirst: Effect.succeed(null) },
      {
        appId: "notes",
      },
    );
    expect(mine._tag).toBe("Success");
  });

  it("project keys: names for Full/Helper chats, never values; an Observer gets none (22.10)", async () => {
    const { deps } = makeDeps();
    const loaded: string[] = [];
    const view = {
      synced: true,
      secrets: [{ name: "OPENAI_API_KEY", inVault: true, inFile: true }],
      vaultError: null,
    };
    const keys = (refusal: string | null) => ({
      ...deps,
      projectKeys: {
        refusal: Effect.succeed(refusal),
        list: () => Effect.succeed(view),
        load: (cwd: string) => Effect.sync(() => (loaded.push(cwd), view)),
      },
    });
    const listed = await run("project_keys", keys(null));
    expect(listed._tag).toBe("Success");
    if (listed._tag === "Success") {
      expect(JSON.stringify(listed.success)).toContain("OPENAI_API_KEY");
      expect(listed.success).toMatchObject({
        synced: true,
        keys: [{ name: "OPENAI_API_KEY", inEnvFile: true, travelsWithProject: true }],
      });
    }
    expect((await run("project_keys", keys(null), { load: true }))._tag).toBe("Success");
    expect(loaded).toEqual([deps.caller.cwd]);
    const refused = await run("project_keys", keys("Scout only reads"), { load: true });
    expect(refused._tag).toBe("Failure");
    if (refused._tag === "Failure") expect(refused.failure.message).toContain("only reads");
    expect(loaded).toHaveLength(1);
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

  it("publishes a plain site without asking, even in Ask mode", async () => {
    const { deps, recorded } = makeDeps({ runtimeMode: "approval-required", approval: "denied" });
    await run("site_publish", deps, { path: "~/site" });
    expect(recorded.approvals).toEqual([]);
  });

  it("a publish that left key files out says so and never hints at a workaround", async () => {
    const { deps } = makeDeps();
    const withKeys: UnoWorkToolDeps = {
      ...deps,
      files: {
        ...deps.files,
        publishSite: () =>
          Effect.succeed({
            slug: "keys-test",
            url: "https://keys-test.uno4.me/",
            filesCount: 1,
            sizeBytes: 10,
            skipped: ["service-account.json (key file)", ".env (hidden)"],
            skippedCount: 2,
          }),
      },
    };
    const result = await run("site_publish", withKeys, { path: "~/site" });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    const text = JSON.stringify(result.success);
    expect(text).toMatch(/stayed on this computer/);
    expect(text).toMatch(/Don't offer any way to publish a key or secret file/);
    expect(text).not.toMatch(/rename|look like/i);

    // A clean publish carries no note at all.
    const clean = await run("site_publish", deps, { path: "~/site" });
    expect(clean._tag === "Success" && JSON.stringify(clean.success)).not.toMatch(/note/);
  });

  it("drive_get copies Drive files into ~/Uploads/YYYY-MM by default and says where", async () => {
    const { deps, home } = makeDeps();
    const calls: Array<{ keys: ReadonlyArray<string>; destinationPath: string }> = [];
    const withDrive: UnoWorkToolDeps = {
      ...deps,
      files: {
        ...deps.files,
        driveState: Effect.succeed({ available: true, bucketId: 9 } as never),
        cloudCopyToComputer: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return {
              files: 1,
              bytes: 3,
              skipped: [],
              paths: [path.join(input.destinationPath, "report.pdf")],
            };
          }),
      },
    };
    const result = await run("drive_get", withDrive, { keys: ["Telegram/2026-10/report.pdf"] });
    expect(result._tag).toBe("Success");
    const destination = calls[0]!.destinationPath;
    expect(path.relative(home, destination)).toMatch(/^Uploads[/\\]\d{4}-\d{2}$/);
    expect(existsSync(destination)).toBe(true);
    if (result._tag !== "Success") return;
    expect(result.success).toMatchObject({
      ok: true,
      files: 1,
      paths: [expect.stringMatching(/^~\/Uploads\/\d{4}-\d{2}\/report\.pdf$/)],
    });

    // A named folder is passed as is (Files refuses one outside the home).
    await run("drive_get", withDrive, { keys: ["a.txt"], folder: "~/Documents" });
    expect(calls[1]!.destinationPath).toBe(path.join(home, "Documents"));
  });

  it("drive_get points the agent at computer_cleanup when the disk is too full", async () => {
    const { deps } = makeDeps();
    const withDrive: UnoWorkToolDeps = {
      ...deps,
      files: {
        ...deps.files,
        driveState: Effect.succeed({ available: true, bucketId: 9 } as never),
        cloudCopyToComputer: () =>
          Effect.fail({
            message:
              "Not enough space on this computer: needs 3.0 GB, 2.0 GB free. Free up space or pick fewer files.",
          }),
      },
    };
    const result = await run("drive_get", withDrive, { keys: ["big.zip"] });
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure.message).toBe(
      "Not enough space on this computer: needs 3.0 GB, 2.0 GB free. Free space with computer_cleanup or pick fewer files.",
    );
  });

  it("drive_save says which files replaced one and kept the old as a version", async () => {
    const { deps } = makeDeps();
    const withDrive: UnoWorkToolDeps = {
      ...deps,
      files: {
        ...deps.files,
        driveState: Effect.succeed({ available: true, bucketId: 9 } as never),
        cloudCopyToCloud: () =>
          Effect.succeed({
            files: 1,
            bytes: 3,
            skipped: [],
            overwritten: [{ key: "Reports/q3.pdf", versionKept: true }],
          }),
      },
    };
    const result = await run("drive_save", withDrive, { paths: ["~/q3.pdf"], folder: "Reports" });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.success).toMatchObject({
      ok: true,
      folder: "Reports/",
      overwritten: [{ key: "Reports/q3.pdf", versionKept: true }],
    });
  });

  it("request_secret: wait false asks the bridge not to hold the turn", async () => {
    const { deps, recorded } = makeDeps();
    await run("request_secret", deps, { name: "TELEGRAM_BOT_TOKEN", wait: false });
    await run("request_secret", deps, { name: "TELEGRAM_BOT_TOKEN" });
    expect(recorded.bridge.map((call) => call.body)).toMatchObject([
      { name: "TELEGRAM_BOT_TOKEN", timeoutMs: 0 },
      { name: "TELEGRAM_BOT_TOKEN" },
    ]);
    expect((recorded.bridge[1]!.body as Record<string, unknown>).timeoutMs).toBeUndefined();
  });

  it("notes which chat made the site, for Made in chat on the Sites screen", async () => {
    const { deps, home } = makeDeps();
    await run("site_publish", deps, { path: "~/site" });
    const chats = JSON.parse(readFileSync(path.join(home, ".uno", "site-chats.json"), "utf8"));
    expect(chats.site).toMatchObject({ threadId: "thread-1", title: "Build notes" });
  });

  it("doesn't hold the turn when nobody answers yet: a late Allow runs it and tells the chat", async () => {
    const { deps, recorded } = makeDeps({ approval: "queued" });
    const result = await run("app_show_on_internet", deps, { appId: "notes" });
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.success).toMatchObject({ ok: false, waiting: true });
      expect(JSON.stringify(result.success)).toContain("End your turn");
    }
    expect(recorded.actions).toEqual([]);
    expect(recorded.later).toHaveLength(1);
    await Effect.runPromise(recorded.later[0]!("approved"));
    expect(recorded.actions).toEqual([{ appId: "manifest:notes", action: "publish" }]);
    expect(recorded.told).toHaveLength(1);
    expect(recorded.told[0]).toContain("allowed");
  });

  it("a late Decline tells the chat and runs nothing", async () => {
    const { deps, recorded } = makeDeps({ approval: "queued" });
    await run("app_show_on_internet", deps, { appId: "notes" });
    await Effect.runPromise(recorded.later[0]!("denied"));
    expect(recorded.actions).toEqual([]);
    expect(recorded.told[0]).toContain("declined");
  });

  it("an assistant's own conversation hands heavy work to a chat", async () => {
    const { deps, recorded } = makeDeps({ orchestrator: true });
    const refused = await run("site_publish", deps, { path: "~/site" });
    expect(refused._tag).toBe("Failure");
    if (refused._tag === "Failure") expect(refused.failure.message).toContain("chat_create");
    const login = await run("browser_command", deps, { login: "x.com" });
    expect(login._tag).toBe("Failure");
    // A quick look and orchestration stay its own.
    expect((await run("apps_list", deps, {}))._tag).toBe("Success");
    await run("chat_create", deps, { text: "Publish the site" });
    expect(recorded.bridge.at(-1)?.path).toBe("/api/threads");
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

  it("shows an app with a public address as the app, not in the computer's browser", async () => {
    const { deps, recorded } = makeDeps({
      hostedMachine: true,
      apps: [app({ publication: { url: "http://203.0.113.5:31080/", forwards: [] } as never })],
    });
    const result = await run("open_in_panel", deps, { appId: "notes" });
    expect(result).toMatchObject({
      _tag: "Success",
      success: { opened: "http://203.0.113.5:31080/", where: "app panel" },
    });
    expect(recorded.appPanel).toEqual([{ url: "http://203.0.113.5:31080/", name: "Notes" }]);
    expect(recorded.bridge).toEqual([]);
  });

  it("tells the agent the person can't open a localhost app on a cloud computer", async () => {
    const { deps, recorded } = makeDeps({ hostedMachine: true });
    const result = await run("open_in_panel", deps, { appId: "notes" });
    if (result._tag !== "Success") throw new Error("open_in_panel failed");
    expect((result.success as { note?: string }).note).toContain("app_show_on_internet");
    expect(recorded.bridge[0]).toMatchObject({ body: { url: "http://localhost:3000/" } });
  });

  it("tells the agent when its localhost went to the person's panel as their site", async () => {
    const { deps } = makeDeps({ hostedMachine: true });
    const panelDeps = {
      ...deps,
      bridge: () => Effect.succeed({ status: 200, body: { ok: true, where: "panel" } }),
    };
    const result = await run("open_in_panel", panelDeps, { url: "http://localhost:5173/" });
    expect(result).toMatchObject({
      _tag: "Success",
      success: { opened: "http://localhost:5173/", where: "the person's panel" },
    });
    expect((result as { success: { note: string } }).success.note).toContain(
      "browser_command openUrl",
    );
  });

  it("never opens a Telegram bot in the panel: it gives its t.me link", async () => {
    const { deps, recorded } = makeDeps({
      hostedMachine: true,
      apps: [
        app({
          id: "manifest:cafe-bot",
          name: "Café Bot",
          port: null,
          http: false,
          localUrl: null,
          telegramBot: {
            username: "our_cafe_bot",
            link: "https://t.me/our_cafe_bot",
            tokenReady: false,
          },
        }),
      ],
    });
    const result = await run("open_in_panel", deps, { appId: "cafe-bot" });
    expect(result).toMatchObject({
      _tag: "Success",
      success: { telegram: "https://t.me/our_cafe_bot" },
    });
    if (result._tag === "Success") {
      expect((result.success as { note: string }).note).toContain("waits for its token");
    }
    expect(recorded.bridge).toEqual([]);
    expect(recorded.appPanel).toEqual([]);
  });

  it("registers a Telegram bot without a port", async () => {
    const { deps, home } = makeDeps({ runtimeMode: "full-access" });
    const result = await run("app_register", deps, {
      id: "cafe-bot",
      name: "Café Bot",
      type: "telegram-bot",
      telegram: "our_cafe_bot",
      tokenEnv: "TELEGRAM_BOT_TOKEN",
      command: "python3 bot.py",
      cwd: "~/projects/cafe-bot",
      runs: "always",
    });
    expect(result._tag).toBe("Success");
    const written = JSON.parse(
      readFileSync(path.join(home, ".uno", "apps", "cafe-bot.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(written).toMatchObject({
      type: "telegram-bot",
      telegram: "our_cafe_bot",
      tokenEnv: "TELEGRAM_BOT_TOKEN",
      runs: "always",
    });
  });

  it("tells the agent a bot without its token is waiting, in Home's words", async () => {
    const { deps, home } = makeDeps({ runtimeMode: "full-access" });
    const bot = {
      id: "cafe-bot",
      name: "Café Bot",
      type: "telegram-bot",
      tokenEnv: "TELEGRAM_BOT_TOKEN",
      command: "python3 bot.py",
      cwd: "~/projects/cafe-bot",
    };
    const waiting = await run("app_register", deps, bot);
    expect(waiting).toMatchObject({
      _tag: "Success",
      success: { next: BOT_WAITING_FOR_TOKEN_NEXT },
    });
    expect(BOT_WAITING_FOR_TOKEN_NEXT).toContain('"Waiting for token"');

    mkdirSync(path.join(home, "projects", "cafe-bot"), { recursive: true });
    writeFileSync(path.join(home, "projects", "cafe-bot", ".env"), "TELEGRAM_BOT_TOKEN=123:abc\n");
    const ready = await run("app_register", deps, bot);
    expect(ready).toMatchObject({ _tag: "Success", success: { next: BOT_STARTING_NEXT } });
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

describe("a Telegram bot is never registered as a plain app", () => {
  const botFolder = (home: string, files: Record<string, string>) => {
    const dir = path.join(home, "projects", "cafe-bot");
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    return dir;
  };
  const manifest = (home: string, id: string) =>
    JSON.parse(readFileSync(path.join(home, ".uno", "apps", `${id}.json`), "utf8"));

  it("sees the bot in the folder's code and finds its token variable", async () => {
    const { deps, home } = makeDeps();
    botFolder(home, {
      "bot.py":
        'import os\nfrom aiogram import Bot\nbot = Bot(token=os.environ["CAFE_BOT_TOKEN"])\n',
    });
    const result = await run("app_register", deps, {
      id: "cafe-bot",
      name: "Cafe helper",
      command: "python3 bot.py",
      cwd: "~/projects/cafe-bot",
    });
    expect(result._tag).toBe("Success");
    expect(manifest(home, "cafe-bot")).toMatchObject({
      type: "telegram-bot",
      tokenEnv: "CAFE_BOT_TOKEN",
    });
    if (result._tag === "Success") {
      expect(JSON.stringify(result.success)).toContain("Waiting for token");
    }
  });

  it("only hints when it merely looks like a bot — a notifier script still registers", async () => {
    const { deps, home } = makeDeps();
    botFolder(home, { "notify.js": 'fetch("https://api.telegram.org/bot123/sendMessage")\n' });
    const result = await run("app_register", deps, {
      id: "orders",
      name: "Orders to Telegram",
      command: "node notify.js",
      cwd: "~/projects/cafe-bot",
    });
    expect(result._tag).toBe("Success");
    expect(manifest(home, "orders").type).toBeUndefined();
    if (result._tag === "Success") {
      expect(JSON.stringify(result.success)).toContain('type \\"telegram-bot\\"');
    }
  });

  it("fills the type when only the bot's fields were given", async () => {
    const { deps, home } = makeDeps();
    botFolder(home, {});
    const result = await run("app_register", deps, {
      id: "orders",
      name: "Orders",
      command: "node bot.js",
      cwd: "~/projects/cafe-bot",
      telegram: "our_cafe_bot",
      tokenEnv: "TELEGRAM_BOT_TOKEN",
    });
    expect(result._tag).toBe("Success");
    expect(manifest(home, "orders")).toMatchObject({
      type: "telegram-bot",
      telegram: "our_cafe_bot",
      tokenEnv: "TELEGRAM_BOT_TOKEN",
    });
  });

  it("leaves a worker without a port alone when nothing says Telegram", async () => {
    const { deps, home } = makeDeps();
    botFolder(home, { "worker.py": 'import os\nKEY = os.environ["API_TOKEN"]\n' });
    const result = await run("app_register", deps, {
      id: "worker",
      name: "Nightly export",
      command: "python3 worker.py",
      cwd: "~/projects/cafe-bot",
    });
    expect(result._tag).toBe("Success");
    expect(manifest(home, "worker").type).toBeUndefined();
  });

  it("leaves a web app alone even when its code talks to Telegram", async () => {
    const { deps, home } = makeDeps();
    botFolder(home, { "app.js": 'fetch("https://api.telegram.org/bot" + process.env.TG_TOKEN)\n' });
    const result = await run("app_register", deps, {
      id: "shop",
      name: "Shop",
      port: 4000,
      command: "node app.js",
      cwd: "~/projects/cafe-bot",
    });
    expect(result._tag).toBe("Success");
    expect(manifest(home, "shop").type).toBeUndefined();
  });
});

describe("site_unpublish", () => {
  const sitesReply = (slugs: string[]): ConsoleReply => ({
    status: 200,
    body: { deploys: slugs.map((slug) => ({ slug, url: `https://${slug}.uno4.me/` })) },
  });

  it("always asks, and tells the person's Uno Work to take the site down on Allow", async () => {
    let live = ["team-site"];
    const { deps, recorded } = makeDeps({
      runtimeMode: "full-access",
      console: (request) => {
        if (request.method === "GET") return sitesReply(live);
        return { status: 403, body: { error: "FORBIDDEN" } };
      },
    });
    // The person's Allow: their own session deletes the site before the tool runs.
    const requestApproval = deps.requestApproval;
    const withAllow: UnoWorkToolDeps = {
      ...deps,
      clientActionWaitMs: 3_000,
      requestApproval: (input) =>
        requestApproval(input).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              // Their app answers the approval first and deletes right after.
              if (input.clientAction?.kind === "site-unpublish") {
                setTimeout(() => {
                  live = [];
                }, 200);
              }
            }),
          ),
        ),
    };
    const result = await run("site_unpublish", withAllow, { slug: "team-site" });
    expect(result._tag).toBe("Success");
    expect(recorded.approvals[0]).toMatchObject({
      tool: "site_unpublish",
      sensitive: true,
      clientAction: {
        kind: "site-unpublish",
        slug: "team-site",
        // The address goes along: the app closes the panel tabs still showing the site.
        url: expect.stringMatching(/^https:\/\/team-site\.[a-z0-9.-]+\/?$/),
      },
    });
    // The computer's own token never had to delete anything.
    expect(recorded.console.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("does nothing when declined", async () => {
    const { deps, recorded } = makeDeps({
      approval: "denied",
      console: () => sitesReply(["team-site"]),
    });
    const result = await run("site_unpublish", deps, { slug: "team-site" });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toContain("declined");
    expect(recorded.console.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("doesn't ask about a site that isn't there", async () => {
    const { deps, recorded } = makeDeps({ console: () => sitesReply(["other"]) });
    const result = await run("site_unpublish", deps, { slug: "team-site" });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toContain("no site");
    expect(recorded.approvals).toEqual([]);
  });

  it("says so plainly when the site is still up after Allow", async () => {
    const { deps } = makeDeps({
      console: (request) =>
        request.method === "GET"
          ? sitesReply(["team-site"])
          : { status: 403, body: { error: "FORBIDDEN" } },
    });
    const result = await run(
      "site_unpublish",
      { ...deps, clientActionWaitMs: 0 },
      {
        slug: "team-site",
      },
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("still online");
      expect(result.failure.message).toContain("Apps & sites");
    }
  });
});

describe("sites: password and forms", () => {
  it("sets a password without asking (it only closes the site), and returns it to tell them", async () => {
    const { deps, recorded } = makeDeps({ runtimeMode: "approval-required" });
    const result = await run("site_set_password", deps, {
      slug: "team-site",
      password: "correct-horse-battery",
    });
    expect(result._tag).toBe("Success");
    expect(recorded.approvals).toEqual([]);
    expect(recorded.console).toEqual([
      {
        method: "PUT",
        path: "/api/v1/deploys/team-site/password",
        body: { password: "correct-horse-battery" },
      },
    ]);
    if (result._tag === "Success") {
      expect(result.success).toMatchObject({
        hasPassword: true,
        password: "correct-horse-battery",
      });
    }
  });

  it("generates a readable password and can remove it", async () => {
    const generated = makeDeps();
    const result = await run("site_set_password", generated.deps, { slug: "team-site" });
    const sent = generated.recorded.console[0]?.body as { password: string };
    expect(sent.password).toMatch(/^[a-z]+-[a-z]+-\d{4}-[a-z]+$/);
    expect(sent.password.length).toBeGreaterThanOrEqual(10);
    if (result._tag === "Success")
      expect(result.success).toMatchObject({ password: sent.password });

    const removed = makeDeps();
    await run("site_set_password", removed.deps, { slug: "team-site", remove: true });
    expect(removed.recorded.console[0]?.body).toEqual({ password: "" });
    expect(removed.recorded.approvals[0]?.title).toContain("anyone can open it");
  });

  it("does nothing when the person declines removing a password", async () => {
    const { deps, recorded } = makeDeps({ approval: "denied" });
    const result = await run("site_set_password", deps, { slug: "team-site", remove: true });
    expect(result._tag).toBe("Failure");
    expect(recorded.console).toEqual([]);
  });

  it("explains a missing right instead of sending the person to do it by hand", async () => {
    const { deps } = makeDeps({
      console: () => ({ status: 403, body: { error: "WORK_MACHINE_SCOPE_DISABLED" } }),
    });
    const result = await run("site_set_password", deps, { slug: "team-site" });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toContain("isn't allowed");
  });

  it("keeps the other channels when changing one, and returns the Telegram link", async () => {
    const { deps, recorded } = makeDeps({
      console: (request) => {
        if (request.method === "GET") {
          return {
            status: 200,
            body: {
              enabled: true,
              webhook: { url: "https://hooks.example.com/a" },
              telegram: { chat_id: 111, via: "uno_bot" },
            },
          };
        }
        if (request.path.endsWith("/telegram-link")) {
          return { status: 200, body: { url: "https://t.me/uno_forms_bot?start=forms_x" } };
        }
        return {
          status: 200,
          body: {
            email: { to: "me@example.com", confirmed: false },
            webhook: { url: "https://hooks.example.com/a" },
            telegram: { chat_id: 111, via: "uno_bot" },
          },
        };
      },
    });
    const result = await run("site_forms_set", deps, {
      slug: "team-site",
      email: "me@example.com",
      telegram: true,
    });
    expect(result._tag).toBe("Success");
    // Email (confirmed by a link) and the person's own Telegram don't ask.
    expect(recorded.approvals).toEqual([]);
    expect(recorded.console[1]).toEqual({
      method: "PUT",
      path: "/api/v1/deploys/team-site/forms",
      body: {
        email: { to: "me@example.com" },
        webhook: { url: "https://hooks.example.com/a" },
        telegram: { chat_id: 111 },
      },
    });
    expect(recorded.console[2]).toMatchObject({
      method: "POST",
      path: "/api/v1/deploys/team-site/forms/telegram-link",
    });
    if (result._tag === "Success") {
      expect(result.success).toMatchObject({
        telegramLink: "https://t.me/uno_forms_bot?start=forms_x",
        delivery: { email: { to: "me@example.com", confirmed: false } },
      });
      expect(JSON.stringify(result.success)).not.toContain("111");
    }
  });

  it("switches a channel off with an empty string and refuses a non-https webhook", async () => {
    const { deps, recorded } = makeDeps({
      console: (request) =>
        request.method === "GET"
          ? { status: 200, body: { email: { to: "me@example.com", confirmed: true } } }
          : { status: 200, body: {} },
    });
    await run("site_forms_set", deps, { slug: "team-site", email: "" });
    expect(recorded.console[1]?.body).toEqual({});

    const bad = await run("site_forms_set", makeDeps().deps, {
      slug: "team-site",
      webhookUrl: "http://plain.example.com",
    });
    expect(bad._tag).toBe("Failure");
  });

  it("reads delivery and answers without asking", async () => {
    const { deps, recorded } = makeDeps({
      runtimeMode: "approval-required",
      console: (request) =>
        request.path.includes("submissions")
          ? { status: 200, body: { submissions: [{ id: 1 }], total: 1 } }
          : { status: 200, body: { email: { to: "me@example.com", confirmed: true } } },
    });
    const result = await run("site_forms_get", deps, { slug: "team-site", submissions: 5 });
    expect(result._tag).toBe("Success");
    expect(recorded.approvals).toEqual([]);
    expect(recorded.console[1]?.path).toBe("/api/v1/deploys/team-site/forms/submissions?limit=5");
  });

  it("lists sites with the address hosting answers with", async () => {
    const { deps } = makeDeps({
      console: () => ({
        status: 200,
        body: {
          deploys: [
            { slug: "team-site", has_password: true, url: "https://team-site.uno4.me" },
            { slug: "no-url" },
          ],
        },
      }),
    });
    const result = await run("sites_list", deps);
    if (result._tag !== "Success") throw new Error("sites_list failed");
    expect(result.success).toEqual({
      sites: [
        {
          slug: "team-site",
          url: "https://team-site.uno4.me/",
          hasPassword: true,
          customDomain: null,
          sizeBytes: null,
          updatedAt: null,
        },
        {
          slug: "no-url",
          url: "https://no-url.uno4.me/",
          hasPassword: false,
          customDomain: null,
          sizeBytes: null,
          updatedAt: null,
        },
      ],
    });
  });

  it("rejects slugs that could leave the site's path", async () => {
    const { deps, recorded } = makeDeps();
    const result = await run("site_set_password", deps, { slug: "../boxes/1" });
    expect(result._tag).toBe("Failure");
    expect(recorded.console).toEqual([]);
  });
});

describe("databases", () => {
  const DSN = "postgres://shop:s3cr3t-pa55@10.0.0.7:5432/shop";
  const dbConsole = (request: ConsoleRequest): ConsoleReply => {
    if (request.path.endsWith("/dsn")) {
      return {
        status: 200,
        body: { dsn: DSN, db_name: "shop", db_user: "shop", password: "s3cr3t-pa55" },
      };
    }
    if (request.method === "POST") {
      return { status: 201, body: { id: 7, name: "shop", engine: "postgres", status: "creating" } };
    }
    return {
      status: 200,
      body: { databases: [{ id: 7, name: "shop", dsn: "postgres://shop:${PGPASSWORD}@x" }] },
    };
  };

  it("creates a database only after the person allows it", async () => {
    const { deps, recorded } = makeDeps({ console: dbConsole });
    const result = await run("db_create", deps, { name: "shop" });
    expect(result._tag).toBe("Success");
    expect(recorded.approvals[0]).toMatchObject({
      tool: "db_create",
      sensitive: true,
      title: "Create a database “shop”",
    });
    expect(recorded.console[0]).toEqual({
      method: "POST",
      path: "/api/v1/databases",
      body: { name: "shop", ram_mb: 1024, disk_gb: 10 },
    });

    const declined = makeDeps({ console: dbConsole, approval: "denied" });
    await run("db_create", declined.deps, { name: "shop" });
    expect(declined.recorded.console).toEqual([]);
  });

  it("respects agent access off", async () => {
    const { deps, recorded } = makeDeps({ console: dbConsole, agentAccess: "off" });
    expect((await run("db_list", deps))._tag).toBe("Failure");
    expect((await run("db_create", deps, { name: "shop" }))._tag).toBe("Failure");
    expect(recorded.console).toEqual([]);
  });

  it("lists databases without connection strings", async () => {
    const { deps } = makeDeps({ console: dbConsole });
    const result = await run("db_list", deps);
    expect(result._tag).toBe("Success");
    expect(JSON.stringify(result)).not.toContain("postgres://");
  });

  it("writes the connection string to .env (0600) and never returns it", async () => {
    const { deps, home } = makeDeps({ console: dbConsole });
    const project = path.join(home, "projects", "notes");
    const result = await run("db_connection", deps, { databaseId: 7 });
    expect(result._tag).toBe("Success");
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
    const envFile = path.join(project, ".env");
    expect(readFileSync(envFile, "utf8")).toBe(`DATABASE_URL=${DSN}\n`);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);

    // A second variable keeps the first.
    await run("db_connection", deps, { databaseId: 7, envName: "SHOP_DB" });
    expect(readFileSync(envFile, "utf8")).toBe(`DATABASE_URL=${DSN}\nSHOP_DB=${DSN}\n`);
  });

  it("won't write outside the chat's folder", async () => {
    const { deps, recorded } = makeDeps({ console: dbConsole });
    const result = await run("db_connection", deps, { databaseId: 7, cwd: "~/other-project" });
    expect(result._tag).toBe("Failure");
    expect(recorded.console).toEqual([]);
  });
});

describe("console credential", () => {
  it("uses the machine token, then an account key, never the AI key", () => {
    const settings = (uno: Record<string, unknown>) => ({ uno }) as unknown as ServerSettings;
    expect(consoleToken(settings({ apiKey: "unollm_x", boxToken: "uno_agt_m" }))).toBe("uno_agt_m");
    expect(consoleToken(settings({ apiKey: "acct-key" }))).toBe("acct-key");
    expect(consoleToken(settings({ apiKey: "unollm_x" }))).toBe("");
  });

  it("reads a file answer as bytes, and an error of a file request as JSON", async () => {
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).endsWith("/0")
        ? new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-disposition": 'attachment; filename="a.pdf"',
            },
          })
        : new Response(JSON.stringify({ error: "not_found" }), { status: 404 })) as typeof fetch;
    const file = await consoleRequest({
      method: "GET",
      path: "/api/v1/work/mail/messages/m1/attachments/0",
      binary: true,
      baseUrl: "https://console.test",
      token: "uno_agt_m",
      fetchImpl,
    });
    expect(file).toMatchObject({
      status: 200,
      body: null,
      contentType: "application/pdf",
      contentDisposition: 'attachment; filename="a.pdf"',
    });
    expect([...(file.bytes ?? [])]).toEqual([1, 2, 3]);
    const missing = await consoleRequest({
      method: "GET",
      path: "/api/v1/work/mail/messages/m1/attachments/9",
      binary: true,
      baseUrl: "https://console.test",
      token: "uno_agt_m",
      fetchImpl,
    });
    expect(missing).toEqual({ status: 404, body: { error: "not_found" } });
  });
});

describe("image_generate", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);

  it("saves the picture in the chat's folder, shows it and returns the path", async () => {
    const { deps, recorded, home } = makeDeps();
    const prompts: string[] = [];
    const withImages: UnoWorkToolDeps = {
      ...deps,
      images: {
        generate: ({ prompt }) =>
          Effect.sync(() => {
            prompts.push(prompt);
            return { bytes: PNG, model: "img-model", costUsd: 0.05 };
          }),
      },
    };
    const result = await run("image_generate", withImages, { prompt: "Red fox logo" });
    expect(result._tag).toBe("Success");
    const value = (result as { success: { path: string; displayPath: string; costUsd: number } })
      .success;
    expect(value.path.startsWith(path.join(home, "projects", "notes", "images"))).toBe(true);
    expect(value.path.endsWith(".png")).toBe(true);
    expect(value.costUsd).toBe(0.05);
    expect(readFileSync(value.path)).toEqual(Buffer.from(PNG));
    expect(prompts).toEqual(["Red fox logo"]);
    expect(recorded.bridge.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/browser/open",
      body: { file: value.path },
    });
  });

  it("asks in Ask mode (it spends money) and explains a missing gateway", async () => {
    expect(toolLevel(tool("image_generate"), { prompt: "x" })).toBe("change");
    const { deps } = makeDeps();
    const result = await run("image_generate", deps, { prompt: "x" });
    expect(result._tag).toBe("Failure");
  });
});

describe("browser_command login", () => {
  it("goes to the daemon's login route with only the site", async () => {
    const { deps, recorded } = makeDeps();
    const result = await run("browser_command", deps, { login: "x.com" });
    expect(result._tag).toBe("Success");
    expect(recorded.bridge.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/browser/login",
      body: { site: "x.com" },
    });
  });

  it("refuses login mixed with a command, and a call with neither", async () => {
    const { deps, recorded } = makeDeps();
    expect((await run("browser_command", deps, { login: "x.com", command: "type" }))._tag).toBe(
      "Failure",
    );
    expect((await run("browser_command", deps, {}))._tag).toBe("Failure");
    expect(recorded.bridge).toEqual([]);
  });
});

// The harnesses name the tool differently; the feed never shows these ids.
const harnessToolIds = (name: string) => [
  `uno-work_${name}`,
  `mcp__uno-work__${name}`,
  `mcp__uno_work__${name}`,
  `mcp_uno_work_${name}`,
];

describe("the chat feed tells every uno-work tool in plain words", () => {
  it("has a line for each tool while it runs, when it is done and when it failed", () => {
    for (const tool of UNO_WORK_TOOLS) {
      for (const id of harnessToolIds(tool.name)) {
        const running = describeToolActivity({
          summary: id,
          kind: "tool.updated",
          payload: { status: "inProgress" },
        });
        const done = describeToolActivity({
          summary: id,
          kind: "tool.completed",
          payload: { status: "completed", detail: "{}" },
        });
        const failed = describeToolActivity({
          summary: id,
          kind: "tool.completed",
          payload: { status: "failed", detail: "Something went wrong." },
        });
        for (const human of [running, done, failed]) {
          expect(human, `${id} has no line`).toBeDefined();
          expect(human!.label, id).not.toMatch(/_|[{}<>]|\bmcp\b/i);
          // Its own wording, not the tool id turned into words.
          expect(human!.label.toLowerCase(), id).not.toBe(tool.name.replace(/_/g, " "));
        }
        expect(running!.label, id).toMatch(/…$/);
        expect(failed!.failed, id).toBe(true);
      }
    }
  });
});

describe("assistant_connect: the built-in assistant, in a bot of its own", () => {
  const withAssistant = (
    deps: UnoWorkToolDeps,
    status: {
      telegramLinked: boolean;
      telegramBot?: "own" | "shared" | "none";
      gmail?: { available: boolean; connected: boolean };
      windowOpen?: boolean;
    },
  ) => {
    let opened = 0;
    let cards = 0;
    const next: UnoWorkToolDeps = {
      ...deps,
      assistant: {
        status: Effect.succeed({
          chat: { id: "thread-uno", title: "Uno" },
          telegramLinked: status.telegramLinked,
          telegramBot: status.telegramBot ?? "none",
          tools: status.gmail
            ? [{ provider: "gmail", name: "Gmail & Calendar", ...status.gmail }]
            : null,
        }),
        openTelegram: Effect.sync(() => {
          opened += 1;
          return { ok: status.windowOpen ?? true };
        }),
        requestBotToken: Effect.sync(() => {
          cards += 1;
          return { opened: true };
        }),
      },
    };
    return { deps: next, opened: () => opened, cards: () => cards };
  };

  const adviceOf = (result: unknown) =>
    ((result as { success: Record<string, unknown> }).success.tellThePerson as string[]).join("\n");

  it("runs without asking, even in Ask mode (it only reads and shows a card)", () => {
    expect(toolLevel(tool("assistant_connect"), {})).toBe("safe");
  });

  it("no bot yet: the token card for its own bot in this chat, first", async () => {
    const { deps } = makeDeps({ runtimeMode: "approval-required" });
    const assistant = withAssistant(deps, { telegramLinked: false });
    const result = await run("assistant_connect", assistant.deps, { open: "telegram" });
    expect(result._tag).toBe("Success");
    const value = (result as { success: Record<string, unknown> }).success;
    expect(assistant.cards()).toBe(1);
    expect(assistant.opened()).toBe(0);
    expect(value.assistant).toBe("Uno");
    expect(value.telegram).toEqual({ linked: false, bot: "none", step: "token-card" });
    const advice = adviceOf(result);
    expect(advice).toMatch(/Don't build a bot or app/);
    expect(advice).toMatch(/Open @BotFather → \/newbot → name it → paste the token/);
    expect(advice).toMatch(/never offer Uno's shared bot/);
    expect(advice).toMatch(/Never ask for a mail password or an app password/);
  });

  it("Uno's shared bot with no chat linked: its own bot instead", async () => {
    const { deps } = makeDeps();
    const assistant = withAssistant(deps, { telegramLinked: false, telegramBot: "shared" });
    const result = await run("assistant_connect", assistant.deps, { open: "telegram" });
    expect(assistant.cards()).toBe(1);
    expect((result as { success: Record<string, unknown> }).success.telegram).toMatchObject({
      step: "token-card",
    });
  });

  it("its own bot is there but no chat yet: the Start step, no second card", async () => {
    const { deps } = makeDeps();
    const assistant = withAssistant(deps, { telegramLinked: false, telegramBot: "own" });
    const result = await run("assistant_connect", assistant.deps, { open: "telegram" });
    expect(assistant.cards()).toBe(0);
    expect(assistant.opened()).toBe(1);
    expect(adviceOf(result)).toMatch(/Open in Telegram, then Start/);
  });

  it("doesn't open anything once Telegram is linked", async () => {
    const { deps } = makeDeps();
    const assistant = withAssistant(deps, {
      telegramLinked: true,
      telegramBot: "own",
      gmail: { available: true, connected: true },
    });
    const result = await run("assistant_connect", assistant.deps, { open: "telegram" });
    const value = (result as { success: Record<string, unknown> }).success;
    expect(assistant.opened()).toBe(0);
    expect(assistant.cards()).toBe(0);
    expect(value.gmail).toBe("connected");
  });

  it("own bot, no window open: tells the way by hand", async () => {
    const { deps } = makeDeps();
    const assistant = withAssistant(deps, {
      telegramLinked: false,
      telegramBot: "own",
      windowOpen: false,
    });
    const result = await run("assistant_connect", assistant.deps, { open: "telegram" });
    expect(adviceOf(result)).toMatch(/open Uno in the sidebar, then Connect, Telegram/);
  });

  it("without arguments: points at open: telegram and the card, never at Uno's shared bot", async () => {
    const { deps } = makeDeps();
    const assistant = withAssistant(deps, { telegramLinked: false });
    const result = await run("assistant_connect", assistant.deps, {});
    expect(assistant.cards()).toBe(0);
    const advice = adviceOf(result);
    expect(advice).toMatch(/Create your assistant's bot/);
    expect(advice).not.toMatch(/no BotFather/);
  });

  it("without the wiring: an error that still points at the sidebar", async () => {
    const { deps } = makeDeps();
    const result = await run("assistant_connect", deps, {});
    expect(result._tag).toBe("Failure");
  });
});

describe("computer_cleanup", () => {
  const usage = (home: string) => ({
    home,
    path: home,
    scanning: false,
    scannedAt: null,
    totalBytes: 9 * 1024 ** 3,
    entries: [
      { name: "projects", path: path.join(home, "projects"), bytes: 6 * 1024 ** 3, isDir: true },
    ],
    unreadable: 0,
    volumes: [{ label: "Disk", mount: home, totalGb: 20, usedGb: 18, freeGb: 2 }],
    cleanables: [
      {
        id: "go-cache",
        label: "Go build cache",
        description: "",
        bytes: 3 * 1024 ** 3,
        canClean: true,
        blockedReason: null,
      },
      {
        id: "trash",
        label: "Trash",
        description: "",
        bytes: 1024 ** 3,
        canClean: true,
        blockedReason: null,
      },
      {
        id: "npm-cache",
        label: "npm download cache",
        description: "",
        bytes: 200 * 1024 ** 2,
        canClean: true,
        blockedReason: null,
      },
    ],
    docker: {
      access: "not-running" as const,
      imagesBytes: null,
      containersBytes: null,
      volumesBytes: null,
      buildCacheBytes: null,
      reclaimableBytes: null,
    },
    outsideHomeBytes: null,
    error: null,
  });

  const withDisk = (options: Parameters<typeof makeDeps>[0] = {}) => {
    const made = makeDeps(options);
    const cleaned: string[] = [];
    const deps: UnoWorkToolDeps = {
      ...made.deps,
      disk: {
        usage: Effect.succeed(usage(made.home)),
        clean: ({ id }) =>
          Effect.sync(() => {
            cleaned.push(id);
            return { freedBytes: id === "go-cache" ? 3 * 1024 ** 3 : 200 * 1024 ** 2, message: "" };
          }),
      },
    };
    return { ...made, deps, cleaned };
  };

  it("looks without asking and never offers the Trash", async () => {
    const { deps, recorded, cleaned } = withDisk({ runtimeMode: "approval-required" });
    const result = await run("computer_cleanup", deps, {});
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    const answer = result.success as {
      cleanable: Array<{ id: string; size: string }>;
      biggestInHome: unknown[];
    };
    expect(answer.cleanable.map((item) => item.id)).toEqual(["go-cache", "npm-cache"]);
    expect(answer.cleanable[0]?.size).toBe("3.0 GB");
    expect(answer.biggestInHome).toEqual([{ path: "~/projects", size: "6.0 GB" }]);
    expect(recorded.approvals).toEqual([]);
    expect(cleaned).toEqual([]);
  });

  it("apply empties the caches (asking in Ask mode) and keeps the Trash", async () => {
    const { deps, recorded, cleaned } = withDisk({ runtimeMode: "approval-required" });
    const result = await run("computer_cleanup", deps, { apply: true });
    expect(result._tag).toBe("Success");
    expect(cleaned).toEqual(["go-cache", "npm-cache"]);
    expect(recorded.approvals).toHaveLength(1);
    if (result._tag === "Success") expect(result.success).toMatchObject({ freed: "3.2 GB" });
  });

  it("apply with only cleans just those", async () => {
    const { deps, cleaned } = withDisk();
    await run("computer_cleanup", deps, { apply: true, only: ["npm-cache", "trash"] });
    expect(cleaned).toEqual(["npm-cache"]);
  });
});

describe("the agent's own mailbox (mail_*)", () => {
  const MAILBOX = {
    available: true,
    reason: null,
    mailbox: {
      address: "misha-otter@uno4.me",
      local: "misha-otter",
      created_at: "2026-10-20T10:00:00Z",
      limits: { daily_per_mailbox: 50, sent_today: 3 },
    },
  };

  it("validates arguments before calling the console", () => {
    const send = tool("mail_send").inputSchema;
    expect(
      validateArgs(send, { to: ["ann@example.com"], subject: "Hi", text: "Hello" }),
    ).toBeNull();
    expect(validateArgs(send, { to: ["ann@example.com"], text: "Hello" })).toContain(
      "subject is required",
    );
    expect(
      validateArgs(send, { to: ["Ann <ann@example.com>"], subject: "s", text: "t" }),
    ).toContain("must match");
    expect(validateArgs(send, { to: "ann@example.com", subject: "s", text: "t" })).toContain(
      "must be an array",
    );
    expect(
      validateArgs(send, {
        to: ["a@b.co"],
        subject: "s",
        text: "t",
        attachments: Array(11).fill("x"),
      }),
    ).toContain("at most 10 items");
    expect(
      validateArgs(send, { to: ["a@b.co"], subject: "s", text: "t", bcc: ["x@y.z"] }),
    ).toContain("not a known field");
    const list = tool("mail_list").inputSchema;
    expect(validateArgs(list, { folder: "spam" })).toContain("inbox, sent, all");
    expect(validateArgs(list, { limit: 500 })).toContain("at most 50");
    const read = tool("mail_read").inputSchema;
    expect(validateArgs(read, { id: "../../etc" })).toContain("must match");
    const save = tool("mail_attachment_save").inputSchema;
    expect(validateArgs(save, { id: "m1" })).toContain("index is required");
    expect(validateArgs(save, { id: "m1", index: -1 })).toContain("at least 0");
  });

  it("mail_address: the address and today's count; a clear sentence when the flag is off", async () => {
    const on = makeDeps({ console: () => ({ status: 200, body: MAILBOX }) });
    const result = await run("mail_address", on.deps);
    expect(result._tag).toBe("Success");
    expect(result._tag === "Success" && result.success).toMatchObject({
      address: "misha-otter@uno4.me",
      sentToday: 3,
      dailyLimit: 50,
    });
    expect(on.recorded.console).toEqual([{ method: "GET", path: "/api/v1/work/mail" }]);

    const off = makeDeps({
      console: () => ({ status: 200, body: { available: false, reason: "not_enabled" } }),
    });
    const refused = await run("mail_address", off.deps);
    expect(refused._tag === "Failure" && refused.failure.message).toBe(MAIL_NOT_ENABLED_MESSAGE);
  });

  it("mail_list: builds the query, gives ids as strings and flags unverified senders", async () => {
    const { deps, recorded } = makeDeps({
      console: () => ({
        status: 200,
        body: {
          messages: [
            {
              id: 41,
              direction: "in",
              from: "noreply@service.io",
              to: ["misha-otter@uno4.me"],
              subject: "Your code",
              snippet: "123456",
              received_at: "2026-10-20T10:00:00Z",
              read: false,
              has_attachments: false,
              suspicious: true,
            },
          ],
          next_before: 41,
        },
      }),
    });
    const result = await run("mail_list", deps, { unread: true, q: "service", limit: 5 });
    expect(recorded.console[0]?.path).toBe(
      "/api/v1/work/mail/messages?folder=inbox&unread=1&q=service&limit=5",
    );
    const body = result._tag === "Success" ? (result.success as Record<string, unknown>) : {};
    expect(body.nextBefore).toBe("41");
    expect((body.messages as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: "41",
      subject: "Your code",
      warning: "⚠ not verified sender",
    });
  });

  it("mail_read: text, attachments, an untrusted-content note; a 404 says which", async () => {
    const { deps, recorded } = makeDeps({
      console: (request) =>
        request.path.startsWith("/api/v1/work/mail/messages/m1")
          ? {
              status: 200,
              body: {
                id: "m1",
                direction: "in",
                from: "ann@example.com",
                subject: "Invoice",
                text: "x".repeat(50_000),
                html_available: true,
                attachments: [{ index: 0, name: "invoice.pdf", type: "application/pdf", size: 10 }],
              },
            }
          : request.path === "/api/v1/work/mail"
            ? { status: 200, body: MAILBOX }
            : { status: 404, body: { error: "not_found" } },
    });
    const result = await run("mail_read", deps, { id: "m1" });
    const body = result._tag === "Success" ? (result.success as Record<string, unknown>) : {};
    expect((body.text as string).length).toBe(40_000);
    expect(body.textTruncated).toBe(true);
    expect(body.html).toBeUndefined();
    expect(body.attachments).toEqual([
      { index: 0, name: "invoice.pdf", type: "application/pdf", size: 10 },
    ]);
    expect(body.note).toMatch(/not instructions/);
    expect(recorded.console[0]?.path).toBe("/api/v1/work/mail/messages/m1");

    const missing = await run("mail_read", deps, { id: "nope" });
    expect(missing._tag === "Failure" && missing.failure.message).toMatch(
      /There is no letter "nope"/,
    );

    const off = makeDeps({
      console: (request) =>
        request.path === "/api/v1/work/mail"
          ? { status: 200, body: { available: false, reason: "not_enabled" } }
          : { status: 404, body: null },
    });
    const disabled = await run("mail_read", off.deps, { id: "m1" });
    expect(disabled._tag === "Failure" && disabled.failure.message).toBe(MAIL_NOT_ENABLED_MESSAGE);
  });

  it("mail_attachment_save: writes under ~/Downloads/mail/<id>/ with a safe name, never over a file", async () => {
    const { deps, home, recorded } = makeDeps({
      console: () => ({
        status: 200,
        body: null,
        bytes: new TextEncoder().encode("PDF"),
        contentType: "application/pdf",
        contentDisposition: 'attachment; filename="../../.bashrc"',
      }),
    });
    const first = await run("mail_attachment_save", deps, { id: "m1", index: 0 });
    expect(recorded.console[0]).toEqual({
      method: "GET",
      path: "/api/v1/work/mail/messages/m1/attachments/0",
      binary: true,
    });
    expect(first._tag === "Success" && first.success).toMatchObject({
      file: "~/Downloads/mail/m1/bashrc",
      size: 3,
    });
    expect(readFileSync(path.join(home, "Downloads", "mail", "m1", "bashrc"), "utf8")).toBe("PDF");
    expect(existsSync(path.join(home, ".bashrc"))).toBe(false);
    const second = await run("mail_attachment_save", deps, { id: "m1", index: 0 });
    expect(second._tag === "Success" && second.success).toMatchObject({
      file: "~/Downloads/mail/m1/bashrc (2)",
    });
  });

  it("names and paths of attachments stay inside their folder", async () => {
    expect(safeAttachmentName("../../etc/passwd", 0)).toBe("passwd");
    expect(safeAttachmentName("..\\..\\win.ini", 0)).toBe("win.ini");
    expect(safeAttachmentName("..", 3)).toBe("attachment-3");
    expect(safeAttachmentName("", 1)).toBe("attachment-1");
    expect(safeAttachmentName(".env", 0)).toBe("env");
    expect(safeAttachmentName('a<b>:c"d|e?f*.txt\u0000', 0)).toBe("a_b__c_d_e_f_.txt");
    const long = safeAttachmentName(`${"x".repeat(300)}.pdf`, 0);
    expect(long.length).toBe(120);
    expect(long.endsWith(".pdf")).toBe(true);
    expect(
      fileNameFromContentDisposition("attachment; filename*=UTF-8''%D0%A1%D1%87%D1%91%D1%82.pdf"),
    ).toBe("Счёт.pdf");
    expect(fileNameFromContentDisposition('attachment; filename="report q3.pdf"')).toBe(
      "report q3.pdf",
    );
    expect(fileNameFromContentDisposition("attachment; filename=plain.txt")).toBe("plain.txt");
    expect(fileNameFromContentDisposition(undefined)).toBe("");
    const folder = mkdtempSync(path.join(os.tmpdir(), "uno-mail-"));
    tempDirs.push(folder);
    await expect(attachmentTarget(folder, "../escape")).rejects.toThrow(/outside/);
  });

  it("mail_send: key and hidden files never go out", () => {
    expect(attachmentRefusal("/home/uno/.ssh/id_ed25519")).toMatch(/hidden/);
    expect(attachmentRefusal("/home/uno/projects/app/.env")).toMatch(/hidden/);
    expect(attachmentRefusal("/home/uno/keys/service-account.json")).toMatch(/key or secret/);
    expect(attachmentRefusal("/home/uno/Documents/report.pdf")).toBeNull();
  });

  it("mail_send: asks in Ask mode, reads the files and sends base64", async () => {
    const { deps, home, recorded } = makeDeps({
      runtimeMode: "approval-required",
      console: () => ({ status: 200, body: { id: 7, message_id: "<abc@uno4.me>" } }),
    });
    mkdirSync(path.join(home, "Documents"), { recursive: true });
    writeFileSync(path.join(home, "Documents", "report.pdf"), "hello");
    const result = await run("mail_send", deps, {
      to: ["ann@example.com"],
      subject: "Report",
      text: "Attached.",
      reply_to_id: "m1",
      attachments: ["~/Documents/report.pdf"],
    });
    expect(result._tag).toBe("Success");
    expect(recorded.approvals).toHaveLength(1);
    expect(recorded.approvals[0]).toMatchObject({
      tool: "mail_send",
      title: "Send an email to ann@example.com",
      sensitive: false,
    });
    expect(recorded.console).toEqual([
      {
        method: "POST",
        path: "/api/v1/work/mail/send",
        body: {
          to: ["ann@example.com"],
          cc: [],
          subject: "Report",
          text: "Attached.",
          reply_to_id: "m1",
          attachments: [
            {
              name: "report.pdf",
              type: "application/pdf",
              content_base64: Buffer.from("hello").toString("base64"),
            },
          ],
        },
      },
    ]);
    expect(result._tag === "Success" && result.success).toMatchObject({ sent: true, id: "7" });
  });

  it("mail_send: runs without asking in full access; refuses before asking when a file can't go", async () => {
    const full = makeDeps({ console: () => ({ status: 200, body: { id: "x" } }) });
    await run("mail_send", full.deps, { to: ["a@b.co"], subject: "s", text: "t" });
    expect(full.recorded.approvals).toEqual([]);
    expect(full.recorded.console).toHaveLength(1);

    const ask = makeDeps({ runtimeMode: "approval-required" });
    mkdirSync(path.join(ask.home, "projects", "app"), { recursive: true });
    writeFileSync(path.join(ask.home, "projects", "app", ".env"), "KEY=1");
    const refused = await run("mail_send", ask.deps, {
      to: ["a@b.co"],
      subject: "s",
      text: "t",
      attachments: ["~/projects/app/.env"],
    });
    expect(refused._tag === "Failure" && refused.failure.message).toMatch(/can't go out by mail/);
    expect(ask.recorded.approvals).toEqual([]);
    expect(ask.recorded.console).toEqual([]);

    const big = makeDeps();
    writeFileSync(path.join(big.home, "big.bin"), Buffer.alloc(11 * 1024 * 1024));
    const tooBig = await run("mail_send", big.deps, {
      to: ["a@b.co"],
      subject: "s",
      text: "t",
      attachments: ["~/big.bin"],
    });
    expect(tooBig._tag === "Failure" && tooBig.failure.message).toMatch(/up to 10 MB/);

    const many = makeDeps();
    const crowd = await run("mail_send", many.deps, {
      to: Array.from({ length: 15 }, (_, n) => `p${n}@b.co`),
      cc: Array.from({ length: 6 }, (_, n) => `c${n}@b.co`),
      subject: "s",
      text: "t",
    });
    expect(crowd._tag === "Failure" && crowd.failure.message).toMatch(/at most 20 people/);
  });

  it("mail_send: limits and refusals come back as the console's sentence", async () => {
    const limited = makeDeps({
      console: () => ({
        status: 429,
        body: { error: "Daily limit of 50 emails reached, resets at 00:00 UTC" },
      }),
    });
    const result = await run("mail_send", limited.deps, {
      to: ["a@b.co"],
      subject: "s",
      text: "t",
    });
    expect(result._tag === "Failure" && result.failure.message).toBe(
      "Daily limit of 50 emails reached, resets at 00:00 UTC. Tell the person; don't retry before then and don't send it another way.",
    );
    const invalid = makeDeps({
      console: () => ({ status: 422, body: { error: "invalid", message: "Subject is empty." } }),
    });
    const bad = await run("mail_send", invalid.deps, { to: ["a@b.co"], subject: "", text: "t" });
    expect(bad._tag === "Failure" && bad.failure.message).toBe(
      "Couldn't send the letter: Subject is empty.",
    );
  });
  describe("an assistant's own address and rules", () => {
    const LIST = {
      messages: [
        {
          id: 1,
          direction: "in",
          from: "a@x.io",
          to: ["misha-otter+scout@uno4.me"],
          subject: "Code",
        },
        { id: 2, direction: "in", from: "b@x.io", to: ["misha-otter@uno4.me"], subject: "Uno's" },
        { id: 3, direction: "out", from: "misha-otter@uno4.me", to: ["c@x.io"], subject: "Sent" },
        { id: 4, direction: "out", from: "misha-otter@uno4.me", to: ["d@x.io"], subject: "Other" },
      ],
      next_before: null,
    };
    const withOwner = (
      owner: Partial<MailOwner> = {},
      reply: (request: ConsoleRequest) => ConsoleReply = (request) =>
        request.path === "/api/v1/work/mail"
          ? { status: 200, body: MAILBOX }
          : request.path.startsWith("/api/v1/work/mail/messages?")
            ? { status: 200, body: LIST }
            : request.path === "/api/v1/work/mail/messages/2"
              ? { status: 200, body: { id: 2, direction: "in", to: ["misha-otter@uno4.me"] } }
              : { status: 200, body: { id: 9, message_id: "<m9@uno4.me>" } },
    ) => {
      const made = makeDeps({ console: reply });
      const sent: Array<{ id: string | null; messageId: string | null }> = [];
      const full: MailOwner = {
        projectId: "assistant-scout",
        name: "Scout",
        isUno: false,
        policy: { enabled: true, recipients: "anyone", allow: [], dailyLimit: 50 },
        ownerEmail: "misha@example.com",
        ledger: Effect.succeed({
          day: "2026-10-22",
          sentToday: 2,
          sentIds: ["3"],
          messageIds: [],
        }),
        recordSent: (letter) => Effect.sync(() => void sent.push(letter)),
        now: () => new Date("2026-10-22T12:00:00Z"),
        ...owner,
      };
      return { ...made, deps: { ...made.deps, mailOwner: Effect.succeed(full) }, sent };
    };

    it("mail_address: its own plus address, its count and rules", async () => {
      const { deps } = withOwner();
      const result = await run("mail_address", deps);
      expect(result._tag === "Success" && result.success).toMatchObject({
        address: "misha-otter+scout@uno4.me",
        sentToday: 2,
        dailyLimit: 50,
        rules: "Writes to anyone · up to 50 letters a day",
      });
      const uno = withOwner({ projectId: "assistant-home", isUno: true, name: "Uno" });
      const own = await run("mail_address", uno.deps);
      expect(own._tag === "Success" && own.success).toMatchObject({
        address: "misha-otter@uno4.me",
      });
    });

    it("mail_list: another assistant sees letters to its address and the ones it sent", async () => {
      const { deps, recorded } = withOwner();
      const result = await run("mail_list", deps, { folder: "all", limit: 5 });
      const ids = (
        (result._tag === "Success" ? result.success : {}) as { messages: Array<{ id: string }> }
      ).messages.map((message) => message.id);
      expect(ids).toEqual(["1", "3"]);
      expect(recorded.console.find((r) => r.path.includes("messages?"))?.path).toContain(
        "limit=50",
      );
      const uno = withOwner({ projectId: "assistant-home", isUno: true });
      const all = await run("mail_list", uno.deps, { folder: "all" });
      expect(
        ((all._tag === "Success" ? all.success : {}) as { messages: unknown[] }).messages,
      ).toHaveLength(4);
    });

    it("mail_read: another assistant's or the computer's letter is refused", async () => {
      const { deps } = withOwner();
      const result = await run("mail_read", deps, { id: "2" });
      expect(result._tag === "Failure" && result.failure.message).toContain("isn't yours");
    });

    it("mail_send: off, its limit and who it may write to stop it before the console", async () => {
      const off = withOwner({
        policy: { enabled: false, recipients: "anyone", allow: [], dailyLimit: 50 },
      });
      const refusedOff = await run("mail_send", off.deps, {
        to: ["a@b.co"],
        subject: "s",
        text: "t",
      });
      expect(refusedOff._tag === "Failure" && refusedOff.failure.message).toContain(
        "Your own email is off",
      );
      expect(off.recorded.console).toEqual([]);

      const limit = withOwner({
        policy: { enabled: true, recipients: "anyone", allow: [], dailyLimit: 2 },
      });
      const refusedLimit = await run("mail_send", limit.deps, {
        to: ["a@b.co"],
        subject: "s",
        text: "t",
      });
      expect(refusedLimit._tag === "Failure" && refusedLimit.failure.message).toContain(
        "You sent your 2 letters for today",
      );

      const onlyYou = withOwner({
        policy: { enabled: true, recipients: "owner", allow: [], dailyLimit: 50 },
      });
      const refusedWho = await run("mail_send", onlyYou.deps, {
        to: ["stranger@x.io"],
        subject: "s",
        text: "t",
      });
      expect(refusedWho._tag === "Failure" && refusedWho.failure.message).toContain(
        "You may not write to stranger@x.io",
      );
      const toPerson = await run("mail_send", onlyYou.deps, {
        to: ["Misha@Example.com"],
        subject: "s",
        text: "t",
      });
      expect(toPerson._tag).toBe("Success");
    });

    it("mail_send: goes out with its name, and is counted as its letter", async () => {
      const { deps, recorded, sent } = withOwner();
      const result = await run("mail_send", deps, { to: ["a@b.co"], subject: "s", text: "t" });
      expect(result._tag).toBe("Success");
      const post = recorded.console.find((r) => r.method === "POST");
      expect((post?.body as { from_name?: string }).from_name).toBe("Scout");
      expect(sent).toEqual([{ id: "9", messageId: "<m9@uno4.me>" }]);
    });
  });
});

describe("github_pr_comment (Automations, 28.10)", () => {
  const linked = (deps: UnoWorkToolDeps, boxId: number | null = 2531): UnoWorkToolDeps => ({
    ...deps,
    settings: deps.settings.pipe(
      Effect.map(
        (settings) =>
          ({
            ...settings,
            uno: { ...settings.uno, boxToken: "uno_agt_x", boxId },
          }) as ServerSettings,
      ),
    ),
  });
  const args = {
    repo: "getuno/x",
    number: 12,
    body: "LGTM overall.\n\n- nit: rename foo\n- nit: tests",
  };

  it('"Does it itself": posts at once on this computer\'s box', async () => {
    const { deps, recorded } = makeDeps({
      runtimeMode: "full-access",
      console: () => ({
        status: 201,
        body: { id: 5, html_url: "https://github.com/getuno/x/pull/12#issuecomment-5" },
      }),
    });
    const result = await run("github_pr_comment", linked(deps), args);
    expect(result._tag).toBe("Success");
    expect(recorded.approvals).toEqual([]);
    expect(recorded.console).toEqual([
      {
        method: "POST",
        path: "/api/v1/boxes/2531/work/git/github/pr-comment",
        body: args,
      },
    ]);
    if (result._tag === "Success") {
      expect(result.success).toMatchObject({
        ok: true,
        commentUrl: "https://github.com/getuno/x/pull/12#issuecomment-5",
      });
    }
  });

  it('Ask mode and "Asks first" wait for the Allow with the PR and the start of the text', async () => {
    const ask = makeDeps({ runtimeMode: "approval-required" });
    await run("github_pr_comment", linked(ask.deps), args);
    expect(ask.recorded.approvals).toEqual([
      expect.objectContaining({
        tool: "github_pr_comment",
        title: "Comment on PR #12 in getuno/x",
        detail: "LGTM overall.\n- nit: rename foo\n- nit: tests",
      }),
    ]);
    const helper = makeDeps({ runtimeMode: "full-access", approval: "denied" });
    const refused = await run(
      "github_pr_comment",
      { ...linked(helper.deps), asksFirst: Effect.succeed({ name: "Ada" }) },
      args,
    );
    expect(refused._tag).toBe("Failure");
    expect(helper.recorded.approvals[0]!.detail).toContain("Ada asks first");
    expect(helper.recorded.console).toEqual([]);
  });

  it("an assistant's own conversation may post (not a worker tool)", async () => {
    const { deps, recorded } = makeDeps({ runtimeMode: "full-access", orchestrator: true });
    const result = await run("github_pr_comment", linked(deps), args);
    expect(result._tag).toBe("Success");
    expect(recorded.console).toHaveLength(1);
  });

  it("a missing permission: the link to fix it, no other way", async () => {
    const { deps } = makeDeps({
      runtimeMode: "full-access",
      console: () => ({
        status: 409,
        body: {
          error: "GITHUB_PR_PERMISSION_MISSING",
          code: "GITHUB_PR_PERMISSION_MISSING",
          manage_url: "https://github.com/settings/installations/42",
        },
      }),
    });
    const result = await run("github_pr_comment", linked(deps), args);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("one more permission");
      expect(result.failure.message).toContain("https://github.com/settings/installations/42");
    }
  });

  it("off a cloud computer, or GitHub read-only for the assistant: refused before asking", async () => {
    const laptop = makeDeps({ runtimeMode: "full-access" });
    const off = await run("github_pr_comment", linked(laptop.deps, null), args);
    expect(off._tag).toBe("Failure");
    expect(laptop.recorded.console).toEqual([]);

    const readOnly = makeDeps({ runtimeMode: "approval-required" });
    const refused = await run(
      "github_pr_comment",
      {
        ...linked(readOnly.deps),
        connectors: {
          call: () => Effect.die("unused"),
          access: () => Effect.succeed({ decision: "read-only" as const, assistant: "Ada" }),
        },
      },
      args,
    );
    expect(refused._tag).toBe("Failure");
    if (refused._tag === "Failure")
      expect(refused.failure.message).toContain("may only read GitHub");
    expect(readOnly.recorded.approvals).toEqual([]);
  });
});
