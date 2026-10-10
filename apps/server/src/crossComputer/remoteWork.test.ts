import type {
  ModelSelection,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { homeRelative, makeAgentRemoteChats } from "./agentRemoteChats.ts";
import { runChatCli } from "./chatCli.ts";
import {
  chooseRemoteModel,
  chooseRemoteProject,
  formatRemoteThreadId,
  openRemoteSession,
  parseRemoteThreadId,
  readRemoteChat,
  RemoteSessionCache,
  RemoteWorkError,
  resolveComputer,
  sendRemoteMessage,
  startRemoteChat,
  type RemoteWorkDeps,
  type RemoteWorkSession,
} from "./remoteWork.ts";

const T0 = "2026-10-09T12:00:00.000Z";
const UNO_AI = { instanceId: "hermes", model: "uno/smart" } as unknown as ModelSelection;

const project = (
  id: string,
  workspaceRoot: string,
  extra: Partial<OrchestrationProjectShell> = {},
): OrchestrationProjectShell =>
  ({
    id: id as ProjectId,
    title: id,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  }) as OrchestrationProjectShell;

const thread = (
  id: string,
  projectId: string,
  extra: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell =>
  ({
    id: id as ThreadId,
    projectId: projectId as ProjectId,
    title: id,
    modelSelection: UNO_AI,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    pinnedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...extra,
  }) as OrchestrationThreadShell;

/** A fake B: the console, `/oauth/token`, the shell, dispatch and thread detail. */
function fakeComputer(options: {
  readonly projects?: OrchestrationProjectShell[];
  readonly threads?: OrchestrationThreadShell[];
  readonly tokenStatuses?: number[];
  readonly consoleError?: string;
}) {
  const state = {
    projects: [
      ...(options.projects ?? [project("assistant-home", "/home/u/UnoWork/Assistants/home")]),
    ],
    threads: [...(options.threads ?? [thread("uno", "assistant-home", { assistantRole: "chat" })])],
    messages: new Map<string, Array<{ role: string; text: string; createdAt: string }>>(),
    dispatched: [] as Array<Record<string, any>>,
    mints: 0,
    tokenCalls: 0,
    labels: [] as string[],
  };
  const tokenStatuses = [...(options.tokenStatuses ?? [])];
  let clock = Date.parse(T0);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    if (u.pathname === "/oauth/token") {
      state.tokenCalls += 1;
      const next = tokenStatuses.shift();
      if (next === -1) throw new TypeError("fetch failed");
      if (next !== undefined && next !== 200) return json(next, { error: "nope" });
      state.labels.push(new URLSearchParams(String(init?.body)).get("client_label") ?? "");
      return json(200, { access_token: "sess", expires_in: 3600 });
    }
    if ((init?.headers as Record<string, string>)?.authorization !== "Bearer sess") {
      return json(401, { error: "unauthorized" });
    }
    if (u.pathname === "/api/orchestration/shell") {
      return json(200, {
        snapshotSequence: 1,
        projects: state.projects,
        threads: state.threads,
        updatedAt: T0,
      });
    }
    if (u.pathname === "/api/orchestration/dispatch" && method === "POST") {
      const command = JSON.parse(String(init?.body)) as Record<string, any>;
      state.dispatched.push(command);
      if (command.type === "project.create") {
        state.projects.push(
          project(command.projectId, command.workspaceRoot.replace(/^~/, "/home/u"), {
            defaultModelSelection: command.defaultModelSelection,
          }),
        );
      }
      if (command.bootstrap)
        return json(400, { error: "Failed to dispatch orchestration command." });
      if (command.type === "thread.create") {
        state.threads.push(
          thread(command.threadId, command.projectId, {
            title: command.title,
            runtimeMode: command.runtimeMode,
            updatedAt: new Date(clock).toISOString(),
          }),
        );
      }
      if (command.type === "thread.turn.start") {
        const list = state.messages.get(command.threadId) ?? [];
        list.push({ role: "user", text: command.message.text, createdAt: T0 });
        state.messages.set(command.threadId, list);
      }
      return json(200, { sequence: state.dispatched.length });
    }
    const detail = /^\/api\/orchestration\/threads\/(.+)$/.exec(u.pathname);
    if (detail) {
      return json(200, {
        snapshotSequence: 1,
        thread: { messages: state.messages.get(detail[1]!) ?? [] },
      });
    }
    return json(404, { error: "not found" });
  }) as typeof fetch;

  const deps: RemoteWorkDeps = {
    fetch: fetchImpl,
    controlPlane: async (path) => {
      state.mints += 1;
      if (options.consoleError) throw new Error(options.consoleError);
      expect(path).toBe("/api/v1/boxes/2575/work/session");
      return {
        url: "https://cc-target.example/pair#token=one-time",
        hostname: "cc-target.example",
      };
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { state, deps };
}

const session: RemoteWorkSession = {
  boxId: 2575,
  baseUrl: "https://cc-target.example",
  token: "sess",
  expiresAtMs: Date.parse(T0) + 30 * 24 * 3600 * 1000,
};

describe("resolveComputer", () => {
  const boxes = [
    { id: 2574, name: "uno-work", status: "running" },
    { id: 2575, name: "cc-target", status: "sleeping" },
  ];
  it("finds by number, box-N or name (any case)", () => {
    expect(resolveComputer(boxes, 2575).id).toBe(2575);
    expect(resolveComputer(boxes, "box-2575").id).toBe(2575);
    expect(resolveComputer(boxes, " CC-Target ").id).toBe(2575);
  });
  it("names the account's computers when not found, refuses a name used twice", () => {
    expect(() => resolveComputer(boxes, "mac")).toThrow(/cc-target \(2575\)/);
    expect(() =>
      resolveComputer([...boxes, { id: 9, name: "cc-target", status: "running" }], "cc-target"),
    ).toThrow(/Several computers/);
  });
});

describe("remote thread ids", () => {
  it("round-trip, also URL-encoded", () => {
    expect(formatRemoteThreadId(2575, "abc-1")).toBe("box-2575:abc-1");
    expect(parseRemoteThreadId("box-2575:abc-1")).toEqual({ boxId: 2575, threadId: "abc-1" });
    expect(parseRemoteThreadId("box-2575%3Aabc-1")).toEqual({ boxId: 2575, threadId: "abc-1" });
    expect(parseRemoteThreadId("abc-1")).toBeNull();
    expect(parseRemoteThreadId("box-x:abc")).toBeNull();
  });
});

describe("where the chat goes on the other computer", () => {
  const shell = {
    projects: [
      project("assistant-home", "/home/u/UnoWork/Assistants/home"),
      project("site", "/home/u/projects/site", { defaultModelSelection: UNO_AI }),
      project("old", "/home/u/projects/old"),
    ],
    threads: [
      thread("t-old", "old", { updatedAt: "2026-10-01T00:00:00.000Z" }),
      thread("t-site", "site", { updatedAt: "2026-10-08T00:00:00.000Z" }),
      thread("uno", "assistant-home", {
        assistantRole: "chat",
        updatedAt: "2026-10-09T00:00:00.000Z",
      }),
    ],
  };
  it("the folder's project (~ means that computer's home), else the one used last, never the assistant's", () => {
    expect(chooseRemoteProject(shell, "~/projects/old")).toEqual({ project: shell.projects[2] });
    expect(chooseRemoteProject(shell, "/home/u/projects/site")).toEqual({
      project: shell.projects[1],
    });
    expect(chooseRemoteProject(shell, "~/projects/new")).toEqual({ create: "~/projects/new" });
    expect(chooseRemoteProject(shell, undefined)).toEqual({ project: shell.projects[1] });
    expect(chooseRemoteProject({ projects: [shell.projects[0]!], threads: [] }, undefined)).toEqual(
      {
        create: "~/projects",
      },
    );
  });
  it("the AI that computer would pick: project default, last used, its Uno chat; a model override keeps the harness", () => {
    expect(chooseRemoteModel(shell, shell.projects[1]!, undefined)).toEqual(UNO_AI);
    const onlyUno = { threads: [thread("uno", "assistant-home", { assistantRole: "chat" })] };
    expect(chooseRemoteModel(onlyUno, null, undefined)).toEqual(UNO_AI);
    expect(chooseRemoteModel(onlyUno, null, "uno/fast")).toEqual({
      instanceId: "hermes",
      model: "uno/fast",
    });
    expect(() => chooseRemoteModel({ threads: [] }, null, undefined)).toThrow(RemoteWorkError);
  });
});

describe("openRemoteSession", () => {
  it("waits out an address that is not routed yet with the same one-time link", async () => {
    const { state, deps } = fakeComputer({ tokenStatuses: [-1, 502, 200] });
    const opened = await openRemoteSession(deps, { boxId: 2575, clientLabel: "Agent on uno-work" });
    expect(opened.baseUrl).toBe("https://cc-target.example");
    expect(state.mints).toBe(1);
    expect(state.tokenCalls).toBe(3);
    expect(state.labels).toEqual(["Agent on uno-work"]);
  });
  it("a used-up link gets a fresh one", async () => {
    const { state, deps } = fakeComputer({ tokenStatuses: [401, 200] });
    await openRemoteSession(deps, { boxId: 2575, clientLabel: "x" });
    expect(state.mints).toBe(2);
  });
  it("a connected agent key is told it needs the account key", async () => {
    const { deps } = fakeComputer({ consoleError: "403: ACCOUNT_SCOPE_REQUIRED" });
    await expect(openRemoteSession(deps, { boxId: 2575, clientLabel: "x" })).rejects.toMatchObject({
      code: "account_key_required",
      status: 403,
    });
  });
  it("cache: one sign-in per computer while it is valid", async () => {
    const { state, deps } = fakeComputer({});
    const cache = new RemoteSessionCache();
    const open = () => openRemoteSession(deps, { boxId: 2575, clientLabel: "x" });
    await cache.get("k", deps.now(), open);
    await cache.get("k", deps.now(), open);
    expect(state.mints).toBe(1);
    await cache.get("k", deps.now() + 3600 * 1000, open);
    expect(state.mints).toBe(2);
  });
});

describe("start, read, send", () => {
  it("starts the chat like the composer: new project for a new folder, marked as from the agent", async () => {
    const { state, deps } = fakeComputer({});
    const started = await startRemoteChat(deps, session, {
      text: "list ~/projects and say hi",
      folder: "~/projects/demo",
      from: "the agent on uno-work",
      fromChatTitle: "Coordinator",
      runtimeMode: "auto-accept-edits",
    });
    expect(state.dispatched.map((command) => command.type)).toEqual([
      "project.create",
      "thread.create",
      "thread.turn.start",
    ]);
    const [create, newThread, turn] = state.dispatched;
    expect(create).toMatchObject({
      workspaceRoot: "~/projects/demo",
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: UNO_AI,
    });
    expect(newThread).toMatchObject({
      threadId: started.threadId,
      projectId: create!.projectId,
      title: "list ~/projects and say hi",
      modelSelection: UNO_AI,
      runtimeMode: "auto-accept-edits",
    });
    expect(newThread!.spawnedByThreadId).toBeUndefined();
    expect(turn).toMatchObject({ threadId: started.threadId, runtimeMode: "auto-accept-edits" });
    expect(turn!.message.text).toBe(
      "[Started by the agent on uno-work · chat “Coordinator”]\nlist ~/projects and say hi",
    );
    expect(started.folder).toBe("/home/u/projects/demo");
  });

  it("reads the chat back with the agent's header stripped and named", async () => {
    const { deps } = fakeComputer({});
    const started = await startRemoteChat(deps, session, {
      text: "hi",
      from: "the agent on uno-work",
      runtimeMode: "full-access",
    });
    const view = await readRemoteChat(deps, session, started.threadId, { limit: 10, waitMs: 0 });
    expect(view.messages).toEqual([
      { role: "user", author: "agent", from: "the agent on uno-work", text: "hi", createdAt: T0 },
    ]);
    await expect(
      readRemoteChat(deps, session, "nope", { limit: 1, waitMs: 0 }),
    ).rejects.toMatchObject({ code: "thread_not_found" });
  });

  it("send: never into a chat closed to agents, waits out a busy one, never widens rights", async () => {
    const busy = thread("busy", "p", { session: { status: "running" } as never });
    const closed = thread("closed", "p", { agentsClosedAt: T0 });
    const wide = thread("wide", "p", { runtimeMode: "full-access" });
    const { state, deps } = fakeComputer({
      projects: [project("p", "/home/u/p")],
      threads: [busy, closed, wide],
    });
    const send = (id: string, runtimeMode: "full-access" | "approval-required" = "full-access") =>
      sendRemoteMessage(deps, session, id, {
        text: "go",
        waitMs: 5_000,
        from: "the agent on uno-work",
        runtimeMode,
      });
    await expect(send("closed")).rejects.toMatchObject({ code: "agents_closed", status: 409 });
    await expect(send("busy")).rejects.toMatchObject({ code: "target_busy" });
    await expect(send("wide", "approval-required")).rejects.toMatchObject({
      code: "runtime_mode_escalation",
    });
    await send("wide");
    expect(state.dispatched).toHaveLength(1);
    expect(state.dispatched[0]!.message.text).toBe("[Sent by the agent on uno-work]\ngo");
  });
});

describe("agent bridge policy", () => {
  const caller = thread("caller", "p", { title: "Coordinator", runtimeMode: "approval-required" });
  const make = (policy: {
    apiKey: string;
    agentAccessOff: boolean;
    otherComputersAllowed: boolean;
  }) => {
    const { state, deps } = fakeComputer({});
    const port = makeAgentRemoteChats({
      getPolicy: Effect.succeed(policy),
      listComputers: async () => [
        { id: 2574, name: "uno-work", status: "running" },
        { id: 2575, name: "cc-target", status: "running" },
      ],
      getOwnBoxId: Effect.succeed(2574),
      getOwnLabel: Effect.succeed("uno-work"),
      makeRemoteDeps: () => deps,
      cache: new RemoteSessionCache(),
      home: "/home/me",
    });
    return { port, state };
  };
  const start = (port: ReturnType<typeof make>["port"], computer: string) =>
    Effect.runPromise(
      port.start({
        caller,
        computer,
        text: "hi",
        title: undefined,
        cwd: "/home/me/projects/x",
        model: undefined,
      }),
    );

  it("on by default: starts on the other computer with the caller's rights, in ~/…", async () => {
    const { port, state } = make({
      apiKey: "k",
      agentAccessOff: false,
      otherComputersAllowed: true,
    });
    const reply = await start(port, "cc-target");
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ ok: true, computer: { id: 2575, name: "cc-target" } });
    expect(String((reply.body as { threadId: string }).threadId)).toMatch(/^box-2575:/);
    expect(state.dispatched[0]).toMatchObject({
      type: "project.create",
      workspaceRoot: "~/projects/x",
    });
    expect(state.dispatched[2]).toMatchObject({
      type: "thread.turn.start",
      runtimeMode: "approval-required",
    });
    expect(state.labels).toEqual(["Agent on uno-work"]);
  });

  it("the switch, agent access off and no key all refuse; this computer by name is refused", async () => {
    for (const [policy, code] of [
      [
        { apiKey: "k", agentAccessOff: false, otherComputersAllowed: false },
        "computer_not_allowed",
      ],
      [{ apiKey: "k", agentAccessOff: true, otherComputersAllowed: true }, "account_access_off"],
      [{ apiKey: "", agentAccessOff: false, otherComputersAllowed: true }, "not_linked"],
    ] as const) {
      const reply = await start(make(policy).port, "cc-target");
      expect(reply.status).toBe(403);
      expect((reply.body as { error: string }).error).toBe(code);
    }
    const self = await start(
      make({ apiKey: "k", agentAccessOff: false, otherComputersAllowed: true }).port,
      "uno-work",
    );
    expect((self.body as { error: string }).error).toBe("this_computer");
  });

  it("homeRelative", () => {
    expect(homeRelative("/home/me/projects/x", "/home/me")).toBe("~/projects/x");
    expect(homeRelative("/home/me", "/home/me/")).toBe("~");
    expect(homeRelative("/srv/x", "/home/me")).toBe("/srv/x");
    expect(homeRelative("~/x", "/home/me")).toBe("~/x");
  });
});

