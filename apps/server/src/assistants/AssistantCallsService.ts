/**
 * AssistantCallsService — "Join my calls" on this computer: the switch, the
 * one-click setup (Google Calendar → the Notetaker app → on), the App API
 * the notetaker talks to, and what its events do (Inbox, the assistant's
 * turn after a call, the answer in Telegram through the scheduled-turn path).
 *
 * Pure rules: `assistantCalls.ts`. Contract with the notetaker:
 * reports/day_2026-10-28/assistants-d-impl/CONTRACTS.md (W ↔ N).
 *
 * @module assistants/AssistantCallsService
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ProjectId } from "@t3tools/contracts";
import { Context, Effect, Layer, Option } from "effect";

import { setAppCallsCore } from "../appSdk/appCallsBridge.ts";
import type { AppApiCaller, AppCallsReply } from "../appSdk/appApiHttp.ts";
import { ServerConfig } from "../config.ts";
import { InboxService } from "../inbox/InboxService.ts";
import { resolveManifestDir } from "../machineApps/manifestDir.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ConnectorsService, ConnectorsServiceLive } from "../setupTools/ConnectorsService.ts";
import { parseSettingsBoxId } from "../unoBoxIdentity.ts";
import { UnoComputerService } from "../workspaceRegistry/UnoComputerService.ts";
import {
  applyCallsEvent,
  callsBusy,
  CALLS_SOURCE,
  CALLS_THREAD_TITLE,
  callsWakeAt,
  disableCalls,
  emptyCallsState,
  enableCalls,
  lastProblem,
  linkBody,
  nextCall,
  NOTETAKER_TEMPLATE_ID,
  parseCalendarFeed,
  parseCallsEvent,
  parseCallsState,
  setCallChoice,
  type AssistantCallsState,
  type CallsChoiceValue,
  type CallsEffects,
  type CallsNotesSummary,
  type CallStatus,
  type CallView,
} from "./assistantCalls.ts";
import { setCallsWake } from "./callsWake.ts";
import { AssistantScheduledTurns } from "./scheduledTurn.ts";

export type NotetakerState = "running" | "installing" | "failed" | "missing" | "unknown";

export interface AssistantCallsView {
  readonly enabled: boolean;
  readonly projectId: string | null;
  readonly assistantName: string;
  readonly botName: string;
  /** This computer is a cloud computer (the notetaker runs only there). */
  readonly cloud: boolean;
  readonly google: {
    readonly connected: boolean;
    readonly needsReconnect: boolean;
    readonly account: string | null;
  } | null;
  readonly notetaker: { readonly state: NotetakerState; readonly deploymentId: number | null };
  readonly next: CallView | null;
  readonly upcoming: ReadonlyArray<CallView>;
  readonly upcomingAt: number | null;
  readonly problem: CallStatus | null;
  readonly recent: ReadonlyArray<CallStatus>;
  readonly notes: ReadonlyArray<CallsNotesSummary>;
}

export type EnableCallsResult =
  | { readonly ok: true; readonly view: AssistantCallsView }
  | {
      readonly ok: false;
      /** google: connect / reconnect Google Calendar first; computer: not here; memory: confirm a small computer. */
      readonly needs: "google" | "computer" | "memory" | "assistant";
      readonly message: string;
      readonly view: AssistantCallsView;
    };

export interface AssistantCallsServiceShape {
  readonly view: Effect.Effect<AssistantCallsView>;
  readonly enable: (input: {
    readonly projectId: string;
    readonly allowLowMemory?: boolean;
  }) => Effect.Effect<EnableCallsResult>;
  readonly disable: Effect.Effect<AssistantCallsView>;
  readonly setChoice: (input: {
    readonly key: string;
    readonly choice: CallsChoiceValue;
  }) => Effect.Effect<AssistantCallsView>;
}

export class AssistantCallsService extends Context.Service<
  AssistantCallsService,
  AssistantCallsServiceShape
