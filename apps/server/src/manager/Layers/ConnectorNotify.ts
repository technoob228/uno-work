import {
  isAssistantProjectId,
  CHANNEL_NOTIFY_MAX_TEXT_CHARS,
  ManagerSlackConnectorConfig,
  ManagerTelegramConnectorConfig,
  parseSlackChatKey,
  type ChannelNotifyResult,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { findMarkedAssistantChat } from "@t3tools/shared/assistantChat";
import { Effect, Layer, Option, Ref, Schema } from "effect";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { sendUnoServiceNotification, UNO_SERVICE_CHAT_ID } from "../unoServiceNotify.ts";
import { readWorkMachineIdentity } from "../workConsole.ts";
import { ManagerConnectorBindingRepository } from "../../persistence/Services/ManagerConnectorBindings.ts";
import { ManagerConnectorRepository } from "../../persistence/Services/ManagerConnectors.ts";
import { resolveNotifyChats, type NotifyConnector } from "../connectorBindings.ts";
import { isRouteCredential } from "../channelRelay.ts";
import {
  admitPersonMessage,
  formatChannelNotifyText,
  pickPersonChats,
} from "../connectorNotify.ts";
import { buttonsAsText, chatHeaderLine } from "../connectorButtons.ts";
import { resolveConnectorOutgoingFile } from "../connectorOutgoingFiles.ts";
import {
  driveLinkForFile,
  largeFileCloudDeps,
  largeFileText,
  SLACK_UPLOAD_LIMIT_BYTES,
} from "../largeFileLink.ts";
import { UNO_WORK_OPEN_URL } from "../taskDoneNotify.ts";
import { TELEGRAM_BOT_UPLOAD_LIMIT_BYTES } from "../telegramMedia.ts";
import { currentWorkAddress } from "../../workAddress.ts";
import { detectReplyLanguage } from "../connectorReplyText.ts";
import { makeThreadSendableRoots } from "../threadSendableRoots.ts";
import { assistantAccessDepsOption } from "../../assistants/assistantAccess.ts";
import {
  ConnectorNotifyService,
  type ConnectorNotifyServiceShape,
} from "../Services/ConnectorNotify.ts";
import { ManagerSlackService } from "./SlackConnector.ts";
import { ManagerTelegramService } from "./TelegramConnector.ts";

const makeConnectorNotifyService = Effect.gen(function* () {
  const bindingRepository = yield* ManagerConnectorBindingRepository;
  const connectorRepository = yield* ManagerConnectorRepository;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const telegram = yield* ManagerTelegramService;
  const slack = yield* ManagerSlackService;

  // Enabled Telegram connectors and their allowlists — the pool the assistant
  // fallback draws unbound chats from.
  // `routed`: an assistant that talks through another assistant's bot
  // (Uno's shared bot, `unoroute:`). Its chats are reached through their
  // bindings on the holder's bot, never as a connector of its own.
  const listTelegramConnectors = (): Effect.Effect<
    ReadonlyArray<NotifyConnector & { readonly routed: boolean }>
  > =>
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
                  routed: isRouteCredential(decoded.value.botToken),
                },
              ]
            : [];
        }),
      ),
      Effect.orElseSucceed(() => []),
    );

  // Enabled Slack connectors. Only the explicit `notify` path asks for them
  // (`includeSlack`); the events forwarder stays Telegram-only as before.
  const listSlackConnectors = (): Effect.Effect<ReadonlyArray<NotifyConnector>> =>
    connectorRepository.listByKind("slack").pipe(
      Effect.map((records) =>
        records.flatMap((record) => {
          const decoded = Schema.decodeUnknownExit(ManagerSlackConnectorConfig)(record.config);
          return decoded._tag === "Success" && decoded.value.enabled
            ? [
                {
                  kind: "slack" as const,
                  projectId: record.projectId,
                  allowedChatIds: decoded.value.allowedChannelIds,
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
      const telegramRows = yield* listTelegramConnectors();
      const connectors: ReadonlyArray<NotifyConnector> = [
        ...telegramRows
          .filter((row) => !row.routed)
          .map(({ kind, projectId, allowedChatIds }) => ({ kind, projectId, allowedChatIds })),
        ...(input.includeSlack === true ? yield* listSlackConnectors() : []),
      ];
      // Only chats a connector still allows: a binding outlives an allowlist
      // edit, and a removed chat must not keep receiving pushes. A Slack chat
      // key may carry a thread (`channel:thread_ts`): the channel decides.
      const allowed = new Set(
        [...connectors, ...telegramRows.filter((row) => row.routed)].flatMap((connector) =>
          connector.allowedChatIds.map((chatId) => `${connector.kind}:${chatId}`),
        ),
      );
      const isAllowedChat = (kind: string, chatId: string) =>
        allowed.has(`${kind}:${kind === "slack" ? parseSlackChatKey(chatId).channelId : chatId}`);
      // Personal chats are bound to the main conversation (0.0.86); the
      // fallback still counts them as the human's own chats.
      const mainConversationThreadId = input.includeAssistantFallback
        ? yield* projectionSnapshotQuery.getShellSnapshot().pipe(
            Effect.map((snapshot) => findMarkedAssistantChat(snapshot.threads)?.id ?? null),
            Effect.orElseSucceed(() => null),
          )
        : null;
      return resolveNotifyChats({
        bindings: bindings.filter((binding) => isAllowedChat(binding.kind, binding.chatId)),
        connectors,
        threadId: input.threadId,
        projectId: input.projectId,
        includeAssistantFallback: input.includeAssistantFallback,
        mainConversationThreadId,
      });
    });

  const sendToChats: ConnectorNotifyServiceShape["sendToChats"] = (chats, text, options) =>
    Effect.gen(function* () {
      const trimmed = text.slice(0, CHANNEL_NOTIFY_MAX_TEXT_CHARS);
      const results: Array<ChannelNotifyResult["chats"][number]> = [];
      for (const chat of chats) {
        const slackTarget = chat.kind === "slack" ? parseSlackChatKey(chat.chatId) : null;
        const delivered =
          slackTarget !== null
            ? yield* slack.sendText({
                projectId: chat.connectorProjectId,
                channelId: slackTarget.channelId,
                text: trimmed,
                ...(options?.asAssistant ? { asAssistant: options.asAssistant } : {}),
                ...(slackTarget.threadTs !== null ? { threadTs: slackTarget.threadTs } : {}),
              })
            : yield* telegram.sendText({
                projectId: chat.connectorProjectId,
                chatId: chat.chatId,
                text: trimmed,
              });
        results.push({ kind: chat.kind, chatId: chat.chatId, delivered });
      }
      return {
        delivered: results.filter((result) => result.delivered).length,
        chats: results,
      };
    });

  // Uno's own bot for service notifications (unoServiceNotify.ts): the
  // console sends them as this machine. Absent in tests and on a laptop.
  const serverSettings = Option.getOrNull(yield* Effect.serviceOption(ServerSettingsService));
  const sendToUnoBot = (text: string): Effect.Effect<ChannelNotifyResult> =>
    Effect.gen(function* () {
      const settings = serverSettings
        ? yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null))
        : null;
      const { delivered } = yield* sendUnoServiceNotification({
        identity: readWorkMachineIdentity(settings?.uno),
        text,
      });
      return {
        delivered: delivered ? 1 : 0,
        chats: delivered ? [{ kind: "telegram", chatId: UNO_SERVICE_CHAT_ID, delivered }] : [],
      };
    });

  /**
   * Who speaks: the assistant (its chats and schedules — they go to its own
   * bot, the person's conversation with it) or Uno itself (another chat's
   * agent, an app, a token or browser request — service notifications).
   */
  const isAssistantSubject = (threadId: ThreadId | null, projectId: ProjectId | null) =>
    Effect.gen(function* () {
      if (projectId !== null && isAssistantProjectId(projectId)) return true;
      if (threadId === null) return false;
      const main = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
        Effect.map((snapshot) => findMarkedAssistantChat(snapshot.threads)?.id ?? null),
        Effect.orElseSucceed(() => null),
      );
      return main !== null && main === threadId;
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
      const threadId = input.threadId ?? null;
      const fromAssistant = yield* isAssistantSubject(threadId, projectId);
      const text = formatChannelNotifyText(input.text, input.kind);
      // A chat the person bound to this thread / project gets it either way;
      // the "the person's own chats" fallback is the assistant's alone.
      const chats = yield* resolveChats({
        threadId,
        projectId,
        includeAssistantFallback: fromAssistant,
        includeSlack: true,
      });
      if (chats.length > 0) {
        return yield* sendToChats(chats, text, {
          asAssistant: projectId !== null && isAssistantProjectId(projectId) ? projectId : null,
        });
      }
      // Uno's service notification (or the assistant before it has a bot):
      // Uno's own bot, never the assistant's; not linked → the Inbox only.
      return yield* sendToUnoBot(text);
    });

  // messenger_send: the folders a chat may send files from (as send_file).
  const sendableRootsOf = makeThreadSendableRoots({
    projections: projectionSnapshotQuery,
    home: os.homedir(),
    access: yield* assistantAccessDepsOption,
  });
  const personSentAtRef = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<number>>>(new Map());

  const sendToPerson: ConnectorNotifyServiceShape["sendToPerson"] = (input) =>
    Effect.gen(function* () {
      const admitted =
        input.approval === true ||
        (yield* Ref.modify(personSentAtRef, (sentAt) => {
          const verdict = admitPersonMessage(sentAt, input.threadId, Date.now());
          return [verdict.admit, verdict.sentAt] as const;
        }));
      if (!admitted) {
        return {
          delivered: 0,
          via: "none" as const,
          note: "Not sent: this chat already wrote to the person many times in the last minutes. Wait, or put it all in one message.",
        };
      }
      const shell = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const projectId = Option.isSome(shell) ? shell.value.projectId : null;
      const title = Option.isSome(shell) ? shell.value.title : "Chat";
      // The assistant's own conversation speaks as itself; any other chat
      // is named, and the person's reply goes back to it.
      const fromAssistant = yield* isAssistantSubject(input.threadId, projectId);
      const language = input.language ?? detectReplyLanguage(`${title}\n${input.text}`, null);
      const body = input.text.trim();
      const text = fromAssistant ? body : `${chatHeaderLine(title)}\n${body}`.trim();

      let filePath: string | null = null;
      let note: string | null = null;
      if (input.file !== undefined && input.file !== null && input.file.trim().length > 0) {
        const roots = yield* sendableRootsOf(input.threadId);
        const resolved = yield* Effect.promise(() =>
          resolveConnectorOutgoingFile(input.file!.trim(), roots, os.homedir()),
        );
        if (!resolved.ok) {
          return { delivered: 0, via: "none" as const, note: `Not sent: ${resolved.reason}.` };
        }
        filePath = resolved.path;
      }

      const sizeOfFile =
        filePath === null
          ? 0
          : yield* Effect.promise(() =>
              fsPromises.stat(filePath!).then(
                (stat) => stat.size,
                () => 0,
              ),
            );
      /** The line that replaces a file too big for this chat. */
      const largeFileLine = (chat: "Telegram" | "Slack") =>
        Effect.gen(function* () {
          const current =
            serverSettings === null
              ? null
              : yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
          const cloud = current === null ? null : largeFileCloudDeps(current);
          const url =
            cloud === null
              ? null
              : yield* Effect.tryPromise(() => driveLinkForFile(cloud, filePath!)).pipe(
                  Effect.orElseSucceed(() => null),
                );
          return largeFileText({
            language,
            name: nodePath.basename(filePath!),
            sizeBytes: sizeOfFile,
            chat,
            url,
            moreUrl: currentWorkAddress() ?? UNO_WORK_OPEN_URL,
          });
        });

      const chats = pickPersonChats(
        yield* resolveChats({
          threadId: input.threadId,
          projectId,
          includeAssistantFallback: true,
          includeSlack: true,
        }),
      );
      const buttons = input.buttons ?? [];
      const plainText =
        input.textWithoutButtons === undefined
          ? text
          : fromAssistant
            ? input.textWithoutButtons
            : `${chatHeaderLine(title)}\n${input.textWithoutButtons}`;
      let delivered = 0;
      let via: "telegram" | "slack" | "none" = "none";
      for (const chat of chats) {
        if (chat.kind === "telegram") {
          const tooBig = sizeOfFile > TELEGRAM_BOT_UPLOAD_LIMIT_BYTES;
          const sent = yield* telegram.sendRich({
            projectId: chat.connectorProjectId,
            chatId: chat.chatId,
            text: tooBig ? `${text}\n\n${yield* largeFileLine("Telegram")}`.trim() : text,
            filePath: tooBig ? null : filePath,
            buttons,
            threadId: input.threadId,
            routeReplies: !fromAssistant,
            language,
            ...(input.buttonsTtlMs !== undefined ? { buttonsTtlMs: input.buttonsTtlMs } : {}),
          });
          if (sent.ok) {
            delivered += 1;
            via = "telegram";
          }
          if (sent.error !== null) note = sent.error;
          continue;
        }
        // Slack: options as a line; the file goes after the text.
        const target = parseSlackChatKey(chat.chatId);
        const tooBig = sizeOfFile > SLACK_UPLOAD_LIMIT_BYTES;
        const slackText = [
          plainText,
          buttons.length > 0 && plainText === text ? buttonsAsText(buttons, language) : null,
          tooBig ? yield* largeFileLine("Slack") : null,
        ]
          .filter((part): part is string => part !== null)
          .join("\n\n");
        const place = {
          projectId: chat.connectorProjectId,
          channelId: target.channelId,
          ...(projectId !== null && isAssistantProjectId(projectId)
            ? { asAssistant: projectId }
            : {}),
          ...(target.threadTs !== null ? { threadTs: target.threadTs } : {}),
        };
        const ok = yield* slack.sendText({
          ...place,
          text: slackText.slice(0, CHANNEL_NOTIFY_MAX_TEXT_CHARS),
        });
        if (ok) {
          delivered += 1;
          if (via === "none") via = "slack";
          if (buttons.length > 0) note = "Slack got the buttons as a list of options.";
          if (filePath !== null && !tooBig) {
            yield* slack.sendFile({ ...place, filePath });
          }
        }
      }
      if (chats.length > 0) return { delivered, via, note };
      // No Telegram / Slack linked to Uno Work: Uno's service bot, text only.
      const service = yield* sendToUnoBot(plainText);
      return service.delivered > 0
        ? {
            delivered: service.delivered,
            via: "uno-bot" as const,
            note:
              buttons.length > 0 || filePath !== null
                ? "Sent as text through Uno's bot: buttons and files need Telegram connected in Uno Work (Settings → Telegram)."
                : null,
          }
        : {
            delivered: 0,
            via: "none" as const,
            note: "The person has no Telegram or Slack connected to Uno Work. Use notify (Inbox) instead.",
          };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("message to the person failed").pipe(
          Effect.annotateLogs({ threadId: input.threadId, cause }),
          Effect.as({ delivered: 0, via: "none" as const, note: "Sending failed." }),
        ),
      ),
    );

  const retireButtons: ConnectorNotifyServiceShape["retireButtons"] = (requestId) =>
    telegram.retireRequestButtons(requestId);

  return {
    resolveChats,
    sendToChats,
    sendToPerson,
    retireButtons,
    notify,
  } satisfies ConnectorNotifyServiceShape;
});

export const ConnectorNotifyServiceLive = Layer.effect(
  ConnectorNotifyService,
  makeConnectorNotifyService,
);