describe("t3 chat (CLI)", () => {
  it("start → send → status with the account key, one sign-in", async () => {
    const { state, deps } = fakeComputer({});
    const cli = {
      ...deps,
      apiKey: "key",
      listComputers: async () => [{ id: 2575, name: "cc-target", status: "running" }],
      cache: new RemoteSessionCache(),
      defaultFrom: "an agent on mac",
    };
    const started = await runChatCli(
      { action: "start", computer: "cc-target", text: "hi", from: "Claude Code on Mac" },
      cli,
    );
    expect(started.exitCode).toBe(0);
    const threadId = String(started.output.threadId);
    expect(threadId).toMatch(/^box-2575:/);
    expect((await runChatCli({ action: "send", threadId, text: "next" }, cli)).exitCode).toBe(0);
    const status = await runChatCli({ action: "status", threadId }, cli);
    expect(status.output).toMatchObject({ ok: true, status: "idle" });
    expect(
      (status.output.messages as Array<{ from: string }>).map((message) => message.from),
    ).toEqual(["Claude Code on Mac", "an agent on mac"]);
    expect(state.mints).toBe(1);
    expect((await runChatCli({ action: "status", threadId: "nope" }, cli)).exitCode).toBe(2);
    expect(
      (await runChatCli({ action: "status", threadId }, { ...cli, apiKey: "" })).exitCode,
    ).toBe(2);
  });
});
