import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ManagerTokenId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { handleManagerMcpMessage, isAssistantsOnlyManagerTool } from "../manager/mcp.ts";
import type {
  ManagerCaller,
  ManagerToolServiceShape,
} from "../manager/Services/ManagerToolService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  AutomationsService,
  createdTell,
  defaultAutomationName,
  makeAutomationsService,
  type AutomationsServiceShape,
} from "./AutomationsService.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const caller = (label?: string): ManagerCaller => ({
  tokenId: ManagerTokenId.make("tok-1"),
  scopes: ["threads:read", "threads:write"],
  projectAllowlist: "all",
  budget: null,
  autoApprove: true,
  ...(label !== undefined ? { label } : {}),
});

const automation = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  box_id: 7,
  assistant: "assistant-ada",
  assistant_name: "Ada",
  name: "Review PRs",
  instruction: "Review the PR and leave a comment",
  enabled: true,
  trigger: { kind: "github.pull_request", repo: "getuno/x" },
  status: "ok",
  created_at: "2026-10-28T09:00:00Z",
  updated_at: "2026-10-28T09:00:00Z",
  ...overrides,
});

const PROJECTS: Record<string, string> = {
  "assistant-ada": "Ada",
  "assistant-home": "Uno home",
  "assistant-bob": "Bob",
  "proj-site": "site",
};

const THREADS: Record<string, { title: string; projectId: string }> = {
  "thread-7": { title: "Release notes", projectId: "proj-site" },
  "thread-8": { title: "Other chat", projectId: "proj-site" },
};

function setup(answer: (method: string, path: string, body: unknown) => Response) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "automations-service-"));
  tempDirs.push(dir);
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const p = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: p, body });
    return answer(init?.method ?? "GET", p, body);
  };
  const layer = Layer.effect(AutomationsService, makeAutomationsService({ fetchImpl })).pipe(
    Layer.provide(
      ServerSettingsService.layerTest({ uno: { boxToken: "uno_agt_machine", boxId: 7 } }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getProjectShellById: (projectId) =>
          Effect.succeed(
            PROJECTS[projectId] !== undefined
              ? Option.some({ id: projectId, title: PROJECTS[projectId] } as never)
              : Option.none(),
          ),
        getThreadShellById: (threadId) =>
          Effect.succeed(
            THREADS[threadId] !== undefined
              ? Option.some({ id: threadId, ...THREADS[threadId], archivedAt: null } as never)
              : Option.none(),
          ),
        getShellSnapshot: () =>
          Effect.succeed({
            projects: Object.entries(PROJECTS).map(([id, title]) => ({ id, title })),
            threads: Object.entries(THREADS).map(([id, t]) => ({ id, ...t, archivedAt: null })),
          } as never),
      }),
    ),
    Layer.provide(Layer.succeed(ServerConfig, { stateDir: dir } as ServerConfigShape)),
  );
  const run = <A, E>(use: (service: AutomationsServiceShape) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          return yield* use(yield* AutomationsService);
        }).pipe(Effect.provide(layer)),
      ),
    );
  return { calls, run };
}

