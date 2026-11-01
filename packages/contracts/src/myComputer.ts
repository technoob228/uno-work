/**
 * "Connect my computer": the person's own laptop or desktop as a tool of the
 * cloud agent. A small helper on that computer keeps an outgoing tunnel to the
 * Uno console; this daemon reaches it through the console, so a sleeping cloud
 * computer is never woken by the laptop.
 *
 * What the client sees: which computers are connected, the pairing (a command
 * to paste into a terminal), disconnecting, and the journal of what agents did.
 * Running commands and touching files is for agents only (`my_computer_*`
 * tools, through the approval gate), never an RPC. The one exception reads, and
 * only session files: importing chats from the computer, which the person starts.
 *
 * Absent `settings.uno.boxToken` (a desktop app on a laptop) the feature is off:
 * `status` answers `{ enabled: false, computers: [] }`.
 *
 * @module MyComputer
 */
import { Schema } from "effect";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ImportedChatTool } from "./orchestration.ts";

export const MyComputer = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  /** `darwin`, `linux`, `windows`: what the helper reported. */
  os: Schema.String,
  arch: Schema.String,
  /** The tunnel is up now. False: asleep, closed or without a network. */
  online: Schema.Boolean,
  connectedAt: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.NullOr(Schema.String),
  helperVersion: Schema.NullOr(Schema.String),
});
export type MyComputer = typeof MyComputer.Type;

export const MyComputerStatus = Schema.Struct({
  /** False: no console access here, or the account doesn't have the feature. */
  enabled: Schema.Boolean,
  computers: Schema.Array(MyComputer),
});
export type MyComputerStatus = typeof MyComputerStatus.Type;

export const MyComputerPairCommands = Schema.Struct({
  mac: Schema.String,
  linux: Schema.String,
  windows: Schema.String,
});
export type MyComputerPairCommands = typeof MyComputerPairCommands.Type;

export const MyComputerPairing = Schema.Struct({
  /** Shown as `7KQ2-M9XD`; lives 15 minutes, works once. */
  code: TrimmedNonEmptyString,
  url: Schema.String,
  commands: MyComputerPairCommands,
  expiresAt: Schema.String,
});
export type MyComputerPairing = typeof MyComputerPairing.Type;

export const MyComputerPairState = Schema.Literals(["waiting", "claimed", "failed", "expired"]);
export type MyComputerPairState = typeof MyComputerPairState.Type;

export const MyComputerPairStatusInput = Schema.Struct({
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
});
export type MyComputerPairStatusInput = typeof MyComputerPairStatusInput.Type;

export const MyComputerPairStatus = Schema.Struct({
  state: MyComputerPairState,
  /** The install step the helper reported last. */
  step: Schema.NullOr(Schema.String),
  /** Plain text from the computer (a failure's reason): show it, never run it. */
  message: Schema.NullOr(Schema.String),
  computerId: Schema.NullOr(Schema.String),
});
export type MyComputerPairStatus = typeof MyComputerPairStatus.Type;

export const MyComputerDisconnectInput = Schema.Struct({
  computerId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type MyComputerDisconnectInput = typeof MyComputerDisconnectInput.Type;

export const MyComputerActivityKind = Schema.Literals(["run", "read", "write", "list"]);
export type MyComputerActivityKind = typeof MyComputerActivityKind.Type;

export const MyComputerActivityInput = Schema.Struct({
  computerId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** Newest first; 50 by default, 500 at most. */
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
export type MyComputerActivityInput = typeof MyComputerActivityInput.Type;

/** One thing an agent did. Never a file's content or a command's output. */
export const MyComputerActivityEntry = Schema.Struct({
  /** ISO-8601. */
  at: Schema.String,
  kind: MyComputerActivityKind,
  /** A short line: a clipped command or a path, secrets masked. */
  summary: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
});
export type MyComputerActivityEntry = typeof MyComputerActivityEntry.Type;

export const MyComputerActivity = Schema.Array(MyComputerActivityEntry);
export type MyComputerActivity = typeof MyComputerActivity.Type;

export class MyComputerError extends Schema.TaggedErrorClass<MyComputerError>()("MyComputerError", {
  message: TrimmedNonEmptyString,
}) {}

// ── Importing chats from a computer ────────────────────────────────────

export const MyComputerImportTool = Schema.Struct({
  id: ImportedChatTool,
  name: TrimmedNonEmptyString,
  chats: NonNegativeInt,
  /** Chats a new import would bring: not imported before. */
  newChats: NonNegativeInt,
  projects: NonNegativeInt,
  available: Schema.Boolean,
  unavailableReason: Schema.NullOr(Schema.String),
});
export type MyComputerImportTool = typeof MyComputerImportTool.Type;

export const MyComputerImportStatus = Schema.Struct({
  computerId: TrimmedNonEmptyString,
  state: Schema.Literals(["idle", "scanning", "ready", "importing", "done", "failed"]),
  /** The person said no: the offer doesn't come up by itself again. */
  declined: Schema.Boolean,
  tools: Schema.Array(MyComputerImportTool),
  /** Apps found next to the tools, by name. */
  alsoFound: Schema.Array(Schema.String),
  skipped: Schema.Struct({ unreadable: NonNegativeInt, unknownFormat: NonNegativeInt }),
  scanned: Schema.Struct({ done: NonNegativeInt, total: NonNegativeInt }),
  progress: Schema.Struct({ done: NonNegativeInt, total: NonNegativeInt }),
  result: Schema.NullOr(
    Schema.Struct({
      imported: NonNegativeInt,
      recent: NonNegativeInt,
      snoozed: NonNegativeInt,
      failed: NonNegativeInt,
    }),
  ),
  importedChats: NonNegativeInt,
  importedProjects: NonNegativeInt,
  message: Schema.NullOr(Schema.String),
});
export type MyComputerImportStatus = typeof MyComputerImportStatus.Type;

export const MyComputerChatMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: Schema.String,
});
export type MyComputerChatMessage = typeof MyComputerChatMessage.Type;

/** What opening an imported chat found. `stale`: the copy from the last time. */
export const MyComputerChatHistory = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ready"),
    messages: Schema.Array(MyComputerChatMessage),
    truncated: Schema.Boolean,
    stale: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("offline"), computerName: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("gone") }),
  Schema.Struct({ kind: Schema.Literal("failed"), message: Schema.String }),
]);
export type MyComputerChatHistory = typeof MyComputerChatHistory.Type;

export const MyComputerImportInput = Schema.Struct({ computerId: TrimmedNonEmptyString });
export type MyComputerImportInput = typeof MyComputerImportInput.Type;

export const MyComputerImportStartInput = Schema.Struct({
  computerId: TrimmedNonEmptyString,
  tools: Schema.Array(ImportedChatTool),
});
export type MyComputerImportStartInput = typeof MyComputerImportStartInput.Type;

export const MyComputerChatHistoryInput = Schema.Struct({ threadId: ThreadId });
export type MyComputerChatHistoryInput = typeof MyComputerChatHistoryInput.Type;
