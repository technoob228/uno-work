import {
  CHANNEL_NOTIFY_MAX_TEXT_CHARS,
  ManagerTelegramConnectorConfig,
  type ChannelNotifyResult,
  type ProjectId,
} from "@t3tools/contracts";
import { findMarkedAssistantChat } from "@t3tools/shared/assistantChat";
import { Effect, Layer, Option, Schema } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorBindingRepository } from "../../persistence/Services/ManagerConnectorBindings.ts";
import { ManagerConnectorRepository } from "../../persistence/Services/ManagerConnectors.ts";
import { resolveNotifyChats, type NotifyConnector } from "../connectorBindings.ts";
import { formatChannelNotifyText } from "../connectorNotify.ts";
import {
  ConnectorNotifyService,
  type ConnectorNotifyServiceShape,
} from "../Services/ConnectorNotify.ts";
import { ManagerTelegramService } from "./TelegramConnector.ts";

const makeConnectorNotifyService = Effect.gen(function* () {
  const bindingRepository = yield* ManagerConnectorBindingRepository;
  const connectorRepository = yield* ManagerConnectorRepository;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const telegram = yield* ManagerTelegramService;

  // Enabled Telegram connectors and their allowlists — the pool the assistant
  // fallback draws unbound chats from. Slack chats are never resolved here.
  const listEnabledConnectors = (): Effect.Effect<ReadonlyArray<NotifyConnector>> =>
    connectorRepository.listByKind("telegram").pipe(
      Effect.map((records) =>
        records.flatMap((record) => {
          const decoded = Schema.decodeUnknownExit(ManagerTelegramConnectorConfig)(record.config);
          return decoded._tag === "Success" && decoded.value.enabled
            ? [
                {
                  kind: "telegram" as const,
                  projectId: record.projectId,
                  allowedChatIds: decoded.value.allowedChatIds,
                },
              ]
            : [];
        }),
      ),
      Effect.orElseSucceed(() => []),
    );

  const resolveChats: ConnectorNotifyServiceShape["resolveChats"] = (input) =>
    Effect.gen(function* () {
      const bindings = yield* bindingRepository.listAll().pipe(Effect.orElseSucceed(() => []));
      const connectors = yield* listEnabledConnectors();
      // Only chats a connector still allows: a binding outlives an allowlist
      // edit, and a removed chat must not keep receiving pushes.
      const allowed = new Set(
        connectors.flatMap((connector) =>
          connector.allowedChatIds.map((chatId) => `${connector.kind}:${chatId}`),
        ),
      );
      // Personal chats are bound to the main conversation (0.0.86); the
      // fallback still counts them as the human's own chats.
      const mainConversationThreadId = input.includeAssistantFallback
        ? yield* projectionSnapshotQuery.getShellSnapshot().pipe(
            Effect.map((snapshot) => findMarkedAssistantChat(snapshot.threads)?.id ?? null),
            Effect.orElseSucceed(() => null),
          )
        : null;
      return resolveNotifyChats({
        bindings: bindings.filter((binding) => allowed.has(`${binding.kind}:${binding.chatId}`)),
        connectors,
        threadId: input.threadId,
        projectId: input.projectId,
        includeAssistantFallback: input.includeAssistantFallback,
        mainConversationThreadId,
      });
    });

  const sendToChats: ConnectorNotifyServiceShape["sendToChats"] = (chats, text) =>
    Effect.gen(function* () {
      const trimmed = text.slice(0, CHANNEL_NOTIFY_MAX_TEXT_CHARS);
      const results: Array<ChannelNotifyResult["chats"][number]> = [];
      for (const chat of chats) {
        const delivered =
          chat.kind === "telegram"
            ? yield* telegram.sendText({
                projectId: chat.connectorProjectId,
                chatId: chat.chatId,
                text: trimmed,
              })
            : false;
        results.push({ kind: chat.kind, chatId: chat.chatId, delivered });
      }
      return {
        delivered: results.filter((result) => result.delivered).length,
        chats: results,
      };
    });

  const notify: ConnectorNotifyServiceShape["notify"] = (input) =>
    Effect.gen(function* () {
      let projectId: ProjectId | null = input.projectId ?? null;
      if (input.threadId !== undefined) {
        const shell = yield* projectionSnapshotQuery
          .getThreadShellById(input.threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(shell)) {
          projectId = shell.value.projectId;
        }
      }
      const chats = yield* resolveChats({
        threadId: input.threadId ?? null,
        projectId,
        includeAssistantFallback: true,
      });
      return yield* sendToChats(chats, formatChannelNotifyText(input.text, input.kind));
    });

  return { resolveChats, sendToChats, notify } satisfies ConnectorNotifyServiceShape;
});

export const ConnectorNotifyServiceLive = Layer.effect(
  ConnectorNotifyService,
  makeConnectorNotifyService,
);
