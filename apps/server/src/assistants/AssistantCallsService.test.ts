import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import type { AppApiCaller } from "../appSdk/appApiHttp.ts";
import { appCallsBridge, setAppCallsCore } from "../appSdk/appCallsBridge.ts";
import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { InboxService } from "../inbox/InboxService.ts";
import type { InboxPost } from "../inbox/inboxModel.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ConnectorsService } from "../setupTools/ConnectorsService.ts";
import { ConnectorsError } from "../setupTools/connectors.ts";
import { UnoComputerService } from "../workspaceRegistry/UnoComputerService.ts";
import { AssistantCallsService, makeAssistantCallsService } from "./AssistantCallsService.ts";
import { AssistantScheduledTurns, type AssistantEventTurnInput } from "./scheduledTurn.ts";

const NOTETAKER: AppApiCaller = {
  appId: "notetaker",
  appName: "Notetaker",
  chat: true,
  tasks: true,
  limitUsd: 10,
  spentUsd: 0,
  tasksSpentUsd: 0,
  manifestCwd: null,
  taskToolsCap: "ask",
  storage: null,
  calls: true,
};

interface World {
  google: { connected: boolean; needsReconnect: boolean } | null;
  installed: "running" | null;
  installs: Array<{ templateId: string; allowLowMemory?: boolean }>;
  lowMemory: boolean;
  calls: Array<{ tool: string; arguments: Record<string, unknown> }>;
  feed: string;
  inbox: InboxPost[];
  turns: AssistantEventTurnInput[];
  boxId: number | null;
}

const world = (): World => ({
  google: { connected: true, needsReconnect: false },
  installed: null,
  installs: [],
  lowMemory: false,
  calls: [],
  feed: '{"account":"misha@x.com","events":[]}',
  inbox: [],
  turns: [],
  boxId: 2531,
});