describe("automation_* for an assistant", () => {
  it("creates for the caller's assistant, whatever the arguments say, with its name", async () => {
    const { calls, run } = setup((_method, _path, body) =>
      json(
        201,
        automation({
          ...(body as object),
          status: "needs_github_permission",
          manage_url: "https://github.com/settings/installations/1",
        }),
      ),
    );
    const result = await run((service) =>
      service.toolCreate(caller("assistant:assistant-home"), {
        assistant: "assistant-bob",
        instruction: "Review the PR and leave a comment. Be kind.",
        trigger: { kind: "github.pull_request", repo: "getuno/x" },
      }),
    );
    expect(result._tag).toBe("Success");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/v1/boxes/7/work/automations");
    expect(calls[0]!.body).toMatchObject({
      assistant: "assistant-home",
      // Uno's own name, not its folder's title.
      assistant_name: "Uno",
      name: "Review the PR and leave a comment.",
    });
    if (result._tag === "Success") {
      const tell = (result.success as { tell: string }).tell;
      expect(tell).toContain("GitHub needs one more permission");
      expect(tell).toContain("https://github.com/settings/installations/1");
    }
  });

  it("refuses a token that isn't an assistant's", async () => {
    const { calls, run } = setup(() => json(200, {}));
    const result = await run((service) =>
      service.toolCreate(caller("external"), {
        instruction: "x",
        trigger: { kind: "call.ended" },
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("NOT_AN_ASSISTANT");
    expect(calls).toEqual([]);
  });

  it("a repository outside the app: the refusal carries the link and says to give it", async () => {
    const { run } = setup(() =>
      json(409, {
        error: "GITHUB_REPO_NOT_ALLOWED",
        detail: "getuno/secret",
        manage_url: "https://github.com/settings/installations/1",
      }),
    );
    const result = await run((service) =>
      service.toolCreate(caller("assistant:assistant-ada"), {
        instruction: "Review",
        trigger: { kind: "github.pull_request", repo: "getuno/secret" },
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("https://github.com/settings/installations/1");
      expect(result.failure.message).toContain("give them the link");
    }
  });

  it("lists only its own; changes and deletes only its own", async () => {
    const { calls, run } = setup((method) =>
      method === "GET"
        ? json(200, {
            automations: [automation(), automation({ id: 8, assistant: "assistant-bob" })],
          })
        : json(200, automation({ enabled: false })),
    );
    const listed = await run((service) => service.toolList(caller("assistant:assistant-ada")));
    expect(listed._tag).toBe("Success");
    if (listed._tag === "Success") {
      const own = (listed.success as { automations: Array<{ id: number; when: string }> })
        .automations;
      expect(own.map((a) => a.id)).toEqual([7]);
      expect(own[0]!.when).toBe("When a pull request opens or updates in getuno/x");
    }
    const foreign = await run((service) =>
      service.toolDelete(caller("assistant:assistant-ada"), { id: 8 }),
    );
    expect(foreign._tag).toBe("Failure");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const paused = await run((service) =>
      service.toolUpdate(caller("assistant:assistant-ada"), { id: 7, enabled: false }),
    );
    expect(paused._tag).toBe("Success");
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      path: "/api/v1/boxes/7/work/automations/7",
      body: { enabled: false },
    });
  });

  it("the web names the assistant; one that isn't here is refused", async () => {
    const { calls, run } = setup(() => json(201, automation()));
    const missing = await run((service) =>
      service.create({
        assistant: "assistant-gone",
        instruction: "x",
        trigger: { kind: "call.ended" },
      }),
    );
    expect(missing._tag).toBe("Failure");
    expect(calls).toEqual([]);
    const made = await run((service) =>
      service.create({
        assistant: "assistant-ada",
        name: "Follow-ups",
        instruction: "Draft the follow-up",
        trigger: { kind: "call.ended" },
      }),
    );
    expect(made._tag).toBe("Success");
    expect(calls[0]!.body).toMatchObject({ assistant: "assistant-ada", assistant_name: "Ada" });
  });

  it("the web's list shows a renamed assistant's new name and tells the console", async () => {
    const { calls, run } = setup((method) =>
      method === "GET"
        ? json(200, {
            automations: [
              automation({ assistant_name: "Ada (old)" }),
              automation({ id: 9, assistant: "assistant-home", assistant_name: "Uno" }),
            ],
          })
        : json(200, automation()),
    );
    const result = await run((service) => service.list);
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.success.automations.map((a) => a.assistantName)).toEqual(["Ada", "Uno"]);
    }
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH")).toEqual([
        {
          method: "PATCH",
          path: "/api/v1/boxes/7/work/automations/7",
          body: { assistant_name: "Ada" },
        },
      ]),
    );
  });

  it("after a call: the enabled call.ended automations of that assistant", async () => {
    const { run } = setup(() =>
      json(200, {
        automations: [
          automation({ id: 1, trigger: { kind: "call.ended" }, name: "Follow-up" }),
          automation({ id: 2, trigger: { kind: "call.ended" }, enabled: false }),
          automation({ id: 3, trigger: { kind: "call.ended" }, assistant: "assistant-bob" }),
          automation({ id: 4 }),
        ],
      }),
    );
    const result = await run((service) => service.afterCall("assistant-ada"));
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.success).toEqual([
        { name: "Follow-up", instruction: "Review the PR and leave a comment" },
      ]);
    }
  });

  it("names and tells", () => {
    expect(
      defaultAutomationName("Plan my day. Then more.", {
        kind: "schedule",
        cron: "0 9 * * *",
        timezone: "UTC",
        label: "Every day at 09:00",
      }),
    ).toBe("Plan my day.");
    expect(
      createdTell({
        id: 1,
        boxId: 7,
        assistant: "assistant-ada",
        assistantName: "Ada",
        name: "Morning plan",
        instruction: "Plan",
        enabled: true,
        trigger: {
          kind: "schedule",
          cron: "0 9 * * 1-5",
          timezone: "UTC",
          label: "Weekdays at 09:00",
        },
        status: "ok",
        statusDetail: null,
        manageUrl: null,
        nextRunAt: null,
        lastRun: null,
        createdAt: "",
        updatedAt: "",
      }),
    ).toContain('"Morning plan" — Weekdays at 09:00');
  });
});

