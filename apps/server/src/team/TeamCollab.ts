/**
 * T51 "Team in a project" on this computer (PLAN.md in
 * reports/day_2026-11-20/team-collab): the daemon's part, one service.
 *
 * - shareMirror.ts — the chats the person shared go to the Uno cloud;
 * - inbound.ts — a colleague's message comes into a shared chat as outside
 *   text;
 * - bridge.ts — colleagues' requests: a session here (the T50 host with
 *   `team`), a question answered by a chat that only reads, and how this
 *   person's own requests went, told to the chat that asked; the Telegram
 *   copies and the daily digest;
 * - `team.*` RPC for the interface (wsHandlers.ts) and the agents' tools
 *   (teamTools.ts) on top.
 *
 * Idle when nothing is on (`GET collab`, cached; the server's "off" codes;
 * or WORK_TEAM_COLLAB_DISABLED / WORK_TEAM_DISABLED set here): one look at
 * the cloud every 5 minutes, nothing else.
 *
 * Everything goes with this computer's key (`consoleToken`); the person's
 * own decisions are the interface's, with their sign-in.
 *
 * @module team/TeamCollab
 */
import * as crypto from "node:crypto";
import * as os from "node:os";

import {
  CommandId,
  MessageId,
  ProjectId,
  TeamError,
  ThreadId,
  type ChatRequestRemoteDecision,
  type OrchestrationEvent,
  type TeamErrorPart,
  type TeamLastError,
  type TeamLetAgentAnswerResult,
  type TeamState,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option, Stream } from "effect";

import { OutsideThreads } from "../automations/outsideThreads.ts";
import { ChatRequests } from "../chatRequests/ChatRequests.ts";
import { teamActiveCount, TEAM_SESSIONS_AT_ONCE } from "../chatRequests/hostLogic.ts";
import { chatRequestButtons, setTeamRequestDecider } from "../chatRequests/messenger.ts";
import { remotePaths } from "../chatRequests/outgoing.ts";
import { readHostStore } from "../chatRequests/spool.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { pickPersonChats } from "../manager/connectorNotify.ts";
import { ConnectorNotifyService } from "../manager/Services/ConnectorNotify.ts";
import { MyComputerService } from "../myComputer/MyComputerService.ts";
import { MyComputerFailure } from "../myComputer/myComputerCore.ts";
import { systemCommandOrigin } from "../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSyncService } from "../projectSync/ProjectSyncService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ASSISTANT_COMPUTER_ROLE, makeOwnComputerRoleReader } from "../assistants/computerRole.ts";
import { consoleToken } from "../unoWork/consoleClient.ts";
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";
import { makeTeamBridge, type TeamBridge } from "./bridge.ts";
import { makeInbound } from "./inbound.ts";
import type { LocalThreadDetail, TeamPorts } from "./ports.ts";
import { makeShareMirror } from "./shareMirror.ts";
import {
  backoffMs,
  countTool,
  NO_TOOLS,
  threadStatusOf,
  type ToolCounts,
} from "./shareMirror.logic.ts";
import { makePartsCache, makeTeamCloud, type PartsCache, type TeamCloud } from "./teamCloud.ts";
import { NO_PARTS, type TeamProject } from "./teamCloud.logic.ts";
import { makeFolderSecrets, projectsHere, type TeamProjectHere } from "./teamProjects.ts";

const COMPONENT = "team";
const REFRESH_EVERY_MS = 30_000;
const FLUSH_EVERY_MS = 500;
const FOLLOW_EVERY_MS = 5_000;
const PROJECTS_TTL_MS = 60_000;
const ERRORS_KEPT = 10;

export interface TeamCollabShape {
  readonly state: Effect.Effect<TeamState, TeamError>;
  /** The interface shared a chat (or stopped): look again now. */
  readonly refresh: Effect.Effect<TeamState, TeamError>;
  readonly letAgentAnswer: (
    requestId: number,
  ) => Effect.Effect<TeamLetAgentAnswerResult, TeamError>;
  /** For the agents' tools (teamTools.ts). */
  readonly cloud: TeamCloud;
  readonly parts: PartsCache;
  readonly source: Effect.Effect<string>;
  readonly teamProjects: Effect.Effect<ReadonlyArray<TeamProject>, TeamError>;
  /** The team project of a folder here, if it is one. */
  readonly projectOfFolder: (folder: string) => Effect.Effect<TeamProjectHere | null>;
  /**
   * This is the person's Uno assistant computer (`computer_role`). Misha
   * 23.11: its chats may write to colleagues; the cloud marks those requests
   * "from the assistant" and never lets them start anything on their own.
   * Unknown reads as false.
   */
  readonly onAssistantComputer: Effect.Effect<boolean>;
}

