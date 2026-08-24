/**
 * `plugins.sendToThread` — панель плагина просит агента что-то сделать.
 *
 * Панель живёт в sandbox-iframe с opaque origin: у неё нет ни сессии, ни
 * представления о тредах. Она зовёт мост приложения (`panelBridge.ts`),
 * приложение добавляет проект своей вкладки и вызывает этот RPC.
 *
 * Инварианты (граница доверия — манифест, плагин прав не расширяет):
 * - тред создаётся в проекте вкладки, а не в произвольном;
 * - `runtimeMode`/`interactionMode` наследуются: у переиспользуемого треда —
 *   его собственные, у нового — от первого треда проекта. Если наследовать не
 *   от чего, берём `approval-required` — самый узкий режим (так же поступает
 *   менеджер), а НЕ `DEFAULT_RUNTIME_MODE` (`full-access`);
 * - каждый вызов пишется в историю запусков плагина (`trigger: "panel
 *   sendToThread"`), т.е. виден в Settings → Extensions;
 * - `origin: { kind: "plugin", pluginId }` уходит в метаданные всех событий
 *   команды — event store остаётся аудит-логом.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationCommandOrigin,
  type PluginSendToThreadInput,
  type PluginSendToThreadResult,
  PluginsError,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";
import * as crypto from "node:crypto";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { PluginRegistryShape } from "./PluginRegistry.ts";

export const DEFAULT_PANEL_THREAD_TAG = "panel";
/** Самый узкий режим — дефолт, когда наследовать не от чего. */
const FALLBACK_RUNTIME_MODE: RuntimeMode = "approval-required";
const PANEL_RUN_TRIGGER = "panel sendToThread";
const MAX_TEXT_CHARS = 32_000;

export interface PanelThreadSenderDeps {
  readonly registry: Pick<
    PluginRegistryShape,
    "getLoadedPlugins" | "getPanelThreadId" | "setPanelThreadId" | "recordRun"
  >;
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly projections: Pick<
    ProjectionSnapshotQueryShape,
    "getProjectShellById" | "getThreadShellById" | "getFirstActiveThreadIdByProjectId"
  >;
}

const commandId = (tag: string) => CommandId.make(`plugin:${tag}:${crypto.randomUUID()}`);

/**
 * Собирает обработчик RPC. Зависимости передаются явно (а не берутся из
 * контекста), чтобы ws.ts оставался тонким, а модуль — тестируемым без всего
 * серверного слоя.
 */
