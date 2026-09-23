import type { OrchestrationCommand, OrchestrationCommandOrigin } from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { filesChangedSince, makeAppTasks, resolveTaskCwd } from "./appTasks.ts";

let root: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "app-tasks-"));
  home = path.join(root, "home");
  await mkdir(path.join(home, "Inbox"), { recursive: true });
  await mkdir(path.join(root, "outside"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveTaskCwd", () => {
  it("accepts folders inside home", async () => {
    const result = await resolveTaskCwd("~/Inbox", home, home);
    expect(result.ok && result.cwd.endsWith(`${path.sep}Inbox`)).toBe(true);
  });

  it("refuses paths outside home, also through a symlink", async () => {
    expect((await resolveTaskCwd("/etc", home, home)).ok).toBe(false);
    expect((await resolveTaskCwd("~/../outside", home, home)).ok).toBe(false);
    await symlink(path.join(root, "outside"), path.join(home, "escape"));
    const viaLink = await resolveTaskCwd("~/escape", home, home);
    expect(viaLink).toMatchObject({ ok: false, code: "cwd_outside_home" });
  });

  it("refuses a folder that does not exist", async () => {
    expect(await resolveTaskCwd("~/nope", home, home)).toMatchObject({
      ok: false,
      code: "cwd_not_found",
    });
  });
});

describe("createTask", () => {
  const setup = () => {
    const dispatched: Array<{
      command: OrchestrationCommand;
      origin?: OrchestrationCommandOrigin;
      /** Label of the thread at the moment the command went out. */
      labelAtDispatch?: string | null;
    }> = [];
    const labels = new Map<string, string>();
    const tasks = makeAppTasks({
      engine: {
        dispatch: (command, options) => {
          dispatched.push({
            command,
            ...(options?.origin ? { origin: options.origin } : {}),
            labelAtDispatch:
              "threadId" in command ? (labels.get(String(command.threadId)) ?? null) : null,
          });
          return Effect.succeed({ sequence: dispatched.length });
        },
      },
      projections: {
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
      },
      getProviders: Effect.succeed([]),
      getTaskModelSelection: Effect.succeed({ instanceId: "uno", model: "uno/m" } as never),
      home,
      labelThread: (threadId, appId) => labels.set(threadId, appId),
    });
    return { tasks, dispatched, labels };
  };
  const caller = {
    appId: "digest",
    appName: "Digest",
    manifestCwd: null,
    taskToolsCap: "edit" as const,
  };

  it("starts a visible, app-stamped chat and narrows the tools to the person's cap", async () => {
    const { tasks, dispatched } = setup();
    const { reply, task } = await Effect.runPromise(
      tasks.createTask(caller, { prompt: "Summarise the Inbox", cwd: "~/Inbox", tools: "full" }),
    );
    expect(reply.status).toBe(202);
    expect(task?.tools).toBe("edit");
    const types = dispatched.map((d) => d.command.type);
    expect(types).toEqual(["project.create", "thread.create", "thread.turn.start"]);
    for (const d of dispatched) expect(d.origin).toMatchObject({ kind: "app", appId: "digest" });
    const create = dispatched[1]?.command as Extract<
      OrchestrationCommand,
      { type: "thread.create" }
    >;
    expect(create.title).toBe("[Digest] Summarise the Inbox");
    expect(create.runtimeMode).toBe("auto-accept-edits");
    expect((reply.body as { note?: string }).note).toContain("narrowed");
  });

  it("labels the thread with the app before its first turn, so the harness meters it", async () => {
    const { tasks, dispatched, labels } = setup();
    const { task } = await Effect.runPromise(tasks.createTask(caller, { prompt: "x" }));
    expect(labels.get(task!.threadId)).toBe("digest");
    const turn = dispatched.find((d) => d.command.type === "thread.turn.start");
    expect(turn?.labelAtDispatch).toBe("digest");
  });

  it("does not label anything when the task is refused", async () => {
    const { tasks, labels } = setup();
    await Effect.runPromise(tasks.createTask(caller, { prompt: "x", cwd: "/etc" }));
    expect(labels.size).toBe(0);
  });

  it("defaults to asking the person for every change", async () => {
    const { tasks, dispatched } = setup();
    await Effect.runPromise(tasks.createTask(caller, { prompt: "x" }));
    const create = dispatched.find((d) => d.command.type === "thread.create")?.command as Extract<
      OrchestrationCommand,
      { type: "thread.create" }
    >;
    expect(create.runtimeMode).toBe("approval-required");
  });

  it("refuses a cwd outside home without dispatching anything", async () => {
    const { tasks, dispatched } = setup();
    const { reply } = await Effect.runPromise(
      tasks.createTask(caller, { prompt: "x", cwd: "/etc" }),
    );
    expect(reply.status).toBe(400);
    expect(dispatched).toEqual([]);
  });
});

describe("filesChangedSince", () => {
  it("lists files written after the task started, skipping node_modules", async () => {
    const { writeFile, utimes } = await import("node:fs/promises");
    const inbox = path.join(home, "Inbox");
    await writeFile(path.join(inbox, "old.txt"), "old");
    const past = new Date(Date.now() - 60_000);
    await utimes(path.join(inbox, "old.txt"), past, past);
    const since = new Date(Date.now() - 1_000).toISOString();
    await writeFile(path.join(inbox, "todo.md"), "- a");
    await mkdir(path.join(inbox, "node_modules"), { recursive: true });
    await writeFile(path.join(inbox, "node_modules", "x.js"), "x");
    expect(await filesChangedSince(inbox, since)).toEqual(["todo.md"]);
  });
});