>()("t3/assistants/AssistantCallsService") {}

const reply = (status: number, body: unknown): AppCallsReply => ({ status, body });
const appErr = (status: number, code: string, message: string) =>
  reply(status, { error: { type: code, code, message } });

export const makeAssistantCallsService = (options?: {
  readonly statePath?: string;
  readonly manifestDir?: string;
  readonly now?: () => number;
}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const connectors = yield* ConnectorsService;
    const projections = yield* ProjectionSnapshotQuery;
    const inbox = yield* Effect.serviceOption(InboxService);
    const computer = yield* Effect.serviceOption(UnoComputerService);
    const turns = yield* Effect.serviceOption(AssistantScheduledTurns);
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
    const runFork = Effect.runForkWith(context);

    const statePath = options?.statePath ?? path.join(config.stateDir, "assistant-calls.json");
    const manifestDir = options?.manifestDir ?? resolveManifestDir();
    const nowSec = () => Math.floor((options?.now?.() ?? Date.now()) / 1000);

    let state: AssistantCallsState = yield* Effect.promise(async () => {
      try {
        return parseCallsState(JSON.parse(await fs.readFile(statePath, "utf8")));
      } catch {
        return emptyCallsState();
      }
    });
    // One writer at a time: events and clicks may land together.
    let queue: Promise<unknown> = Promise.resolve();
    const serialize = <A>(run: () => Promise<A>): Promise<A> => {
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    };
    const save = async (next: AssistantCallsState) => {
      state = next;
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
      await fs.rename(tmp, statePath);
    };

    const boxId = async () => {
      const current = await runPromise(settings.getSettings.pipe(Effect.orElseSucceed(() => null)));
      return parseSettingsBoxId(current?.uno.boxId);
    };

    const google = async (force = false) => {
      const list = await runPromise(
        connectors.list({ force }).pipe(Effect.orElseSucceed(() => null)),
      );
      const gmail = list?.connectors.find((c) => c.provider === "gmail");
      return gmail
        ? {
            connected: gmail.connected,
            needsReconnect: gmail.needsReconnect,
            account: gmail.account,
          }
        : null;
    };

    const notetaker = async (): Promise<AssistantCallsView["notetaker"]> => {
      if (Option.isSome(computer)) {
        const apps = await runPromise(computer.value.apps().pipe(Effect.orElseSucceed(() => null)));
        const app = apps?.installed.apps.find((a) => a.templateId === NOTETAKER_TEMPLATE_ID);
        if (app) return { state: app.state, deploymentId: app.deploymentId };
        if (apps?.installed.availability === "ok") return { state: "missing", deploymentId: null };
      }
      try {
        await fs.access(path.join(manifestDir, `${NOTETAKER_TEMPLATE_ID}.json`));
        return { state: "running", deploymentId: null };
      } catch {
        return { state: Option.isSome(computer) ? "unknown" : "missing", deploymentId: null };
      }
    };

    const buildView = async (force = false): Promise<AssistantCallsView> => {
      const [g, nt, box] = await Promise.all([google(force), notetaker(), boxId()]);
      const now = nowSec();
      return {
        enabled: state.enabled,
        projectId: state.projectId,
        assistantName: state.assistantName,
        botName: state.botName,
        cloud: box !== null,
        google: g,
        notetaker: nt,
        next: state.enabled ? nextCall(state, now * 1000) : null,
        upcoming: state.enabled ? state.upcoming : [],
        upcomingAt: state.upcomingAt,
        problem: state.enabled ? lastProblem(state, now) : null,
        recent: state.statuses.toSorted((a, b) => b.at - a.at).slice(0, 5),
        notes: state.notes.toSorted((a, b) => b.at - a.at).slice(0, 5),
      };
    };

    const assistantTitle = async (projectId: string) => {
      const snapshot = await runPromise(
        projections.getShellSnapshot().pipe(Effect.orElseSucceed(() => null)),
      );
      const project = snapshot?.projects.find((p) => p.id === projectId);
      return project ? project.title : null;
    };

    const enable: AssistantCallsServiceShape["enable"] = (input) =>
      Effect.promise(() =>
        serialize(async (): Promise<EnableCallsResult> => {
          const fail = async (
            needs: "google" | "computer" | "memory" | "assistant",
            message: string,
          ): Promise<EnableCallsResult> => ({ ok: false, needs, message, view: await buildView() });
          const title = await assistantTitle(input.projectId);
          if (title === null) return fail("assistant", "This assistant isn't on this computer.");
          if ((await boxId()) === null) {
            return fail(
              "computer",
              "The notetaker runs on a cloud computer. Move this assistant to a cloud computer with 4 GB or more, then turn this on there.",
            );
          }
          const g = await google(true);
          if (!g || !g.connected || g.needsReconnect) {
            return fail(
              "google",
              g?.needsReconnect
                ? "Google Calendar needs signing in again."
                : "Connect Google Calendar so your assistant sees your meetings.",
            );
          }
          const nt = await notetaker();
          if ((nt.state === "missing" || nt.state === "failed") && Option.isSome(computer)) {
            const installed = await runPromise(
              computer.value
                .installApp({
                  templateId: NOTETAKER_TEMPLATE_ID,
                  ...(input.allowLowMemory ? { allowLowMemory: true } : {}),
                })
                .pipe(
                  Effect.map((result) => ({ ok: true as const, result })),
                  Effect.catch((error) =>
                    Effect.succeed({
                      ok: false as const,
                      message: error instanceof Error ? error.message : String(error),
                    }),
                  ),
                ),
            );
            if (!installed.ok) return fail("computer", installed.message);
            if (installed.result.confirm) {
              return fail(
                "memory",
                "The notetaker needs 4 GB of memory; this computer has less. Calls may be cut. Give the computer more memory, or turn it on anyway.",
              );
            }
          }
          await save(
            enableCalls(state, { projectId: input.projectId, assistantName: title, now: nowSec() }),
          );
          return { ok: true, view: await buildView() };
        }),
      );

    const disable: AssistantCallsServiceShape["disable"] = Effect.promise(() =>
      serialize(async () => {
        await save(disableCalls(state));
        return buildView();
      }),
    );

    const setChoice: AssistantCallsServiceShape["setChoice"] = (input) =>
      Effect.promise(() =>
        serialize(async () => {
          await save(setCallChoice(state, input.key, input.choice, nowSec()));
          return buildView();
        }),
      );

    // ---- what an event does ----

    const runEffects = (effects: CallsEffects, extra: { readonly meetingId: string }) => {
      const name = state.assistantName || "Notetaker";
      if (effects.inbox && Option.isSome(inbox)) {
        runFork(
          inbox.value
            .post({
              kind: "app",
              source: { kind: "app", id: NOTETAKER_TEMPLATE_ID, name, icon: "🎙️" },
              title: effects.inbox.title,
              body: effects.inbox.body,
              open: {
                kind: "app",
                appId: NOTETAKER_TEMPLATE_ID,
                path: extra.meetingId ? `/m/${extra.meetingId}` : "/#/calls",
              },
              groupKey: effects.inbox.groupKey,
            })
            .pipe(Effect.ignoreCause({ log: true })),
        );
      }
      if (effects.turn && Option.isSome(turns) && state.projectId) {
        runFork(
          turns.value
            .runEvent({
              projectId: state.projectId as ProjectId,
              prompt: effects.turn.prompt,
              header: effects.turn.header,
              threadTitle: CALLS_THREAD_TITLE,
              source: CALLS_SOURCE,
              timeoutSec: 20 * 60,
            })
            .pipe(
              Effect.tap((result) =>
                Effect.logInfo("assistant calls: notes turn").pipe(
                  Effect.annotateLogs({ status: result.status, delivered: result.delivered }),
                ),
              ),
              Effect.ignoreCause({ log: true }),
            ),
        );
      }
    };

    const onlyNotetaker = (caller: AppApiCaller) =>
      caller.appId === NOTETAKER_TEMPLATE_ID
        ? null
        : appErr(403, "calls_not_allowed", "Join my calls is for the Uno Notetaker app.");

    // Economy mode sleeps an idle computer: wake it before a call, hold it during one.
    setCallsWake({
      wakeAt: (nowMs) => callsWakeAt(state, nowMs),
      busy: (nowMs) => callsBusy(state, nowMs),
    });

    setAppCallsCore({
      link: async (caller) => {
        const denied = onlyNotetaker(caller);
        if (denied) return denied;
        if (!state.enabled) {
          return appErr(409, "calls_off", "No assistant has Join my calls on on this computer.");
        }
        const g = await google();
        return reply(200, linkBody(state, { name: "", email: g?.account?.toLowerCase() ?? "" }));
      },
      calendar: async (caller, range) => {
        const denied = onlyNotetaker(caller);
        if (denied) return denied;
        if (!state.enabled) {
          return appErr(409, "calls_off", "No assistant has Join my calls on on this computer.");
        }
        const args: Record<string, unknown> = {};
        if (range.from) args["from"] = range.from;
        if (range.to) args["to"] = range.to;
        const result = await runPromise(
          connectors.call({ provider: "gmail", tool: "calendar_feed", arguments: args }).pipe(
            Effect.map((r) => ({ ok: true as const, r })),
            Effect.catch((error) =>
              Effect.succeed({ ok: false as const, status: error.status, message: error.message }),
            ),
          ),
        );
        if (!result.ok) {
          return result.status === 401 || result.status === 403 || result.status === 404
            ? appErr(424, "google_reconnect", "Google Calendar needs signing in again in Uno Work.")
            : appErr(502, "calendar_unavailable", result.message);
        }
        const parsed = parseCalendarFeed(result.r);
        if (!parsed.ok) {
          if (/not connected/i.test(parsed.message)) {
            return appErr(
              424,
              "google_not_connected",
              "Google Calendar isn't connected in Uno Work.",
            );
          }
          if (/expired|revoked|reconnect/i.test(parsed.message)) {
            return appErr(
              424,
              "google_reconnect",
              "Google Calendar needs signing in again in Uno Work.",
            );
          }
          return appErr(502, "calendar_unavailable", parsed.message);
        }
        return reply(200, parsed.feed);
      },
      event: (caller, body) =>
        serialize(async () => {
          const denied = onlyNotetaker(caller);
          if (denied) return denied;
          const parsed = parseCallsEvent(body);
          if (!parsed.ok) return appErr(400, "invalid_request", parsed.message);
          // Notes of a call the bot was sent to still arrive after the switch went off.
          if (!state.enabled && (parsed.event.kind === "calls.upcoming" || !state.projectId)) {
            return appErr(409, "calls_off", "No assistant has Join my calls on on this computer.");
          }
          const applied = applyCallsEvent(state, parsed.event, nowSec());
          if (applied.duplicate) return reply(200, { ok: true, duplicate: true });
          await save(applied.state);
          runEffects(applied.effects, {
            meetingId:
              parsed.event.kind === "meeting.notes" || parsed.event.kind === "meeting.error"
                ? parsed.event.meetingId
                : parsed.event.kind === "call.status"
                  ? parsed.event.meetingId
                  : "",
          });
          return reply(202, { ok: true });
        }),
    });

    return {
      view: Effect.promise(() => buildView(true)),
      enable,
      disable,
      setChoice,
    } satisfies AssistantCallsServiceShape;
  });

/** Its own connectors client (the one in the server's merge is a sibling, not visible here). */
export const AssistantCallsServiceLive = Layer.effect(
  AssistantCallsService,
  makeAssistantCallsService(),
).pipe(Layer.provide(ConnectorsServiceLive));
