import type { OrchestrationCommand, OrchestrationCommandOrigin } from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAppTasks, resolveTaskCwd } from "./appTasks.ts";

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
    }> = [];
    const tasks = makeAppTasks({
      engine: {
        dispatch: (command, options) => {
          dispatched.push({ command, ...(options?.origin ? { origin: options.origin } : {}) });
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
    });
    return { tasks, dispatched };
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
