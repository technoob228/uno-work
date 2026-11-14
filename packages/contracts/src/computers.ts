/**
 * Computers lifecycle (Misha 02.11, reports/day_2026-11-02/computers-lifecycle/
 * SPEC.md and CONTRACT.md): what each of the person's own computers is for, the
 * work found on it and brought over, a folder on it as a project of the cloud
 * computer ("brain in the cloud": the chat runs here, its commands and files
 * there), and continuing a chat in the cloud.
 *
 * Next to "Connect my computer" (myComputer.ts), which pairs the computer and
 * gives agents their tools on it. A computer this module knows nothing about is
 * a tool for agents.
 *
 * @module Computers
 */
import { Schema } from "effect";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const ComputerIdInput = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/** "tool": agents run commands and read files there. "full": chats start on it too. */
export const ComputerPurpose = Schema.Literals(["tool", "full"]);
export type ComputerPurpose = typeof ComputerPurpose.Type;

export const ComputerPurposeEntry = Schema.Struct({
  computerId: TrimmedNonEmptyString,
  purpose: ComputerPurpose,
});
export type ComputerPurposeEntry = typeof ComputerPurposeEntry.Type;

export const ComputersState = Schema.Struct({
  /** The flag COMPUTERS_LIFECYCLE for this account (console) or this computer (env). */
  lifecycle: Schema.Boolean,
  /** A computer missing here is a tool for agents. */
  purposes: Schema.Array(ComputerPurposeEntry),
});
export type ComputersState = typeof ComputersState.Type;

export const ComputersSetPurposeInput = Schema.Struct({
  computerId: ComputerIdInput,
  purpose: ComputerPurpose,
});
export type ComputersSetPurposeInput = typeof ComputersSetPurposeInput.Type;

export const ComputerInput = Schema.Struct({ computerId: ComputerIdInput });
export type ComputerInput = typeof ComputerInput.Type;

/** A project folder found on the computer. Key names only — never a value. */
export const FoundProject = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** Absolute, on the computer. */
  path: TrimmedNonEmptyString,
  /** For people: "~/projects/landing". */
  displayPath: Schema.String,
  git: Schema.Boolean,
  /** Names from the folder's `.env` and `.env.local` (never a value). */
  keys: Schema.Array(Schema.String),
  /** A chat found on the computer ran in it. */
  fromChats: Schema.Boolean,
  /** Already on all the person's computers. */
  synced: Schema.Boolean,
});
export type FoundProject = typeof FoundProject.Type;

export const ComputerWorkScan = Schema.Struct({
  state: Schema.Literals(["idle", "scanning", "ready", "failed"]),
  message: Schema.NullOr(Schema.String),
  scannedAt: Schema.NullOr(Schema.String),
  /** The computer's home folder, absolute. */
  home: Schema.NullOr(Schema.String),
  projects: Schema.Array(FoundProject),
});
export type ComputerWorkScan = typeof ComputerWorkScan.Type;

export const ComputerBringResult = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  ok: Schema.Boolean,
  keysSaved: NonNegativeInt,
  message: Schema.NullOr(Schema.String),
  /**
   * The Work project it became here, once copied (13.11: setup opens a chat
   * in it). Set even when `ok` is false for "On all my computers" only — the
   * folder is there. Older daemons don't send it.
   */
  projectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
  /** The folder here, absolute. Older daemons don't send it. */
  folder: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ComputerBringResult = typeof ComputerBringResult.Type;

export const ComputerWorkBring = Schema.Struct({
  state: Schema.Literals(["idle", "running", "done", "failed"]),
  done: NonNegativeInt,
  total: NonNegativeInt,
  message: Schema.NullOr(Schema.String),
  results: Schema.Array(ComputerBringResult),
});
export type ComputerWorkBring = typeof ComputerWorkBring.Type;

export const ComputerWorkStatus = Schema.Struct({
  computerId: TrimmedNonEmptyString,
  scan: ComputerWorkScan,
  bring: ComputerWorkBring,
});
export type ComputerWorkStatus = typeof ComputerWorkStatus.Type;

export const ComputersBringWorkInput = Schema.Struct({
  computerId: ComputerIdInput,
  projects: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
      /** The keys to keep (names); the others aren't read at all. */
      keys: Schema.Array(Schema.String.check(Schema.isMaxLength(256))),
    }),
  ).check(Schema.isMaxLength(200)),
});
export type ComputersBringWorkInput = typeof ComputersBringWorkInput.Type;

export const ComputersOpenFolderInput = Schema.Struct({
  computerId: ComputerIdInput,
  /** Absolute on the computer, or "~" for its home folder. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type ComputersOpenFolderInput = typeof ComputersOpenFolderInput.Type;

export const ComputersOpenFolderResult = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
});
export type ComputersOpenFolderResult = typeof ComputersOpenFolderResult.Type;

export const ComputersContinueInCloudInput = Schema.Struct({ threadId: ThreadId });
export type ComputersContinueInCloudInput = typeof ComputersContinueInCloudInput.Type;

export const ComputersContinueInCloudResult = Schema.Struct({ threadId: ThreadId });
export type ComputersContinueInCloudResult = typeof ComputersContinueInCloudResult.Type;
