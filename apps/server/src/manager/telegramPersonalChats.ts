/**
 * Personal Telegram chats → the main conversation (0.0.86).
 *
 * Since 0.0.85 a private chat linked by code talks to the assistant's main
 * conversation (the pinned "Uno" chat). Chats linked before that — or added
 * by chat id in settings — still talk to a Telegram thread of their own. This
 * is the one-time re-pointing of those chats, run by the Telegram connector
 * once per daemon start as soon as the main conversation exists. It only
 * writes bindings: the old per-chat threads and their history stay where
 * they are, the chat simply stops routing to them. Groups are left alone.
 *
 * Naturally idempotent: a chat already bound to the main conversation is not
 * planned again (see `connectorBindings.ts#planPrivateChatMigration`), so a
 * second run — or a second start — changes nothing.
 *
 * @module manager/telegramPersonalChats
 */
import {
  ASSISTANT_PROJECT_ID,
  ManagerTelegramConnectorConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";

import type { ManagerConnectorBindingRepositoryShape } from "../persistence/Services/ManagerConnectorBindings.ts";
import type { ManagerConnectorRepositoryShape } from "../persistence/Services/ManagerConnectors.ts";
import { planPrivateChatMigration, type PrivateChatMigrationStep } from "./connectorBindings.ts";

export type PersonalChatMigrationResult =
  /** The default assistant has no (valid) Telegram connector: nothing to do. */
  | { readonly status: "no-connector" }
  /** No main conversation yet: try again once it exists. */
  | { readonly status: "no-main-conversation" }
  | {
      readonly status: "done";
      readonly mainThreadId: ThreadId;
      readonly migrated: ReadonlyArray<PrivateChatMigrationStep>;
    };

export const migratePersonalTelegramChats = <E, R>(input: {
  readonly connectors: Pick<ManagerConnectorRepositoryShape, "get">;
  readonly bindings: Pick<ManagerConnectorBindingRepositoryShape, "listAll" | "upsert">;
  /** The main conversation's id, or null when there is none yet (read only when needed). */
  readonly findMainThreadId: Effect.Effect<ThreadId | null, E, R>;
  readonly nowIso: string;
}) =>
  Effect.gen(function* () {
    const record = yield* input.connectors.get({
      projectId: ASSISTANT_PROJECT_ID,
      kind: "telegram",
    });
    if (Option.isNone(record)) {
      return { status: "no-connector" } satisfies PersonalChatMigrationResult;
    }
    const decoded = Schema.decodeUnknownExit(ManagerTelegramConnectorConfig)(record.value.config);
    if (decoded._tag !== "Success") {
      return { status: "no-connector" } satisfies PersonalChatMigrationResult;
    }
    const mainThreadId = yield* input.findMainThreadId;
    if (mainThreadId === null) {
      return { status: "no-main-conversation" } satisfies PersonalChatMigrationResult;
    }
    const bindings = yield* input.bindings.listAll();
    const plan = planPrivateChatMigration({
      connectorProjectId: ASSISTANT_PROJECT_ID,
      allowedChatIds: decoded.value.allowedChatIds,
      bindings,
      mainThreadId,
    });
    for (const step of plan) {
      yield* input.bindings.upsert({
        kind: "telegram",
        chatId: step.chatId,
        connectorProjectId: ASSISTANT_PROJECT_ID,
        target: { kind: "thread", threadId: mainThreadId },
        notifyOnComplete: step.notifyOnComplete,
        updatedAt: input.nowIso,
      });
    }
    return { status: "done", mainThreadId, migrated: plan } satisfies PersonalChatMigrationResult;
  });