export function makePanelThreadSender(deps: PanelThreadSenderDeps) {
  return (input: PluginSendToThreadInput): Effect.Effect<PluginSendToThreadResult, PluginsError> =>
    Effect.gen(function* () {
      const text = input.text.trim();
      if (text.length === 0) {
        return yield* new PluginsError({ detail: "sendToThread: text must not be empty" });
      }
      if (text.length > MAX_TEXT_CHARS) {
        return yield* new PluginsError({
          detail: `sendToThread: text is too long (${text.length} > ${MAX_TEXT_CHARS} chars)`,
        });
      }
      const threadTag =
        (input.threadTag ?? DEFAULT_PANEL_THREAD_TAG).trim() || DEFAULT_PANEL_THREAD_TAG;

      const plugins = yield* deps.registry.getLoadedPlugins;
      const plugin = plugins.find((candidate) => candidate.id === input.pluginId);
      const manifest = plugin?.manifest;
      // Панель выключенного/невалидного плагина открыть нельзя (роут отдаёт
      // 404), но вкладка может остаться открытой с прошлого раза — проверяем.
      if (manifest === undefined || !manifest.enabled || manifest.panel === undefined) {
        return yield* new PluginsError({
          detail: `sendToThread: plugin "${input.pluginId}" has no enabled panel`,
        });
      }

      const projectShell = yield* deps.projections
        .getProjectShellById(input.projectId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new PluginsError({ detail: "sendToThread: failed to read the project", cause }),
          ),
        );
      if (Option.isNone(projectShell)) {
        return yield* new PluginsError({
          detail: `sendToThread: project ${input.projectId} no longer exists`,
        });
      }

      const existingThreadId = yield* deps.registry.getPanelThreadId({
        pluginId: input.pluginId,
        threadTag,
      });
      const existingThread =
        existingThreadId === undefined
          ? Option.none()
          : yield* deps.projections.getThreadShellById(existingThreadId).pipe(
              // Мёртвый/удалённый тред — не ошибка: просто заводим новый.
              Effect.orElseSucceed(() => Option.none()),
            );
      // Тред из карты годится, только если он всё ещё в том же проекте и не
      // заархивирован — иначе панель писала бы в чужой/скрытый тред.
      const reusable =
        Option.isSome(existingThread) &&
        existingThread.value.projectId === input.projectId &&
        existingThread.value.archivedAt === null
          ? existingThread.value
          : null;

      const origin: OrchestrationCommandOrigin = { kind: "plugin", pluginId: input.pluginId };
      const createdAt = new Date().toISOString();
      const message = {
        messageId: MessageId.make(crypto.randomUUID()),
        role: "user" as const,
        text,
        attachments: [],
      };

      const dispatch = (
        command: Parameters<OrchestrationEngineShape["dispatch"]>[0],
      ): Effect.Effect<void, PluginsError> =>
        deps.engine.dispatch(command, { origin }).pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new PluginsError({
                detail: `sendToThread: dispatch failed (${command.type})`,
                cause,
              }),
          ),
        );

      const outcome = yield* Effect.gen(function* () {
        if (reusable !== null) {
          yield* dispatch({
            type: "thread.turn.start",
            commandId: commandId("turn"),
            threadId: reusable.id,
            message,
            runtimeMode: reusable.runtimeMode,
            interactionMode: reusable.interactionMode,
            createdAt,
          });
          return { threadId: reusable.id, created: false };
        }

        const modelSelection = projectShell.value.defaultModelSelection;
        if (modelSelection === null) {
          return yield* new PluginsError({
            detail:
              "sendToThread: the project has no default model — open it once in the app and pick a model",
          });
        }

        const inherited = yield* inheritThreadModes(deps, input.projectId);
        const threadId = ThreadId.make(crypto.randomUUID());
        yield* dispatch({
          type: "thread.create",
          commandId: commandId("create"),
          threadId,
          projectId: input.projectId,
          title: `[${manifest.name}] ${threadTag}`,
          modelSelection,
          runtimeMode: inherited.runtimeMode,
          interactionMode: inherited.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* dispatch({
          type: "thread.turn.start",
          commandId: commandId("turn"),
          threadId,
          message,
          runtimeMode: inherited.runtimeMode,
          interactionMode: inherited.interactionMode,
          createdAt,
        });
        yield* deps.registry.setPanelThreadId({ pluginId: input.pluginId, threadTag, threadId });
        return { threadId, created: true };
      }).pipe(
        Effect.tapError((error) =>
          deps.registry.recordRun(input.pluginId, {
            at: new Date().toISOString(),
            trigger: PANEL_RUN_TRIGGER,
            ok: false,
            detail: error.detail,
          }),
        ),
      );

      yield* deps.registry.recordRun(input.pluginId, {
        at: new Date().toISOString(),
        trigger: PANEL_RUN_TRIGGER,
        ok: true,
        detail: `${outcome.created ? "новый тред" : "тред"} [${threadTag}]: ${text.slice(0, 200)}`,
      });
      yield* Effect.logInfo("plugins.panel.sendToThread", {
        pluginId: input.pluginId,
        threadTag,
        threadId: outcome.threadId,
        created: outcome.created,
      });

      return {
        threadId: outcome.threadId,
        created: outcome.created,
        pluginName: manifest.name,
        threadTag,
      } satisfies PluginSendToThreadResult;
    });
}

/**
 * У проекта нет собственного `runtimeMode` — режим живёт на треде. Поэтому
 * «унаследованный от проекта» = режим первого активного треда проекта; если
 * тредов нет, берём самый узкий режим, а не глобальный дефолт приложения.
 */
function inheritThreadModes(
  deps: PanelThreadSenderDeps,
  projectId: PluginSendToThreadInput["projectId"],
): Effect.Effect<
  { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
  never
> {
  return Effect.gen(function* () {
    const firstThreadId = yield* deps.projections
      .getFirstActiveThreadIdByProjectId(projectId)
      .pipe(Effect.orElseSucceed(() => Option.none<ThreadId>()));
    if (Option.isNone(firstThreadId)) {
      return { runtimeMode: FALLBACK_RUNTIME_MODE, interactionMode: "default" as const };
    }
    const shell = yield* deps.projections
      .getThreadShellById(firstThreadId.value)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(shell)) {
      return { runtimeMode: FALLBACK_RUNTIME_MODE, interactionMode: "default" as const };
    }
    return {
      runtimeMode: shell.value.runtimeMode,
      interactionMode: shell.value.interactionMode,
    };
  });
}
