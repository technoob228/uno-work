/**
 * Треды панелей плагинов: `plugins.sendToThread` и `plugins.resolvePanelThread`.
 *
 * Панель живёт в sandbox-iframe с opaque origin: у неё нет ни сессии, ни
 * представления о тредах. Она зовёт мост приложения (`panelBridge.ts`),
 * приложение добавляет проект своей вкладки и вызывает эти RPC.
 *
 * Оба RPC ходят в ОДНУ карту `pluginId + threadTag → threadId` (в памяти
 * реестра), поэтому встроенный чат панели и её кнопки «спроси агента» смотрят в
 * один и тот же тред. Разница только в том, что `sendToThread` дополнительно
 * запускает ход, а `resolvePanelThread` — нет (чат сам отправит сообщение
 * обычным путём, через композер).
 *
 * Инварианты (граница доверия — манифест, плагин прав не расширяет):
 * - тред создаётся в проекте вкладки, а не в произвольном;
 * - `runtimeMode`/`interactionMode` наследуются: у переиспользуемого треда —
 *   его собственные, у нового — от первого треда проекта. Если наследовать не
 *   от чего, берём `approval-required` — самый узкий режим (так же поступает
 *   менеджер), а НЕ `DEFAULT_RUNTIME_MODE` (`full-access`);
 * - каждый вызов пишется в историю запусков плагина, т.е. виден в
 *   Settings → Extensions;
 * - `origin: { kind: "plugin", pluginId }` уходит в метаданные всех событий
 *   команды — event store остаётся аудит-логом.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationCommandOrigin,
  type OrchestrationProjectShell,
  type PluginManifest,
  type PluginResolvePanelThreadInput,
  type PluginResolvePanelThreadResult,
  type PluginSendToThreadInput,
  type PluginSendToThreadResult,
  PluginsError,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";
import * as crypto from "node:crypto";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { inheritProjectThreadModes } from "../orchestration/projectThreadModes.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { PluginRegistryShape } from "./PluginRegistry.ts";

export const DEFAULT_PANEL_THREAD_TAG = "panel";
const PANEL_RUN_TRIGGER = "panel sendToThread";
const PANEL_CHAT_RUN_TRIGGER = "panel chat";
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

type Dispatch = (
  command: Parameters<OrchestrationEngineShape["dispatch"]>[0],
) => Effect.Effect<void, PluginsError>;

interface PanelContext {
  readonly manifest: PluginManifest;
  readonly threadTag: string;
  readonly projectShell: OrchestrationProjectShell;
  readonly origin: OrchestrationCommandOrigin;
  readonly dispatch: Dispatch;
}

interface ResolvedPanelThread {
  readonly threadId: ThreadId;
  readonly created: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

function normalizeThreadTag(threadTag: string | undefined): string {
  return (threadTag ?? DEFAULT_PANEL_THREAD_TAG).trim() || DEFAULT_PANEL_THREAD_TAG;
}

/**
 * Общая для обоих RPC проверка: плагин существует, включён, у него есть панель,
 * проект вкладки жив.
 */
function loadPanelContext(
  deps: PanelThreadSenderDeps,
  input: {
    readonly pluginId: string;
    readonly projectId: ProjectId;
    readonly threadTag: string | undefined;
    readonly what: string;
  },
): Effect.Effect<PanelContext, PluginsError> {
  return Effect.gen(function* () {
    const plugins = yield* deps.registry.getLoadedPlugins;
    const plugin = plugins.find((candidate) => candidate.id === input.pluginId);
    const manifest = plugin?.manifest;
    // Панель выключенного/невалидного плагина открыть нельзя (роут отдаёт
    // 404), но вкладка может остаться открытой с прошлого раза — проверяем.
    if (manifest === undefined || !manifest.enabled || manifest.panel === undefined) {
      return yield* new PluginsError({
        detail: `${input.what}: plugin "${input.pluginId}" has no enabled panel`,
      });
    }

    const projectShell = yield* deps.projections
      .getProjectShellById(input.projectId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PluginsError({ detail: `${input.what}: failed to read the project`, cause }),
        ),
      );
    if (Option.isNone(projectShell)) {
      return yield* new PluginsError({
        detail: `${input.what}: project ${input.projectId} no longer exists`,
      });
    }

    const origin: OrchestrationCommandOrigin = { kind: "plugin", pluginId: input.pluginId };
    const dispatch: Dispatch = (command) =>
      deps.engine.dispatch(command, { origin }).pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new PluginsError({
              detail: `${input.what}: dispatch failed (${command.type})`,
              cause,
            }),
        ),
      );

    return {
      manifest,
      threadTag: normalizeThreadTag(input.threadTag),
      projectShell: projectShell.value,
      origin,
      dispatch,
    } satisfies PanelContext;
  });
}

/**
 * Единственный источник правды «какой тред у этой панели»: карта реестра, а при
 * промахе — новый тред в проекте вкладки. Ход НЕ запускается — это забота
 * вызывающего.
 */
