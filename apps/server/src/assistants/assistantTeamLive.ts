/**
 * The team of assistants wired to this daemon: tokens, projects, chats,
 * the Inbox and the schedules (`assistantTeam.ts` holds the rules).
 *
 * @module assistants/assistantTeamLive
 */
import {
  CommandId,
  EventId,
  isAssistantProjectId,
  MessageId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { presetTokenAccess } from "@t3tools/shared/assistantPreset";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "../config.ts";
import { InboxService } from "../inbox/InboxService.ts";
import { ManagerAssistantService } from "../manager/Services/AssistantService.ts";
import { readWorkMachineIdentity } from "../manager/workConsole.ts";
import { systemCommandOrigin } from "../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerCapabilityTokenRepository } from "../persistence/Services/ManagerCapabilityTokens.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AgentMailService } from "../setupTools/AgentMailService.ts";
import { applyAssistantAccess, readAssistantAccess } from "./assistantAccess.ts";
import { AssistantTeam, AssistantTeamError, makeAssistantTeam } from "./assistantTeam.ts";
import { readProfile, writeProfile } from "./localAssistantStore.ts";
import { AssistantSchedules } from "./schedules.ts";

const TEAM_ORIGIN = "assistant-team";

const commandId = (tag: string) => CommandId.make(`assistant-team:${tag}:${crypto.randomUUID()}`);

const teamError = (message: string) => (cause: unknown) =>
  new AssistantTeamError({
    message:
      cause !== null && typeof cause === "object" && "detail" in cause
        ? `${message}: ${String((cause as { detail: unknown }).detail)}`
        : message,
    status: 500,
  });

export const AssistantTeamLive = Layer.effect(
  AssistantTeam,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projections = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const tokens = yield* ManagerCapabilityTokenRepository;
    const assistants = yield* ManagerAssistantService;
    const settingsService = yield* ServerSettingsService;
    const schedules = yield* Effect.serviceOption(AssistantSchedules);
    const inbox = yield* Effect.serviceOption(InboxService);
    const agentMail = yield* Effect.serviceOption(AgentMailService);

    const shell = projections.getShellSnapshot().pipe(
      Effect.map((snapshot) => snapshot.projects),
      Effect.orElseSucceed(() => []),
    );

    const projectRoot = (projectId: ProjectId) =>
      projections.getProjectShellById(projectId).pipe(
        Effect.map((project) => Option.getOrNull(Option.map(project, (p) => p.workspaceRoot))),
        Effect.orElseSucceed(() => null),
      );

    return makeAssistantTeam({
      stateDir: config.stateDir,
      now: () => new Date(),
      listAssistants: () =>
        shell.pipe(
          Effect.map((projects) =>
            projects
              .filter((project) => isAssistantProjectId(project.id))
              .map((project) => ({ projectId: project.id, title: project.title })),
          ),
        ),
      listProjects: () =>
        shell.pipe(
          Effect.map((projects) =>
            projects
              .filter((project) => !isAssistantProjectId(project.id))
              .map((project) => ({ id: project.id as string, title: project.title })),
          ),
        ),
      readAccess: (projectId) =>
        readAssistantAccess({ tokens, stateDir: config.stateDir }, projectId).pipe(
          Effect.map((view) => ({ preset: view.preset, allowlist: view.allowlist })),
        ),
      writeAccess: (projectId, preset, projects) =>
        applyAssistantAccess(
          { tokens, stateDir: config.stateDir },
          projectId,
          presetTokenAccess(preset, projects as never, projectId),
        ).pipe(Effect.asVoid, Effect.orDie),
      createAssistant: (input) =>
        assistants
          .createAssistant({
            name: input.name,
            ...(input.emoji !== undefined ? { emoji: input.emoji } : {}),
            access: { preset: input.preset, projects: input.projects as never },
          })
          .pipe(Effect.mapError(teamError("Couldn't make the assistant"))),
      deleteAssistant: (projectId) =>
        assistants
          .deleteAssistant(projectId)
          .pipe(Effect.mapError(teamError("Couldn't delete the assistant"))),
      renameAssistant: (projectId, title) =>
        engine
          .dispatch({
            type: "project.meta.update",
            commandId: commandId("rename"),
            projectId,
            title,
          })
          .pipe(Effect.asVoid, Effect.ignoreCause({ log: true })),
      setEmoji: (projectId, emoji) =>
        Effect.gen(function* () {
          const root = yield* projectRoot(projectId);
          if (root === null) return;
          yield* Effect.promise(async () => {
            const current = await readProfile(root);
            await writeProfile(root, {
              emoji,
              template: current?.template ?? null,
              createdAt: current?.createdAt ?? new Date().toISOString(),
            });
          });
        }),
      createConversation: (projectId, title) =>
        assistants
          .createConversation({ projectId, title })
          .pipe(Effect.mapError(teamError("Couldn't open a chat with it"))),
      threadAlive: (threadId) =>
        projections.getThreadShellById(threadId as ThreadId).pipe(
          Effect.map((thread) => Option.isSome(thread) && thread.value.archivedAt === null),
          Effect.orElseSucceed(() => false),
        ),
      startTurn: (input) =>
        Effect.gen(function* () {
          const thread = yield* projections
            .getThreadShellById(input.threadId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isNone(thread)) return;
          yield* engine.dispatch(
            {
              type: "thread.turn.start",
              commandId: commandId("turn"),
              threadId: input.threadId,
              message: {
                messageId: MessageId.make(crypto.randomUUID()),
                role: "user",
                text: input.text,
                attachments: [],
              },
              runtimeMode: thread.value.runtimeMode,
              interactionMode: thread.value.interactionMode,
              createdAt: new Date().toISOString(),
            },
            input.system ? { origin: systemCommandOrigin(TEAM_ORIGIN, "setup") } : undefined,
          );
        }).pipe(Effect.ignoreCause({ log: true })),
      showCard: (input) =>
        Effect.gen(function* () {
          const thread = yield* projections
            .getThreadShellById(input.threadId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          const createdAt = new Date().toISOString();
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("ask"),
            threadId: input.threadId,
            activity: {
              id: EventId.make(crypto.randomUUID()),
              tone: "info",
              kind: "user-input.requested",
              summary: "Waiting for your answer",
              payload: { requestId: input.requestId, questions: [input.question] },
              turnId: Option.isSome(thread) ? (thread.value.latestTurn?.turnId ?? null) : null,
              createdAt,
            },
            createdAt,
          });
        }).pipe(Effect.ignoreCause({ log: true })),
      inbox: (post) =>
        Option.isSome(inbox)
          ? inbox.value.post(post).pipe(Effect.asVoid, Effect.ignoreCause({ log: true }))
          : Effect.void,
      ...(Option.isSome(agentMail)
        ? {
            mailboxAddress: () =>
              agentMail.value.status.pipe(
                Effect.map((state) => (state.available ? (state.mailbox?.address ?? null) : null)),
              ),
          }
        : {}),
      routinesAvailable: () =>
        Option.isNone(schedules)
          ? Effect.succeed(false)
          : settingsService.getSettings.pipe(
              Effect.map((settings) => readWorkMachineIdentity(settings.uno) !== null),
              Effect.orElseSucceed(() => false),
            ),
      createRoutine: (caller, input) =>
        Option.isNone(schedules)
          ? Effect.fail({ message: "Schedules are not available in this Uno Work." })
          : schedules.value.create(caller, input),
    });
  }),
);