describe("uno-manager MCP automation tools", () => {
  const tools = {} as ManagerToolServiceShape;

  it("are listed for assistants only and route to the service with the caller", async () => {
    expect(isAssistantsOnlyManagerTool("automation_create")).toBe(true);
    const listed = await Effect.runPromise(
      handleManagerMcpMessage(tools, caller("assistant:assistant-home"), {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    );
    const names = (
      (listed as { body: { result: { tools: Array<{ name: string }> } } }).body.result.tools ?? []
    ).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "automation_create",
        "automation_list",
        "automation_update",
        "automation_delete",
      ]),
    );
    const basic = await Effect.runPromise(
      handleManagerMcpMessage(
        tools,
        caller("assistant:assistant-home"),
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        {},
        { assistantsEnabled: false },
      ),
    );
    expect(JSON.stringify(basic)).not.toContain("automation_create");

    const unwired = await Effect.runPromise(
      handleManagerMcpMessage(tools, caller("assistant:assistant-home"), {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "automation_list", arguments: {} },
      }),
    );
    expect(JSON.stringify(unwired)).toContain("do NOT fall back to cron");

    const seen: ManagerCaller[] = [];
    const routed = await Effect.runPromise(
      handleManagerMcpMessage(
        tools,
        caller("assistant:assistant-ada"),
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "automation_create",
            arguments: { instruction: "x", trigger: { kind: "call.ended" } },
          },
        },
        {
          automations: {
            toolCreate: (who: ManagerCaller) =>
              Effect.sync(() => {
                seen.push(who);
                return { created: true };
              }),
          } as unknown as AutomationsServiceShape,
        },
      ),
    );
    expect(seen[0]?.label).toBe("assistant:assistant-ada");
    expect(JSON.stringify(routed)).toContain("created");
  });
});

describe("outside triggers: what an agent may not do", () => {
  const chat = () => ({ threadId: "thread-7", assistant: Effect.succeed<string | null>(null) });

  it("a webhook from an agent always asks: its `ask: false` is dropped", async () => {
    const { calls, run } = setup((_m, _p, body) => json(201, automation({ ...(body as object) })));
    const result = await run((service) =>
      service.chatTools(chat()).create({
        instruction: "Look at it",
        trigger: { kind: "webhook", ask: false, requireSignature: true },
      }),
    );
    expect(result._tag).toBe("Success");
    expect((calls[0]!.body as { trigger: unknown }).trigger).toEqual({
      kind: "webhook",
      ask: true,
    });
  });

  it("automation_update can't open Ask mode", async () => {
    const own = automation({
      assistant: "",
      executor: { kind: "chat", thread_id: "thread-7" },
      trigger: { kind: "webhook", ask: true },
    });
    const { calls, run } = setup((method) =>
      method === "GET" ? json(200, { automations: [own] }) : json(200, own),
    );
    await run((service) =>
      service.chatTools(chat()).update({ id: own.id, trigger: { kind: "webhook", ask: false } }),
    );
    const patch = calls.find((call) => call.method === "PATCH");
    expect((patch!.body as { trigger: unknown }).trigger).toEqual({ kind: "webhook", ask: true });
  });

  it("a form isn't set through automation_create", async () => {
    const { calls, run } = setup(() => json(201, automation()));
    const result = await run((service) =>
      service.chatTools(chat()).create({
        instruction: "x",
        trigger: { kind: "site.form", slug: "report", ask: false },
      }),
    );
    expect(result._tag).toBe("Failure");
    expect(calls).toHaveLength(0);
  });

  it("site_forms_set {chat}: this chat, asks by default, then off", async () => {
    const made = automation({
      assistant: "",
      trigger: { kind: "site.form", slug: "report" },
      executor: { kind: "chat", thread_id: "thread-7" },
    });
    const { calls, run } = setup((method) =>
      method === "GET" ? json(200, { automations: [made] }) : json(201, made),
    );
    const on = await run((service) =>
      service.chatTools(chat()).siteForm({ slug: "report", chat: "this_chat" }),
    );
    expect(on._tag).toBe("Success");
    expect(calls[0]!.body).toMatchObject({
      trigger: { kind: "site.form", slug: "report" },
      executor: { kind: "chat", thread_id: "thread-7" },
    });
    expect(JSON.stringify(calls[0]!.body)).not.toContain('"ask":false');
    const off = await run((service) =>
      service.chatTools(chat()).siteForm({ slug: "report", chat: "off" }),
    );
    expect(off._tag).toBe("Success");
    expect(calls.some((call) => call.method === "DELETE")).toBe(true);
  });

  it("an assistant's own conversation can't take a form", async () => {
    const { calls, run } = setup(() => json(201, automation()));
    const result = await run((service) =>
      service
        .chatTools({ threadId: "thread-7", assistant: Effect.succeed("assistant-ada") })
        .siteForm({ slug: "report", chat: "this_chat" }),
    );
    expect(result._tag).toBe("Failure");
    expect(calls).toHaveLength(0);
  });

  it("the URL reaches the web only: the list and tools don't carry it", async () => {
    const hook = {
      url: "https://api.test/api/v1/hooks/1/secret",
      signing_secret: "whsec_x",
      require_signature: false,
      per_minute: 60,
      max_body_bytes: 262144,
    };
    const { calls, run } = setup((_m, p) =>
      p.endsWith("/hook") ? json(200, hook) : json(200, { automations: [] }),
    );
    const result = await run((service) => service.hook(1));
    expect(result).toMatchObject({
      _tag: "Success",
      success: { url: hook.url, signingSecret: "whsec_x", perMinute: 60 },
    });
    expect(calls[0]!.path).toBe("/api/v1/boxes/7/work/automations/1/hook");
  });
});