function layer(w: World, dir = mkdtempSync(join(tmpdir(), "assistant-calls-"))) {
  return Layer.effect(
    AssistantCallsService,
    makeAssistantCallsService({
      statePath: join(dir, "assistant-calls.json"),
      manifestDir: join(dir, "apps"),
      now: () => Date.parse("2026-10-28T12:00:00Z"),
    }),
  ).pipe(
    Layer.provide(Layer.succeed(ServerConfig, { stateDir: dir } as ServerConfigShape)),
    Layer.provide(ServerSettingsService.layerTest({ uno: { boxId: w.boxId } })),
    Layer.provide(
      Layer.mock(ConnectorsService)({
        list: () =>
          Effect.succeed({
            available: true,
            reason: null,
            connectors: w.google
              ? [
                  {
                    provider: "gmail",
                    name: "Gmail & Calendar",
                    description: "",
                    available: true,
                    connected: w.google.connected,
                    needsReconnect: w.google.needsReconnect,
                    account: "Misha@x.com",
                    connectedAt: null,
                    toolCount: 4,
                  },
                ]
              : [],
          }),
        call: (input) => {
          w.calls.push({ tool: input.tool, arguments: input.arguments });
          return w.feed === "401"
            ? Effect.fail(new ConnectorsError(401, "unauthorized", "no"))
            : Effect.succeed({ content: [{ type: "text", text: w.feed }], isError: false });
        },
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            threads: [],
            projects: [{ id: ProjectId.make("assistant-ada"), title: "Ada" }],
          } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(UnoComputerService)({
        apps: () =>
          Effect.succeed({
            catalog: { availability: "ok", message: null, templates: [] },
            installed: {
              availability: "ok",
              message: null,
              apps: w.installed
                ? [
                    {
                      key: "service:notetaker",
                      name: "Notetaker",
                      templateId: "notetaker",
                      icon: null,
                      state: w.installed,
                      url: null,
                      deploymentId: 77,
                    },
                  ]
                : [],
            },
          } as never),
        installApp: (input) => {
          w.installs.push({
            templateId: input.templateId,
            ...(input.allowLowMemory ? { allowLowMemory: true } : {}),
          });
          if (w.lowMemory && !input.allowLowMemory) {
            return Effect.succeed({
              deploymentId: null,
              confirm: { kind: "low_memory", message: "small" },
            } as never);
          }
          w.installed = "running";
          return Effect.succeed({ deploymentId: 78, confirm: null } as never);
        },
      }),
    ),
    Layer.provide(
      Layer.mock(InboxService)({
        post: (post) => {
          w.inbox.push(post);
          return Effect.succeed({} as never);
        },
      }),
    ),
    Layer.provide(
      Layer.mock(AssistantScheduledTurns)({
        runEvent: (input) => {
          w.turns.push(input);
          return Effect.succeed({ status: "delivered", threadId: "t", delivered: 1 } as never);
        },
      }),
    ),
  );
}

const run = <A>(w: World, body: Effect.Effect<A, never, AssistantCallsService>, dir?: string) =>
  Effect.runPromise(
    body.pipe(
      Effect.ensuring(Effect.sync(() => setAppCallsCore(null))),
      Effect.provide(layer(w, dir)),
    ),
  );

const withCalls = <A>(
  use: (calls: typeof AssistantCallsService.Service) => Effect.Effect<A>,
): Effect.Effect<A, never, AssistantCallsService> =>
  Effect.gen(function* () {
    return yield* use(yield* AssistantCallsService);
  });

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("AssistantCallsService", () => {
  it("one click: Google is connected → the notetaker is installed → on", async () => {
    const w = world();
    const result = await run(
      w,
      Effect.gen(function* () {
        const calls = yield* AssistantCallsService;
        return yield* calls.enable({ projectId: "assistant-ada" });
      }),
    );
    expect(result.ok).toBe(true);
    expect(w.installs).toEqual([{ templateId: "notetaker" }]);
    expect(result.view).toMatchObject({
      enabled: true,
      assistantName: "Ada",
      botName: "Ada (Uno notes)",
      cloud: true,
      notetaker: { state: "running" },
    });
  });

  it("asks for Google first, and for a cloud computer", async () => {
    const w = world();
    w.google = { connected: true, needsReconnect: true };
    const reconnect = await run(
      w,
      withCalls((calls) => calls.enable({ projectId: "assistant-ada" })),
    );
    expect(reconnect).toMatchObject({
      ok: false,
      needs: "google",
      message: "Google Calendar needs signing in again.",
    });
    expect(w.installs).toEqual([]);

    const mac = world();
    mac.boxId = null;
    const onMac = await run(
      mac,
      withCalls((calls) => calls.enable({ projectId: "assistant-ada" })),
    );
    expect(onMac).toMatchObject({ ok: false, needs: "computer" });

    const small = world();
    small.lowMemory = true;
    const confirm = await run(
      small,
      withCalls((calls) => calls.enable({ projectId: "assistant-ada" })),
    );
    expect(confirm).toMatchObject({ ok: false, needs: "memory", view: { enabled: false } });
    const anyway = await run(
      small,
      withCalls((calls) => calls.enable({ projectId: "assistant-ada", allowLowMemory: true })),
    );
    expect(anyway.ok).toBe(true);
  });

  it("the notetaker's side: link, calendar, events → Inbox and the assistant's turn", async () => {
    const w = world();
    w.installed = "running";
    await run(
      w,
      Effect.gen(function* () {
        const calls = yield* AssistantCallsService;
        // Off: the notetaker is told so.
        const off = yield* Effect.promise(() => appCallsBridge.link(NOTETAKER));
        expect(off.status).toBe(409);
        yield* calls.enable({ projectId: "assistant-ada" });

        const other = yield* Effect.promise(() =>
          appCallsBridge.link({ ...NOTETAKER, appId: "spy" }),
        );
        expect(other.status).toBe(403);
        const link = yield* Effect.promise(() => appCallsBridge.link(NOTETAKER));
        expect(link).toMatchObject({
          status: 200,
          body: {
            enabled: true,
            botName: "Ada (Uno notes)",
            owner: { email: "misha@x.com" },
            rule: "mine",
          },
        });

        const cal = yield* Effect.promise(() =>
          appCallsBridge.calendar(NOTETAKER, { from: "2026-10-28T00:00:00Z", to: null }),
        );
        expect(cal).toEqual({ status: 200, body: { account: "misha@x.com", events: [] } });
        expect(w.calls).toEqual([
          { tool: "calendar_feed", arguments: { from: "2026-10-28T00:00:00Z" } },
        ]);
        w.feed = "401";
        const expired = yield* Effect.promise(() =>
          appCallsBridge.calendar(NOTETAKER, { from: null, to: null }),
        );
        expect(expired.status).toBe(424);

        const upcoming = yield* Effect.promise(() =>
          appCallsBridge.event(NOTETAKER, {
            id: "up-1",
            kind: "calls.upcoming",
            calls: [
              {
                key: "a1b2c3d4e5f6",
                title: "Pilot sync",
                start: "2026-10-28T14:00:00Z",
                end: "2026-10-28T14:30:00Z",
                join: true,
              },
            ],
          }),
        );
        expect(upcoming.status).toBe(202);
        const view = yield* calls.view;
        expect(view.next?.title).toBe("Pilot sync");
        // The person turns this one off in Work; the link carries it to the notetaker.
        yield* calls.setChoice({ key: "a1b2c3d4e5f6", choice: "skip" });
        const link2 = yield* Effect.promise(() => appCallsBridge.link(NOTETAKER));
        expect((link2.body as { choices: object }).choices).toEqual({
          a1b2c3d4e5f6: { choice: "skip", at: 1793188800 },
        });

        yield* Effect.promise(() =>
          appCallsBridge.event(NOTETAKER, {
            id: "st-s1-not_admitted",
            kind: "call.status",
            session: "s1",
            title: "Pilot sync",
            status: "not_admitted",
            reason: "waiting_room",
            text: "Couldn't join Pilot sync: waiting room — nobody let Ada (Uno notes) in",
          }),
        );
        const notes = {
          id: "notes-m1",
          kind: "meeting.notes",
          meeting_id: "m1",
          title: "Pilot sync",
          summary: ["Pilot starts in November"],
          action_items: [{ owner: "Oleg", text: "send the contract" }],
        };
        expect((yield* Effect.promise(() => appCallsBridge.event(NOTETAKER, notes))).status).toBe(
          202,
        );
        const again = yield* Effect.promise(() => appCallsBridge.event(NOTETAKER, notes));
        expect(again).toEqual({ status: 200, body: { ok: true, duplicate: true } });
        yield* Effect.promise(flush);
      }),
    );
    expect(w.inbox.map((p) => [p.title, p.open, p.source.name])).toEqual([
      [
        "Couldn't join Pilot sync: waiting room — nobody let Ada (Uno notes) in",
        { kind: "app", appId: "notetaker", path: "/#/calls" },
        "Ada",
      ],
      ["Notes: Pilot sync", { kind: "app", appId: "notetaker", path: "/m/m1" }, "Ada"],
    ]);
    expect(w.turns).toHaveLength(1);
    expect(w.turns[0]).toMatchObject({
      projectId: "assistant-ada",
      threadTitle: "Meetings",
      source: "notetaker",
      header: "📝 Pilot sync\n\n",
    });
    expect(w.turns[0]?.prompt).toContain("- [ ] Oleg: send the contract");
  });

  it("notes of a call still reach the assistant after the switch went off", async () => {
    const w = world();
    w.installed = "running";
    await run(
      w,
      Effect.gen(function* () {
        const calls = yield* AssistantCallsService;
        yield* calls.enable({ projectId: "assistant-ada" });
        yield* calls.disable;
        const up = yield* Effect.promise(() =>
          appCallsBridge.event(NOTETAKER, { id: "u", kind: "calls.upcoming", calls: [] }),
        );
        expect(up.status).toBe(409);
        const notes = yield* Effect.promise(() =>
          appCallsBridge.event(NOTETAKER, {
            id: "n",
            kind: "meeting.notes",
            meeting_id: "m2",
            title: "Late",
          }),
        );
        expect(notes.status).toBe(202);
        yield* Effect.promise(flush);
      }),
    );
    expect(w.turns.map((t) => t.header)).toEqual(["📝 Late\n\n"]);
  });

  it("keeps its state across restarts of the daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assistant-calls-keep-"));
    await mkdir(join(dir, "apps"), { recursive: true });
    await writeFile(
      join(dir, "assistant-calls.json"),
      JSON.stringify({
        enabled: true,
        projectId: "assistant-ada",
        assistantName: "Ada",
        botName: "Ada (Uno notes)",
      }),
    );
    const w = world();
    const view = await run(
      w,
      withCalls((calls) => calls.view),
      dir,
    );
    expect(view).toMatchObject({ enabled: true, botName: "Ada (Uno notes)" });
  });
});