function resolveOrCreatePanelThread(
  deps: PanelThreadSenderDeps,
  input: {
    readonly pluginId: string;
    readonly projectId: ProjectId;
    readonly what: string;
    readonly context: PanelContext;
    readonly createdAt: string;
  },
): Effect.Effect<ResolvedPanelThread, PluginsError> {
  return Effect.gen(function* () {
    const { context } = input;
    const existingThreadId = yield* deps.registry.getPanelThreadId({
      pluginId: input.pluginId,
      threadTag: context.threadTag,
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
    if (
      Option.isSome(existingThread) &&
      existingThread.value.projectId === input.projectId &&
      existingThread.value.archivedAt === null
    ) {
      return {
        threadId: existingThread.value.id,
        created: false,
        runtimeMode: existingThread.value.runtimeMode,
        interactionMode: existingThread.value.interactionMode,
      } satisfies ResolvedPanelThread;
    }

    const modelSelection = context.projectShell.defaultModelSelection;
    if (modelSelection === null) {
      return yield* new PluginsError({
        detail: `${input.what}: the project has no default model — open it once in the app and pick a model`,
      });
    }

    const inherited = yield* inheritProjectThreadModes(deps.projections, input.projectId);
    const threadId = ThreadId.make(crypto.randomUUID());
    yield* context.dispatch({
      type: "thread.create",
      commandId: commandId("create"),
      threadId,
      projectId: input.projectId,
      title: `[${context.manifest.name}] ${context.threadTag}`,
      modelSelection,
      runtimeMode: inherited.runtimeMode,
      interactionMode: inherited.interactionMode,
      branch: null,
      worktreePath: null,
      createdAt: input.createdAt,
    });
    yield* deps.registry.setPanelThreadId({
      pluginId: input.pluginId,
      threadTag: context.threadTag,
      threadId,
    });
    return {
      threadId,
      created: true,
      runtimeMode: inherited.runtimeMode,
      interactionMode: inherited.interactionMode,
    } satisfies ResolvedPanelThread;
  });
}

/**
 * Собирает обработчик RPC. Зависимости передаются явно (а не берутся из
 * контекста), чтобы ws.ts оставался тонким, а модуль — тестируемым без всего
 * серверного слоя.
 */
export function makePanelThreadSender(deps: PanelThreadSenderDeps) {
  return (input: PluginSendToThreadInput): Effect.Effect<PluginSendToThreadResult, PluginsError> =>
    Effect.gen(function* () {
      const what = "sendToThread";
      const text = input.text.trim();
      if (text.length === 0) {
        return yield* new PluginsError({ detail: `${what}: text must not be empty` });
      }
      if (text.length > MAX_TEXT_CHARS) {
        return yield* new PluginsError({
          detail: `${what}: text is too long (${text.length} > ${MAX_TEXT_CHARS} chars)`,
        });
      }

      const context = yield* loadPanelContext(deps, {
        pluginId: input.pluginId,
        projectId: input.projectId,
        threadTag: input.threadTag,
        what,
      });
      const createdAt = new Date().toISOString();

      const outcome = yield* Effect.gen(function* () {
        const resolved = yield* resolveOrCreatePanelThread(deps, {
          pluginId: input.pluginId,
          projectId: input.projectId,
          what,
          context,
          createdAt,
        });
        yield* context.dispatch({
          type: "thread.turn.start",
          commandId: commandId("turn"),
          threadId: resolved.threadId,
          message: {
            messageId: MessageId.make(crypto.randomUUID()),
            role: "user" as const,
            text,
            attachments: [],
          },
          runtimeMode: resolved.runtimeMode,
          interactionMode: resolved.interactionMode,
          createdAt,
        });
        return resolved;
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
        detail: `${outcome.created ? "новый тред" : "тред"} [${context.threadTag}]: ${text.slice(0, 200)}`,
      });
      yield* Effect.logInfo("plugins.panel.sendToThread", {
        pluginId: input.pluginId,
        threadTag: context.threadTag,
        threadId: outcome.threadId,
        created: outcome.created,
      });

      return {
        threadId: outcome.threadId,
        created: outcome.created,
        pluginName: context.manifest.name,
        threadTag: context.threadTag,
      } satisfies PluginSendToThreadResult;
    });
}

/**
 * `plugins.resolvePanelThread` — тред для чата, встроенного рядом с панелью.
 * Тот же mapping, что у `sendToThread`, но без запуска хода: сообщения
 * отправляет обычный композер хоста.
 */
export function makePanelThreadResolver(deps: PanelThreadSenderDeps) {
  return (
    input: PluginResolvePanelThreadInput,
  ): Effect.Effect<PluginResolvePanelThreadResult, PluginsError> =>
    Effect.gen(function* () {
      const what = "resolvePanelThread";
      const context = yield* loadPanelContext(deps, {
        pluginId: input.pluginId,
        projectId: input.projectId,
        threadTag: input.threadTag,
        what,
      });

      const resolved = yield* resolveOrCreatePanelThread(deps, {
        pluginId: input.pluginId,
        projectId: input.projectId,
        what,
        context,
        createdAt: new Date().toISOString(),
      }).pipe(
        Effect.tapError((error) =>
          deps.registry.recordRun(input.pluginId, {
            at: new Date().toISOString(),
            trigger: PANEL_CHAT_RUN_TRIGGER,
            ok: false,
            detail: error.detail,
          }),
        ),
      );

      // Историю пишем только на создание треда: чат резолвится при каждом
      // открытии вкладки, и «переиспользовали тред» — не событие.
      if (resolved.created) {
        yield* deps.registry.recordRun(input.pluginId, {
          at: new Date().toISOString(),
          trigger: PANEL_CHAT_RUN_TRIGGER,
          ok: true,
          detail: `новый тред [${context.threadTag}] для чата панели`,
        });
      }
      yield* Effect.logInfo("plugins.panel.resolvePanelThread", {
        pluginId: input.pluginId,
        threadTag: context.threadTag,
        threadId: resolved.threadId,
        created: resolved.created,
      });

      return {
        threadId: resolved.threadId,
        created: resolved.created,
        pluginName: context.manifest.name,
        threadTag: context.threadTag,
      } satisfies PluginResolvePanelThreadResult;
    });
}