describe("uno-work automation_* from a chat (29.10)", () => {
  const chat = (assistant: string | null = null) => ({
    threadId: "thread-7",
    assistant: Effect.succeed(assistant),
  });

  it("this chat runs it by default: executor chat with its name, no assistant", async () => {
    const { calls, run } = setup((_m, _p, body) => json(201, automation({ ...(body as object) })));
    const result = await run((service) =>
      service.chatTools(chat()).create({
        instruction: "Sum up what changed today",
        trigger: {
          kind: "schedule",
          cron: "0 18 * * 1-5",
          timezone: "UTC",
          label: "Weekdays at 18:00",
        },
      }),
    );
    expect(result._tag).toBe("Success");
    expect(calls[0]!.body).toMatchObject({
      assistant: "",
      assistant_name: "",
      executor: { kind: "chat", thread_id: "thread-7", title: "Release notes" },
    });
    expect(JSON.stringify(result)).toContain("It runs in this chat");
  });

  it("runIn new_chat: a new chat in this chat's project, set up from it", async () => {
    const { calls, run } = setup((_m, _p, body) => json(201, automation({ ...(body as object) })));
    await run((service) =>
      service.chatTools(chat()).create({
        instruction: "Check CI",
        trigger: {
          kind: "schedule",
          cron: "*/30 * * * *",
          timezone: "UTC",
          label: "Every 30 minutes",
        },
        runIn: "new_chat",
      }),
    );
    expect(calls[0]!.body).toMatchObject({
      executor: { kind: "new_chat", project_id: "proj-site", from_thread_id: "thread-7" },
    });
  });

  it("in an assistant's own conversation the assistant runs it", async () => {
    const { calls, run } = setup((_m, _p, body) => json(201, automation({ ...(body as object) })));
    await run((service) =>
      service.chatTools(chat("assistant-ada")).create({
        instruction: "Plan my day",
        trigger: {
          kind: "schedule",
          cron: "0 8 * * *",
          timezone: "UTC",
          label: "Every day at 08:00",
        },
      }),
    );
    expect(calls[0]!.body).toMatchObject({ assistant: "assistant-ada", assistant_name: "Ada" });
    expect((calls[0]!.body as Record<string, unknown>)["executor"]).toBeUndefined();
  });

  it("a chat lists and changes only its own", async () => {
    const list = {
      automations: [
        automation({ id: 1, executor: { kind: "chat", thread_id: "thread-7" } }),
        automation({ id: 2, executor: { kind: "chat", thread_id: "thread-8" } }),
        automation({ id: 3 }),
      ],
    };
    const { calls, run } = setup((method) =>
      method === "GET" ? json(200, list) : json(200, { deleted: true }),
    );
    const own = await run((service) => service.chatTools(chat()).list({}));
    expect(
      own._tag === "Success" && (own.success as { automations: unknown[] }).automations,
    ).toHaveLength(1);
    const all = await run((service) => service.chatTools(chat()).list({ scope: "all" }));
    expect(
      all._tag === "Success" && (all.success as { automations: unknown[] }).automations,
    ).toHaveLength(3);
    const foreign = await run((service) => service.chatTools(chat()).remove({ id: 2 }));
    expect(foreign._tag).toBe("Failure");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const mine = await run((service) => service.chatTools(chat()).remove({ id: 1 }));
    expect(mine._tag).toBe("Success");
  });

  it("refuses a chat that isn't on this computer (web create)", async () => {
    const { calls, run } = setup(() => json(201, automation()));
    const result = await run((service) =>
      service.create({
        instruction: "x",
        trigger: {
          kind: "schedule",
          cron: "0 9 * * *",
          timezone: "UTC",
          label: "Every day at 09:00",
        },
        executor: { kind: "chat", threadId: "nope" },
      }),
    );
    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).toContain("INVALID_EXECUTOR");
    expect(calls).toHaveLength(0);
  });
});
