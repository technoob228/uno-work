import {
  type OrchestrationCommand,
  type OrchestrationCommandOrigin,
  type OrchestrationProject,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { defaultProjectFor, lastUsedModel, makeRemoteChatHost } from "./remoteChatHost.ts";
import type { IncomingRemoteChat } from "./remoteChatStore.ts";

const T0 = "2026-10-28T10:00:00.000Z";
const SITE = "project-site" as ProjectId;
const UNO = "assistant-uno" as ProjectId;

const project = (id: ProjectId, overrides: Partial<OrchestrationProjectShell> = {}) =>
  ({
    id,
    title: id,
    workspaceRoot: `/home/uno/projects/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }) as OrchestrationProjectShell;

const thread = (id: string, overrides: Partial<OrchestrationThreadShell> = {}) =>
  ({
    id: id as ThreadId,
    projectId: SITE,
    title: id,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  }) as OrchestrationThreadShell;

function host(options: {
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly ledger?: ReadonlyMap<string, string>;
}) {
  const projects = options.projects ?? [project(SITE), project(UNO)];
  const threads = new Map((options.threads ?? []).map((entry) => [entry.id as string, entry]));
  const incoming: IncomingRemoteChat[] = [];
  const dispatched: Array<{ command: OrchestrationCommand; origin?: OrchestrationCommandOrigin }> =
    [];
  const remoteHost = makeRemoteChatHost({
    engine: {
      dispatch: (command, dispatchOptions) =>
        Effect.sync(() => {
          dispatched.push({
            command,
            ...(dispatchOptions?.origin ? { origin: dispatchOptions.origin } : {}),
          });
          if (command.type === "thread.create") {
            threads.set(
              command.threadId,
              thread(command.threadId, {
                projectId: command.projectId,
                title: command.title,
                runtimeMode: command.runtimeMode,
              }),
            );
          }
          return { sequence: dispatched.length };
        }),
    },
    projections: {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [...projects],
          threads: [...threads.values()],
          updatedAt: T0,
        }),
      getThreadShellById: (id) => Effect.succeed(Option.fromNullishOr(threads.get(id))),
      getThreadDetailById: (id) =>
        Effect.succeed(
          threads.has(id)
            ? Option.some({
                ...threads.get(id),
                messages: [{ role: "assistant", text: "Fixed it, tests pass." }],
              } as unknown as OrchestrationThread)
            : Option.none(),
        ),
      getProjectShellById: (id) =>
        Effect.succeed(Option.fromNullishOr(projects.find((entry) => entry.id === id))),
      getActiveProjectByWorkspaceRoot: (root) =>
        Effect.succeed(
          Option.fromNullishOr(
            projects.find((entry) => entry.workspaceRoot === root) as
              | OrchestrationProject
              | undefined,
          ),
        ),
      getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    },
    getProviders: Effect.succeed([]),
    incoming: {
      record: (entry) => Effect.sync(() => void incoming.push(entry)),
      list: Effect.sync(() => [...incoming]),
    },
    startedChats: Effect.succeed(options.ledger ?? new Map()),
    assistantName: (projectId, title) => Effect.succeed(projectId === UNO ? "Uno" : title),
    home: "/home/uno",
    nowMs: () => Date.parse(T0),
  });
  return { remoteHost, dispatched, incoming, threads };
}

const startedBy = {
  assistantName: "Ada",
  assistantProjectId: "assistant-ada",
  fromComputerName: "MacBook",
  fromBoxId: null,
  fromThreadId: "thread-ada",
};

describe("remote chat host", () => {
  it("starts the chat in the folder's project, never wider than asked, records who", async () => {
    const { remoteHost, dispatched, incoming } = host({
      threads: [thread("earlier", { updatedAt: "2026-10-27T10:00:00.000Z" })],
    });
    const reply = await Effect.runPromise(
      remoteHost.create({
        text: "Fix the build",
        cwd: "~/projects/project-site",
        runtimeMode: "approval-required",
        startedBy,
      }),
    );
    expect(reply.status).toBe(200);
    const created = dispatched[0]!.command;
    expect(created.type).toBe("thread.create");
    if (created.type === "thread.create") {
      expect(created.projectId).toBe(SITE);
      expect(created.runtimeMode).toBe("approval-required");
      // No default AI on the project: what its newest chat ran on.
      expect(created.modelSelection.instanceId).toBe("claudeAgent");
    }
    expect(dispatched[1]!.command.type).toBe("thread.turn.start");
    expect(dispatched[0]!.origin).toMatchObject({ kind: "system", component: "remote-chat" });
    expect(incoming).toEqual([
      expect.objectContaining({ assistantName: "Ada", fromComputerName: "MacBook" }),
    ]);
  });

  it("records the assistant's app levels so this computer limits its chat", async () => {
    const { remoteHost, incoming } = host({ threads: [thread("earlier")] });
    const apps = { restricted: true, permissions: { gmail: "read" as const } };
    await Effect.runPromise(
      remoteHost.create({
        text: "Fix",
        cwd: "~/projects/project-site",
        startedBy: { ...startedBy, apps, preset: "helper" },
      }),
    );
    expect(incoming[0]).toMatchObject({ apps, preset: "helper" });
  });

  it("an assistant's own folder and a missing folder are refused", async () => {
    const { remoteHost } = host({});
    const own = await Effect.runPromise(
      remoteHost.create({ text: "hi", projectId: UNO, startedBy }),
    );
    expect(own.status).toBe(403);
    // A folder that isn't here and no AI to open the home folder with: said plainly.
    const missing = await Effect.runPromise(
      remoteHost.create({ text: "hi", cwd: "~/nowhere", startedBy }),
    );
    expect(missing.status).toBe(409);
    expect(JSON.stringify(missing.body)).toContain("No AI is ready");
  });

  it("a folder that isn't here, or no projects at all: the chat starts in the home folder", async () => {
    const home = project("home-folder" as never, {
      workspaceRoot: "/home/uno",
      title: "Home folder",
      defaultModelSelection: { instanceId: "uno", model: "smart" } as never,
    });
    const { remoteHost, dispatched } = host({ projects: [home] });
    const reply = await Effect.runPromise(
      remoteHost.create({ text: "uname -a", cwd: "~/projects/coffee-site", startedBy }),
    );
    expect(reply.status).toBe(200);
    expect((reply.body as { projectId: string }).projectId).toBe("home-folder");
    const fresh = await Effect.runPromise(remoteHost.create({ text: "uname -a", startedBy }));
    expect(fresh.status).toBe(200);
    expect(dispatched.some(({ command }) => command.type === "project.create")).toBe(false);
  });

  it("status only for chats that came from another computer", async () => {
    const { remoteHost, threads } = host({ threads: [thread("local")] });
    expect((await Effect.runPromise(remoteHost.status("local"))).status).toBe(404);
    const created = await Effect.runPromise(
      remoteHost.create({ text: "Fix", runtimeMode: "full-access", startedBy }),
    );
    const threadId = (created.body as { threadId: string }).threadId;
    threads.set(
      threadId,
      thread(threadId, {
        latestTurn: {
          turnId: "turn-1",
          state: "completed",
          requestedAt: T0,
          startedAt: T0,
          completedAt: T0,
          assistantMessageId: null,
        } as never,
      }),
    );
    const status = await Effect.runPromise(remoteHost.status(threadId));
    expect(status.body).toMatchObject({ state: "done", lastMessage: "Fixed it, tests pass." });
  });

  it("started-by lists this computer's assistants' chats and other computers'", async () => {
    const { remoteHost } = host({
      threads: [
        thread("uno-main", { projectId: UNO, assistantRole: "chat" } as never),
        thread("spawned", { spawnedByThreadId: "uno-main" as ThreadId }),
        thread("person"),
      ],
    });
    await Effect.runPromise(remoteHost.create({ text: "Fix", startedBy }));
    const reply = await Effect.runPromise(remoteHost.startedBy());
    const items = (reply.body as { items: Array<Record<string, unknown>> }).items;
    expect(items.find((item) => item["threadId"] === "spawned")).toMatchObject({
      assistantName: "Uno",
      local: true,
    });
    expect(items.find((item) => item["local"] === false)).toMatchObject({
      assistantName: "Ada",
      fromComputerName: "MacBook",
    });
    expect(items.some((item) => item["threadId"] === "person")).toBe(false);
    expect(items.some((item) => item["threadId"] === "uno-main")).toBe(false);
  });
});

describe("defaults", () => {
  it("the project used last, never an assistant's", () => {
    expect(
      defaultProjectFor(
        [project(SITE), project(UNO), project("project-old" as ProjectId)],
        [
          thread("a", { projectId: UNO, updatedAt: "2026-10-28T12:00:00.000Z" }),
          thread("b", { projectId: SITE, updatedAt: "2026-10-28T11:00:00.000Z" }),
        ],
      ),
    ).toBe(SITE);
  });
  it("last used model: the project's newest chat, else any", () => {
    expect(lastUsedModel([], SITE)).toBeNull();
    expect(
      lastUsedModel([thread("x", { projectId: "other" as ProjectId })], SITE)?.instanceId,
    ).toBe("claudeAgent");
  });
});