export class TeamCollab extends Context.Service<TeamCollab, TeamCollabShape>()(
  "t3/team/TeamCollab",
) {}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const teamError = (cause: unknown) =>
  new TeamError({ message: errorText(cause).trim() || "Something went wrong with the team." });

/** WORK_TEAM_COLLAB_DISABLED / WORK_TEAM_DISABLED set on this computer: all off here. */
export function disabledHere(env: NodeJS.ProcessEnv = process.env): boolean {
  const on = (value: string | undefined) =>
    value !== undefined &&
    value.trim() !== "" &&
    !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
  return on(env["WORK_TEAM_COLLAB_DISABLED"]) || on(env["WORK_TEAM_DISABLED"]);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const TeamCollabLive = Layer.effect(
  TeamCollab,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const environment = yield* ServerEnvironment;
    const chatRequests = yield* ChatRequests;
    const projectSync = yield* ProjectSyncService;
    const outside = Option.getOrNull(yield* Effect.serviceOption(OutsideThreads));
    const notify = Option.getOrNull(yield* Effect.serviceOption(ConnectorNotifyService));
    const myComputer = Option.getOrNull(yield* Effect.serviceOption(MyComputerService));
    const run = Effect.runPromise;

    const cloud = makeTeamCloud({
      baseUrl: controlPlaneBaseUrl,
      token: () =>
        run(
          settings.getSettings.pipe(
            Effect.map((value) => consoleToken(value)),
            Effect.orElseSucceed(() => ""),
          ),
        ),
    });
    const parts = makePartsCache({
      fetch: () => (disabledHere() ? Promise.resolve(NO_PARTS) : cloud.collab()),
    });

    const errors: Array<TeamLastError> = [];
    const recordError = (part: TeamErrorPart, message: string) => {
      errors.unshift({ at: new Date().toISOString(), part, message });
      errors.splice(ERRORS_KEPT);
      // The sentence only: never a body (colleagues' words, keys).
      void run(
        Effect.logWarning("team: a round failed").pipe(Effect.annotateLogs({ part, message })),
      );
    };

    const source = environment.getEnvironmentId.pipe(Effect.map(String));
    const readComputerRole = makeOwnComputerRoleReader();
    const onAssistantComputer = settings.getSettings.pipe(
      Effect.map((value) => value.uno),
      Effect.orElseSucceed(() => null),
      Effect.flatMap((uno) => Effect.promise(() => readComputerRole(uno))),
      Effect.map((role) => role === ASSISTANT_COMPUTER_ROLE),
    );

    // ── Projects here ────────────────────────────────────────────────────
    let teamProjectsCache: {
      readonly at: number;
      readonly list: ReadonlyArray<TeamProject>;
    } | null = null;
    const loadTeamProjects = async () => {
      if (teamProjectsCache !== null && Date.now() - teamProjectsCache.at < PROJECTS_TTL_MS) {
        return teamProjectsCache.list;
      }
      const list = await cloud.projects();
      teamProjectsCache = { at: Date.now(), list };
      return list;
    };
    const localProjects = () =>
      run(
        Effect.gen(function* () {
          const snapshot = yield* projections.getShellSnapshot();
          const status = yield* projectSync.status.pipe(Effect.orElseSucceed(() => null));
          const folders = new Map(
            snapshot.projects.map((project) => [String(project.id), project]),
          );
          const synced = status?.projects ?? [];
          const known = new Set(synced.map((entry) => String(entry.projectId)));
          return [
            ...synced.map((entry) => ({
              projectId: String(entry.projectId),
              name: entry.name ?? folders.get(String(entry.projectId))?.title ?? null,
              teamId: entry.team?.id ?? null,
              folder: folders.get(String(entry.projectId))?.workspaceRoot ?? null,
            })),
            ...snapshot.projects
              .filter((project) => !known.has(String(project.id)))
              .map((project) => ({
                projectId: String(project.id),
                name: project.title,
                teamId: null,
                folder: project.workspaceRoot,
              })),
          ];
        }),
      );
    const here = async () => projectsHere(await loadTeamProjects(), await localProjects());

    // ── Chats here ───────────────────────────────────────────────────────
    const shellOf = (threadId: string) =>
      projections.getThreadShellById(ThreadId.make(threadId)).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );

    const tell = (threadId: string, text: string) =>
      Effect.gen(function* () {
        const shell = yield* shellOf(threadId);
        if (shell === null || shell.archivedAt !== null) return "gone" as const;
        const status = shell.session?.status;
        if (
          status === "starting" ||
          status === "running" ||
          shell.session?.activeTurnId != null ||
          shell.hasPendingApprovals ||
          shell.hasPendingUserInput
        ) {
          return "busy" as const;
        }
        yield* engine.dispatch(
          {
            type: "thread.turn.start",
            commandId: CommandId.make(`${COMPONENT}:tell:${crypto.randomUUID()}`),
            threadId: ThreadId.make(threadId),
            message: {
              messageId: MessageId.make(crypto.randomUUID()),
              role: "user",
              text,
              attachments: [],
            },
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
            createdAt: new Date().toISOString(),
          },
          { origin: systemCommandOrigin(COMPONENT, "a colleague's words, as outside text") },
        );
        return "told" as const;
      });

    const stop = (threadId: string) =>
      Effect.gen(function* () {
        const origin = {
          origin: systemCommandOrigin(COMPONENT, "stopped at a colleague's request"),
        };
        yield* engine
          .dispatch(
            {
              type: "thread.turn.interrupt",
              commandId: CommandId.make(`${COMPONENT}:interrupt:${crypto.randomUUID()}`),
              threadId: ThreadId.make(threadId),
              createdAt: new Date().toISOString(),
            },
            origin,
          )
          .pipe(Effect.ignoreCause({ log: false }));
        yield* engine
          .dispatch(
            {
              type: "thread.session.stop",
              commandId: CommandId.make(`${COMPONENT}:stop:${crypto.randomUUID()}`),
              threadId: ThreadId.make(threadId),
              createdAt: new Date().toISOString(),
            },
            origin,
          )
          .pipe(Effect.ignoreCause({ log: false }));
      });

    const folderSecrets = makeFolderSecrets();

    const ports: TeamPorts = {
      cloud,
      parts,
      source: () => run(source),
      stateDir: config.stateDir,
      now: () => Date.now(),
      sleep,
      projectsHere: here,
      folderSecrets,
      thread: (threadId) =>
        run(
          Effect.gen(function* () {
            const shell = yield* shellOf(threadId);
            if (shell === null || shell.archivedAt !== null) return null;
            const project = yield* projections
              .getProjectShellById(ProjectId.make(String(shell.projectId)))
              .pipe(
                Effect.map(Option.getOrNull),
                Effect.orElseSucceed(() => null),
              );
            const status = shell.session?.status;
            return {
              threadId,
              projectId: String(shell.projectId),
              title: shell.title,
              status: threadStatusOf(shell),
              busy:
                status === "starting" ||
                status === "running" ||
                shell.session?.activeTurnId != null ||
                shell.hasPendingApprovals ||
                shell.hasPendingUserInput,
              folder: project?.workspaceRoot ?? null,
            };
          }),
        ),
      threadDetail: (threadId) =>
        run(
          projections.getThreadDetailById(ThreadId.make(threadId)).pipe(
            Effect.map(Option.getOrNull),
            Effect.orElseSucceed(() => null),
            Effect.map((thread): LocalThreadDetail | null => {
              if (thread === null) return null;
              const toolsByTurn = new Map<string, ToolCounts>();
              for (const activity of thread.activities) {
                if (activity.kind !== "tool.completed" || activity.turnId === null) continue;
                const payload = activity.payload as { readonly itemType?: unknown } | null;
                const turn = String(activity.turnId);
                toolsByTurn.set(
                  turn,
                  countTool(toolsByTurn.get(turn) ?? NO_TOOLS, payload?.itemType),
                );
              }
              return {
                messages: thread.messages.map((entry) => ({
                  id: String(entry.id),
                  role: entry.role,
                  text: entry.text,
                  turnId: entry.turnId === null ? null : String(entry.turnId),
                  streaming: entry.streaming,
                  createdAt: entry.createdAt,
                })),
                toolsByTurn,
              };
            }),
          ),
        ),
      markOutside: async (threadId) => {
        if (outside === null) {
          throw new Error("Outside text can't be marked here, so a colleague's words can't go in.");
        }
        await run(outside.mark(threadId));
      },
      tell: (threadId, text) =>
        run(tell(threadId, text).pipe(Effect.orElseSucceed(() => "busy" as const))),
      stop: (threadId) => run(stop(threadId)),
      host: {
        admit: (file) => run(chatRequests.team.admit(file)),
        autoStart: (id) => run(chatRequests.team.autoStart(id)),
        decide: (id, decision) => run(chatRequests.decide({ id, decision }).pipe(Effect.asVoid)),
        retire: (id, status, reason) => run(chatRequests.team.retire(id, status, reason)),
        startReadOnly: (input) => run(chatRequests.team.startReadOnly(input)),
        follow: (threadId) => run(chatRequests.team.threadStatus(threadId)),
        records: () => run(chatRequests.team.records),
      },
      telegram:
        notify === null
          ? null
          : {
              linked: () =>
                run(
                  notify
                    .resolveChats({
                      threadId: null,
                      projectId: null,
                      includeAssistantFallback: true,
                    })
                    .pipe(
                      Effect.map((chats) =>
                        pickPersonChats(chats).some((chat) => chat.kind === "telegram"),
                      ),
                    ),
                ),
              send: (input) =>
                run(
                  notify
                    .sendToPerson({
                      threadId: ThreadId.make(input.key),
                      text: input.text,
                      textWithoutButtons: input.textWithoutButtons,
                      ...(input.buttonsFor !== null
                        ? {
                            buttons: chatRequestButtons(input.buttonsFor, "en"),
                            ...(input.buttonsTtlMs !== undefined
                              ? { buttonsTtlMs: input.buttonsTtlMs }
                              : {}),
                          }
                        : {}),
                      language: "en",
                      approval: true,
                    })
                    .pipe(Effect.map((result) => result.delivered > 0)),
                ),
              retire: (recordId, line) => run(notify.retireButtons(recordId, () => line)),
            },
      tunnel:
        myComputer === null
          ? null
          : {
              findWaiting: async (recordId) => {
                const status = await myComputer.core.cachedStatus(15_000).catch(() => null);
                for (const computer of status?.computers ?? []) {
                  if (!computer.online) continue;
                  const text = await myComputer.core
                    .read({
                      computerId: computer.id,
                      path: remotePaths.answer(recordId),
                      maxBytes: 256 * 1024,
                      quiet: true,
                    })
                    .then((read) => read.data.toString("utf8"))
                    .catch((cause: unknown) => {
                      if (cause instanceof MyComputerFailure) return null;
                      return null;
                    });
                  if (text === null) continue;
                  try {
                    const answer = JSON.parse(text) as { readonly status?: unknown };
                    if (answer.status === "waiting") {
                      return {
                        computerId: computer.id,
                        computerName: computer.name || computer.id,
                      };
                    }
                  } catch {
                    // Not an answer: look on.
                  }
                }
                return null;
              },
              decide: async (computerId, recordId, decision) => {
                const body: ChatRequestRemoteDecision = {
                  v: 1,
                  id: recordId,
                  decision,
                  via: "telegram",
                  at: new Date().toISOString(),
                };
                await myComputer.core.write({
                  computerId,
                  path: remotePaths.decision(recordId),
                  data: Buffer.from(JSON.stringify(body, null, 2), "utf8"),
                  mkdirs: true,
                  quiet: true,
                });
              },
            },
      computerName: async () => os.hostname().replace(/\.local$/, "") || "this computer",
      error: recordError,
    };

    const mirror = makeShareMirror(ports);
    const inbound = makeInbound(ports, mirror);
    const bridge: TeamBridge = makeTeamBridge(ports);

    // ── Loops ────────────────────────────────────────────────────────────
    /** A round again and again: after `everyMs`, or longer after each failure. */
    const loop = (part: TeamErrorPart, round: () => Promise<void>, everyMs: number) =>
      Effect.forkScoped(
        Effect.gen(function* () {
          let failures = 0;
          while (true) {
            const ok = yield* Effect.tryPromise({ try: round, catch: teamError }).pipe(
              Effect.as(true),
              Effect.catch((cause) =>
                Effect.sync(() => {
                  recordError(part, errorText(cause));
                  return false;
                }),
              ),
            );
            failures = ok ? 0 : failures + 1;
            yield* Effect.sleep(ok ? everyMs : backoffMs(failures));
          }
        }),
      );

    let following: Promise<void> | null = null;
    const followOnce = () => {
      following ??= bridge.followRound().finally(() => {
        following = null;
      });
      return following;
    };
    chatRequests.team.onChange(() => {
      void followOnce().catch((cause: unknown) => recordError("bridge", errorText(cause)));
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => chatRequests.team.onChange(null)));

    setTeamRequestDecider((action) => bridge.decideFromTelegram(action.requestId, action.decision));
    yield* Effect.addFinalizer(() => Effect.sync(() => setTeamRequestDecider(null)));

    yield* loop("mirror", () => mirror.refresh(), REFRESH_EVERY_MS);
    yield* loop("mirror", () => mirror.flushDue(), FLUSH_EVERY_MS);
    yield* loop("inbound", () => inbound.round(), 0);
    yield* loop("bridge", () => bridge.inboxRound(), 0);
    yield* loop("outgoing", () => bridge.outgoingRound(), 0);
    yield* loop("bridge", followOnce, FOLLOW_EVERY_MS);

    // A chat that changed: the mirror sends it (only the shared ones are known to it).
    const onEvent = (event: OrchestrationEvent) =>
      Effect.sync(() => {
        switch (event.type) {
          case "thread.message-sent":
            mirror.touch(String(event.payload.threadId), !event.payload.streaming);
            return;
          case "thread.activity-appended":
            mirror.touch(String(event.payload.threadId), false);
            return;
          case "thread.session-set":
            mirror.touch(String(event.payload.threadId), true);
            return;
          default:
            return;
        }
      });
    yield* Effect.forkScoped(
      Stream.runForEach(engine.streamDomainEvents, onEvent).pipe(
        Effect.catchCause((cause) => Effect.logWarning("team: event stream stopped", { cause })),
      ),
    );

    // ── RPC ──────────────────────────────────────────────────────────────
    const state: TeamCollabShape["state"] = Effect.gen(function* () {
      const now = parts.peek();
      const store = yield* Effect.tryPromise({
        try: () => readHostStore(config.stateDir),
        catch: teamError,
      });
      const answering = yield* Effect.tryPromise({ try: bridge.answering, catch: teamError });
      const checkedAt = parts.checkedAt();
      const failure = parts.lastError();
      return {
        enabled: now.share || now.requests || now.agents || now.tasks,
        parts: now,
        source: yield* source,
        mirrored: [...mirror.view()],
        answering,
        colleagueSessions: teamActiveCount(store, Date.now()),
        colleagueSessionsLimit: TEAM_SESSIONS_AT_ONCE,
        errors:
          failure === null
            ? [...errors]
            : [
                {
                  at: new Date(checkedAt ?? Date.now()).toISOString(),
                  part: "collab" as const,
                  message: failure,
                },
                ...errors,
              ].slice(0, ERRORS_KEPT),
        checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
      } satisfies TeamState;
    });

    const refresh: TeamCollabShape["refresh"] = Effect.gen(function* () {
      parts.invalidate();
      teamProjectsCache = null;
      yield* Effect.tryPromise({ try: () => mirror.refresh(), catch: teamError });
      yield* Effect.tryPromise({ try: () => mirror.flushDue(), catch: teamError }).pipe(
        Effect.ignoreCause({ log: false }),
      );
      return yield* state;
    });

    const letAgentAnswer: TeamCollabShape["letAgentAnswer"] = (requestId) =>
      Effect.gen(function* () {
        const started = yield* Effect.tryPromise({
          try: () => bridge.letAgentAnswer(requestId),
          catch: teamError,
        });
        return { threadId: started.threadId, state: yield* state };
      });

    return {
      state,
      refresh,
      letAgentAnswer,
      cloud,
      parts,
      source,
      onAssistantComputer,
      teamProjects: Effect.tryPromise({ try: loadTeamProjects, catch: teamError }),
      projectOfFolder: (folder) =>
        Effect.promise(() => here().catch(() => [])).pipe(
          Effect.map(
            (list) =>
              list.find(
                (project) => folder === project.folder || folder.startsWith(`${project.folder}/`),
              ) ?? null,
          ),
        ),
    } satisfies TeamCollabShape;
  }),
);
