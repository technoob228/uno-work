import { ProjectId, ManagerTokenId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type { ManagerCaller } from "../manager/Services/ManagerToolService.ts";
import { handleManagerMcpMessage } from "../manager/mcp.ts";
import type { ManagerToolServiceShape } from "../manager/Services/ManagerToolService.ts";
import {
  AssistantSchedules,
  type AssistantSchedulesShape,
  assistantProjectOfCaller,
  buildAssistantTurnCommand,
  makeAssistantSchedules,
  normalizeScheduleText,
  parseAssistantTurnCommand,
  scheduleConsoleProblem,
  selectAssistantSchedules,
  shellQuote,
  splitShellWords,
} from "./schedules.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const WORKSPACE = "/home/unowork/UnoWork/Assistants/home";

const withService = <A, E>(
  use: (schedules: AssistantSchedulesShape) => Effect.Effect<A, E>,
): Effect.Effect<A, E, AssistantSchedules> =>
  Effect.gen(function* () {
    const schedules = yield* AssistantSchedules;
    return yield* use(schedules);
  });

const caller = (label?: string): ManagerCaller => ({
  tokenId: ManagerTokenId.make("tok-1"),
  scopes: ["threads:read", "threads:write"],
  projectAllowlist: "all",
  budget: null,
  autoApprove: true,
  ...(label !== undefined ? { label } : {}),
});

describe("assistant turn command line", () => {
  it("quotes anything a prompt can hold and parses it back", () => {
    const prompt = `Собери упоминания "Uno" в X; не трогай $HOME && rm -rf / — it's fine \`id\``;
    const command = buildAssistantTurnCommand({
      workspaceRoot: WORKSPACE,
      name: "Monday's digest",
      prompt,
      timeoutSec: 900,
    });
    expect(command.startsWith("uno-work assistant-turn --workspace ")).toBe(true);
    const parsed = parseAssistantTurnCommand(command);
    expect(parsed).toEqual({
      workspaceRoot: WORKSPACE,
      name: "Monday's digest",
      prompt,
      timeoutSec: 900,
    });
    // Nothing outside single quotes but our own flags.
    expect(splitShellWords(command)).toHaveLength(10);
  });

  it("puts the prompt on one line without control characters", () => {
    expect(normalizeScheduleText("line one\nline\ttwo\u0007  three ")).toBe(
      "line one line two three",
    );
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it("reads the UI's short form and absolute paths, rejects anything else", () => {
    expect(parseAssistantTurnCommand("uno-work assistant-turn --prompt 'Check mail'")).toEqual({
      workspaceRoot: null,
      name: null,
      prompt: "Check mail",
      timeoutSec: null,
    });
    expect(
      parseAssistantTurnCommand('/usr/local/bin/uno-work assistant-turn --prompt="Do it"')?.prompt,
    ).toBe("Do it");
    expect(parseAssistantTurnCommand("echo hi")).toBeNull();
    expect(parseAssistantTurnCommand("uno-work assistant-turn")).toBeNull();
    expect(parseAssistantTurnCommand("uno-work serve --prompt x")).toBeNull();
  });
});

describe("console answers", () => {
  it("keeps only this box's assistant turns for this workspace", () => {
    const own = buildAssistantTurnCommand({
      workspaceRoot: WORKSPACE,
      name: "digest",
      prompt: "collect mentions",
      timeoutSec: 900,
    });
    const schedules = selectAssistantSchedules(
      {
        tasks: [
          {
            id: 1,
            box_id: 7,
            name: "digest",
            cron_expr: "0 10 * * 1",
            command: own,
            state: "active",
          },
          { id: 2, box_id: 7, name: "backup", cron_expr: "0 3 * * *", command: "tar czf /b.tgz ~" },
          { id: 3, box_id: 8, name: "other box", cron_expr: "* * * * *", command: own },
          {
            id: 4,
            box_id: 7,
            name: "other assistant",
            cron_expr: "* * * * *",
            command: own.replace(WORKSPACE, "/home/unowork/UnoWork/Assistants/liza"),
          },
          {
            id: 5,
            box_id: 7,
            name: "from the UI",
            cron_expr: "0 9 * * *",
            timezone: "Europe/Berlin",
            command: "uno-work assistant-turn --prompt 'Morning brief'",
            next_run_at: "2026-10-03T07:00:00Z",
          },
        ],
      },
      { boxId: 7, workspaceRoot: WORKSPACE },
    );
    expect(schedules.map((schedule) => [schedule.scheduleId, schedule.prompt])).toEqual([
      [1, "collect mentions"],
      [5, "Morning brief"],
    ]);
    expect(schedules[1]?.timezone).toBe("Europe/Berlin");
  });

  it("explains a console that has no assistant schedules yet without suggesting cron", () => {
    const text = scheduleConsoleProblem({
      status: 403,
      body: { error: "WORK_MACHINE_ROUTE_RESTRICTED" },
    });
    expect(text).toContain("aren't switched on");
    expect(text).toContain("do NOT fall back to cron");
    expect(scheduleConsoleProblem({ status: 400, body: { error: "invalid cron" } })).toContain(
      "five fields",
    );
  });

  it("takes the assistant only from an assistant token label", () => {
    expect(assistantProjectOfCaller(caller("assistant:assistant-home"))).toBe("assistant-home");
    expect(assistantProjectOfCaller(caller("assistant:other"))).toBeNull();
    expect(assistantProjectOfCaller(caller("my laptop script"))).toBeNull();
    expect(assistantProjectOfCaller(caller())).toBeNull();
  });
});

describe("AssistantSchedules service (console mocked)", () => {
  const setup = (answer: (method: string, path: string, body: unknown) => Response) => {
    const calls: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const headers = new Headers(init?.headers);
      calls.push({ method: init?.method ?? "GET", path, auth: headers.get("authorization"), body });
      return answer(init?.method ?? "GET", path, body);
    };
    const layer = Layer.effect(AssistantSchedules, makeAssistantSchedules({ fetchImpl })).pipe(
      Layer.provide(
        ServerSettingsService.layerTest({ uno: { boxToken: "uno_agt_machine", boxId: 7 } }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: (projectId) =>
            Effect.succeed(
              projectId === ProjectId.make("assistant-home")
                ? Option.some({ workspaceRoot: WORKSPACE } as never)
                : Option.none(),
            ),
        }),
      ),
    );
    const run = <A, E>(effect: Effect.Effect<A, E, AssistantSchedules>) =>
      Effect.runPromise(Effect.result(effect.pipe(Effect.provide(layer))));
    return { calls, run };
  };

  it("creates on its own box with the machine token and the assistant-turn command", async () => {
    const { calls: allCalls, run } = setup((method, path, body) =>
      method === "GET" && path === "/api/v1/boxes/7"
        ? json(200, { id: 7, computer_role: "assistant" })
        : json(201, { id: 41, box_id: 7, ...(body as object), cron_expr: "0 10 * * 1" }),
    );
    const result = await run(
      withService((schedules) =>
        schedules.create(caller("assistant:assistant-home"), {
          name: "Monday digest",
          cron: "0 10 * * 1",
          prompt: "Collect Uno mentions in X; draft a post in Notion.",
          timezone: "Europe/Berlin",
          maxMinutes: 10,
        }),
      ),
    );
    expect(result._tag).toBe("Success");
    const calls = allCalls.filter((entry) => entry.path === "/api/v1/scheduled-tasks");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v1/scheduled-tasks");
    expect(call.auth).toBe("Bearer uno_agt_machine");
    const body = call.body as Record<string, unknown>;
    expect(body.box_id).toBe(7);
    expect(body.cron_expr).toBe("0 10 * * 1");
    expect(body.timezone).toBe("Europe/Berlin");
    expect(body.timeout_sec).toBe(600 + 120);
    // An assistant's own computer goes back to sleep after the run.
    expect(body.on_finish).toBe("hibernate");
    expect(parseAssistantTurnCommand(String(body.command))).toMatchObject({
      workspaceRoot: WORKSPACE,
      prompt: "Collect Uno mentions in X; draft a post in Notion.",
      timeoutSec: 600,
    });
    if (result._tag === "Success") expect(result.success.schedule?.scheduleId).toBe(41);
  });

  it("never puts the person's own computer to sleep after a run (assistant right here)", async () => {
    const { calls, run } = setup((method, path, body) =>
      method === "GET" && path === "/api/v1/boxes/7"
        ? json(200, { id: 7, computer_role: "workspace" })
        : json(201, { id: 42, box_id: 7, ...(body as object) }),
    );
    await run(
      withService((schedules) =>
        schedules.create(caller("assistant:assistant-home"), {
          name: "Morning",
          cron: "0 9 * * *",
          prompt: "Check the inbox.",
        }),
      ),
    );
    const created = calls.find((entry) => entry.path === "/api/v1/scheduled-tasks");
    expect((created?.body as Record<string, unknown>).on_finish).toBe("keep");
  });

  it("refuses to delete a task that is not one of this assistant's", async () => {
    const { calls, run } = setup((method) =>
      method === "GET"
        ? json(200, {
            tasks: [{ id: 9, box_id: 7, command: "tar czf /b.tgz ~", cron_expr: "0 3 * * *" }],
          })
        : json(200, { status: "deleted" }),
    );
    const result = await run(
      withService((schedules) =>
        schedules.remove(caller("assistant:assistant-home"), { scheduleId: 9 }),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("deletes its own schedule", async () => {
    const own = buildAssistantTurnCommand({
      workspaceRoot: WORKSPACE,
      name: "x",
      prompt: "y",
      timeoutSec: 60,
    });
    const { calls, run } = setup((method) =>
      method === "GET"
        ? json(200, { tasks: [{ id: 12, box_id: 7, command: own, cron_expr: "0 3 * * *" }] })
        : json(200, { status: "deleted" }),
    );
    const result = await run(
      withService((schedules) =>
        schedules.remove(caller("assistant:assistant-home"), { scheduleId: 12 }),
      ),
    );
    expect(result).toMatchObject({ _tag: "Success", success: { deleted: true } });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/v1/scheduled-tasks/12" });
  });

  it("lets the person list, pause, resume and remove the assistant's schedules", async () => {
    const own = buildAssistantTurnCommand({
      workspaceRoot: WORKSPACE,
      name: "Morning plan",
      prompt: "Send me a short plan for today.",
      timeoutSec: 600,
    });
    const { calls, run } = setup((method) =>
      method === "GET"
        ? json(200, {
            tasks: [
              { id: 15, box_id: 7, command: own, cron_expr: "0 9 * * *", name: "Morning plan" },
              { id: 16, box_id: 7, command: "pg_dump x", cron_expr: "0 3 * * *" },
            ],
          })
        : json(200, { id: 15, state: "paused" }),
    );
    const home = ProjectId.make("assistant-home");
    const listed = await run(withService((schedules) => schedules.ownerList(home)));
    expect(listed).toMatchObject({
      _tag: "Success",
      success: { schedules: [{ scheduleId: 15, name: "Morning plan", cron: "0 9 * * *" }] },
    });
    for (const action of ["pause", "resume"] as const) {
      const done = await run(withService((schedules) => schedules.ownerAct(home, 15, action)));
      expect(done).toMatchObject({ _tag: "Success", success: { done: true } });
      expect(calls.at(-1)).toMatchObject({
        method: "PATCH",
        path: `/api/v1/scheduled-tasks/15/${action}`,
        auth: "Bearer uno_agt_machine",
      });
    }
    await run(withService((schedules) => schedules.ownerAct(home, 15, "remove")));
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/v1/scheduled-tasks/15" });
    // Not the assistant's (a plain console job): refused before any change.
    const before = calls.length;
    const refused = await run(withService((schedules) => schedules.ownerAct(home, 16, "remove")));
    expect(refused._tag).toBe("Failure");
    expect(calls.slice(before).map((call) => call.method)).toEqual(["GET"]);
  });

  it("turns a console without the feature into a readable tool error", async () => {
    const { run } = setup(() => json(403, { error: "WORK_MACHINE_ROUTE_RESTRICTED" }));
    const result = await run(
      withService((schedules) => schedules.list(caller("assistant:assistant-home"))),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toContain("cron");
  });

  it("is not for tokens that are not an assistant's", async () => {
    const { calls, run } = setup(() => json(200, { tasks: [] }));
    const result = await run(withService((schedules) => schedules.list(caller("ci"))));
    expect(result._tag).toBe("Failure");
    expect(calls).toHaveLength(0);
  });
});

describe("uno-manager MCP schedule tools", () => {
  const tools = {} as ManagerToolServiceShape;

  it("are listed and say so plainly when schedules are not wired", async () => {
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
      expect.arrayContaining(["schedule_create", "schedule_list", "schedule_delete"]),
    );

    const called = await Effect.runPromise(
      handleManagerMcpMessage(tools, caller("assistant:assistant-home"), {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "schedule_list", arguments: {} },
      }),
    );
    expect(JSON.stringify(called)).toContain("do NOT fall back to cron");
  });

  it("route a call to the schedules service with the caller", async () => {
    const seen: Array<ManagerCaller> = [];
    const called = await Effect.runPromise(
      handleManagerMcpMessage(
        tools,
        caller("assistant:assistant-home"),
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "schedule_list", arguments: {} },
        },
        {
          schedules: {
            create: () => Effect.die("unused"),
            remove: () => Effect.die("unused"),
            ownerList: () => Effect.die("unused"),
            ownerAct: () => Effect.die("unused"),
            list: (who) =>
              Effect.sync(() => {
                seen.push(who);
                return { schedules: [] };
              }),
          },
        },
      ),
    );
    expect(seen[0]?.label).toBe("assistant:assistant-home");
    expect(JSON.stringify(called)).toContain("schedules");
  });
});
