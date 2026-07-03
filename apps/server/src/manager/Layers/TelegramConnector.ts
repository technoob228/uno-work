/**
 * TelegramConnector - Telegram ingress/egress for assistants.
 *
 * Every assistant project may own its own bot: the poller iterates all
 * configured `telegram` connector rows each cycle, long-polls each bot, and
 * routes messages from allowlisted chats into that assistant's chat threads.
 * When the turn completes, the last assistant message goes back to the chat.
 *
 * Config lives in `manager_assistant_connectors` and is re-read between poll
 * cycles, so saving settings takes effect without a restart.
 */
import {
  CommandId,
  ManagerTelegramConnectorConfig,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Duration, Effect, Layer, Option, Ref, Schema } from "effect";
import * as crypto from "node:crypto";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorRepository } from "../../persistence/Services/ManagerConnectors.ts";

export interface ManagerTelegramRuntimeStatus {
  readonly botUsername: string | null;
  readonly lastError: string | null;
}

export interface ManagerTelegramServiceShape {
  readonly getRuntimeStatus: (
    projectId: ProjectId,
  ) => Effect.Effect<ManagerTelegramRuntimeStatus>;
}

export class ManagerTelegramService extends Context.Service<
  ManagerTelegramService,
  ManagerTelegramServiceShape
>()("t3/manager/Services/ManagerTelegramService") {}

const POLL_TIMEOUT_SECONDS = 10;
const IDLE_RECHECK = Duration.seconds(5);
const REPLY_POLL_INTERVAL = Duration.seconds(2);
const REPLY_TIMEOUT = Duration.minutes(10);
const TELEGRAM_MESSAGE_LIMIT = 4000;

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly chat?: { readonly id?: number; readonly title?: string; readonly username?: string };
    readonly text?: string;
  };
}

interface BotRuntime {
  offset: number;
  botUsername: string | null;
  lastError: string | null;
}

function telegramApi(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

const fetchJson = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, init);
      return (await response.json()) as { ok?: boolean; result?: unknown; description?: string };
    },
    catch: (cause) => new Error(`Telegram request failed: ${String(cause)}`),
  });

const makeTelegramConnector = Effect.gen(function* () {
  const connectorRepository = yield* ManagerConnectorRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const runtimesRef = yield* Ref.make<ReadonlyMap<ProjectId, BotRuntime>>(new Map());

  const updateRuntime = (projectId: ProjectId, patch: Partial<BotRuntime>) =>
    Ref.update(runtimesRef, (runtimes) => {
      const next = new Map(runtimes);
      const current = next.get(projectId) ?? { offset: 0, botUsername: null, lastError: null };
      next.set(projectId, { ...current, ...patch });
      return next;
    });

  const getRuntime = (projectId: ProjectId) =>
    Ref.get(runtimesRef).pipe(
      Effect.map(
        (runtimes) =>
          runtimes.get(projectId) ?? { offset: 0, botUsername: null, lastError: null },
      ),
    );

  const ensureThreadForChat = (input: {
    readonly projectId: ProjectId;
    readonly chatId: string;
    readonly chatLabel: string;
    readonly config: ManagerTelegramConnectorConfig;
  }): Effect.Effect<ThreadId, unknown> =>
    Effect.gen(function* () {
      const existing = yield* connectorRepository.getThreadForChat({
        projectId: input.projectId,
        kind: "telegram",
        chatId: input.chatId,
      });
      if (Option.isSome(existing)) {
        const shell = yield* projectionSnapshotQuery.getThreadShellById(existing.value);
        if (Option.isSome(shell) && shell.value.archivedAt === null) {
          return existing.value;
        }
      }
      const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId);
      // The connector-level choice wins: Telegram must never spawn a harness
      // the owner didn't pick for it.
      const modelSelection =
        input.config.defaultModelSelection ??
        (Option.isSome(project) ? project.value.defaultModelSelection : null);
      if (modelSelection === null) {
        return yield* Effect.fail(new Error("Assistant project has no model configured."));
      }
      const threadId = ThreadId.make(crypto.randomUUID());
      const createdAt = new Date().toISOString();
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`telegram:${crypto.randomUUID()}`),
        threadId,
        projectId: input.projectId,
        title: `Telegram: ${input.chatLabel}`,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* connectorRepository.setThreadForChat({
        projectId: input.projectId,
        kind: "telegram",
        chatId: input.chatId,
        threadId,
        createdAt,
      });
      return threadId;
    });

  const sendReplyWhenTurnCompletes = (input: {
    readonly botToken: string;
    readonly chatId: string;
    readonly threadId: ThreadId;
    readonly requestedAtIso: string;
  }) =>
    Effect.gen(function* () {
      const deadline = Date.now() + Duration.toMillis(REPLY_TIMEOUT);
      while (Date.now() < deadline) {
        yield* Effect.sleep(REPLY_POLL_INTERVAL);
        const detail = yield* projectionSnapshotQuery.getThreadDetailById(input.threadId);
        if (Option.isNone(detail)) continue;
        const turn = detail.value.latestTurn;
        if (turn === null || turn.state === "running") continue;
        const lastAssistantMessage = [...detail.value.messages]
          .reverse()
          .find(
            (message) =>
              message.role === "assistant" &&
              !message.streaming &&
              message.createdAt >= input.requestedAtIso,
          );
        const text =
          lastAssistantMessage !== undefined && lastAssistantMessage.text.trim().length > 0
            ? lastAssistantMessage.text.slice(0, TELEGRAM_MESSAGE_LIMIT)
            : `Turn finished with state: ${turn.state}.`;
        yield* fetchJson(telegramApi(input.botToken, "sendMessage"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: input.chatId, text }),
        });
        return;
      }
      yield* fetchJson(telegramApi(input.botToken, "sendMessage"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: input.chatId,
          text: "The assistant is still working on it; check the app for progress.",
        }),
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("telegram reply watcher failed").pipe(
          Effect.annotateLogs({ chatId: input.chatId, cause }),
        ),
      ),
    );

  const handleUpdate = (
    projectId: ProjectId,
    config: ManagerTelegramConnectorConfig,
    update: TelegramUpdate,
  ) =>
    Effect.gen(function* () {
      const chatIdNumber = update.message?.chat?.id;
      const text = update.message?.text;
      if (chatIdNumber === undefined || text === undefined || text.trim().length === 0) {
        return;
      }
      const chatId = String(chatIdNumber);
      if (!config.allowedChatIds.includes(chatId)) {
        yield* Effect.logDebug("telegram message from non-allowlisted chat ignored").pipe(
          Effect.annotateLogs({ projectId, chatId }),
        );
        return;
      }
      const chatLabel =
        update.message?.chat?.title ?? update.message?.chat?.username ?? chatId;
      const threadId = yield* ensureThreadForChat({ projectId, chatId, chatLabel, config });
      const requestedAtIso = new Date().toISOString();
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`telegram:${crypto.randomUUID()}`),
        threadId,
        message: {
          messageId: MessageId.make(crypto.randomUUID()),
          role: "user",
          text,
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: requestedAtIso,
      });
      yield* Effect.forkScoped(
        sendReplyWhenTurnCompletes({
          botToken: config.botToken,
          chatId,
          threadId,
          requestedAtIso,
        }),
      );
    });

  const pollConnector = (projectId: ProjectId, config: ManagerTelegramConnectorConfig) =>
    Effect.gen(function* () {
      const runtime = yield* getRuntime(projectId);
      if (runtime.botUsername === null) {
        const me = yield* fetchJson(telegramApi(config.botToken, "getMe"));
        if (me.ok === true) {
          const username = (me.result as { username?: string } | undefined)?.username ?? null;
          yield* updateRuntime(projectId, { botUsername: username });
        } else {
          yield* updateRuntime(projectId, {
            lastError: me.description ?? "getMe failed — check the bot token.",
          });
          return;
        }
      }

      const offset = (yield* getRuntime(projectId)).offset;
      const response = yield* fetchJson(
        telegramApi(config.botToken, "getUpdates") +
          `?timeout=${POLL_TIMEOUT_SECONDS}&offset=${offset}&allowed_updates=%5B%22message%22%5D`,
      );
      if (response.ok !== true) {
        yield* updateRuntime(projectId, {
          lastError: response.description ?? "getUpdates failed.",
        });
        return;
      }
      yield* updateRuntime(projectId, { lastError: null });
      const updates = (response.result ?? []) as ReadonlyArray<TelegramUpdate>;
      for (const update of updates) {
        yield* updateRuntime(projectId, { offset: update.update_id + 1 });
        yield* handleUpdate(projectId, config, update).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("telegram update handling failed").pipe(
              Effect.annotateLogs({ projectId, cause }),
            ),
          ),
        );
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* updateRuntime(projectId, {
            lastError: cause instanceof Error ? cause.message : "Telegram polling failed.",
          });
          yield* Effect.logWarning("telegram poll cycle failed").pipe(
            Effect.annotateLogs({ projectId, cause }),
          );
        }),
      ),
    );

  const pollCycle = Effect.gen(function* () {
    const records = yield* connectorRepository.listByKind("telegram").pipe(
      Effect.orElseSucceed(() => []),
    );
    const enabled = records.flatMap((record) => {
      const decoded = Schema.decodeUnknownExit(ManagerTelegramConnectorConfig)(record.config);
      return decoded._tag === "Success" && decoded.value.enabled
        ? [{ projectId: record.projectId, config: decoded.value }]
        : [];
    });
    if (enabled.length === 0) {
      yield* Effect.sleep(IDLE_RECHECK);
      return;
    }
    // Poll all enabled bots concurrently; each long-polls up to 10s.
    yield* Effect.forEach(
      enabled,
      ({ projectId, config }) => pollConnector(projectId, config),
      { concurrency: 4, discard: true },
    );
  });

  yield* Effect.forkScoped(Effect.forever(pollCycle));

  return {
    getRuntimeStatus: (projectId) =>
      getRuntime(projectId).pipe(
        Effect.map((runtime) => ({
          botUsername: runtime.botUsername,
          lastError: runtime.lastError,
        })),
      ),
  } satisfies ManagerTelegramServiceShape;
});

export const ManagerTelegramServiceLive = Layer.effect(
  ManagerTelegramService,
  makeTelegramConnector,
);
