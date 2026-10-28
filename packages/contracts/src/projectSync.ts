/**
 * Project sync — "On all my computers": a project folder kept the same on
 * every computer of the person through their Uno cloud, and its keys kept in
 * the Uno vault (never in the synced files). The daemon of each computer
 * syncs its own projects; the client shows the status and the choices.
 *
 * @module ProjectSync
 */
import { Schema } from "effect";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * What a project row says:
 * - `off`: not on all computers;
 * - `synced` ✓, `syncing` ↻;
 * - `conflict` ⚠ — a file changed on two computers; the newer one is kept,
 *   the person may pick Keep mine / Keep theirs;
 * - `too-big`, `blocked`, `error`: needs the person (the message says why);
 * - `empty`: nothing to sync yet.
 */
export const ProjectSyncState = Schema.Literals([
  "off",
  "synced",
  "syncing",
  "conflict",
  "too-big",
  "blocked",
  "error",
  "empty",
]);
export type ProjectSyncState = typeof ProjectSyncState.Type;

export const ProjectSyncSide = Schema.Literals(["mine", "theirs"]);
export type ProjectSyncSide = typeof ProjectSyncSide.Type;

export const ProjectSyncConflict = Schema.Struct({
  files: Schema.Array(Schema.String),
  /** Which version is in the folder now, per file (the newer one). */
  kept: Schema.Record(Schema.String, ProjectSyncSide),
  /** The other computer's name, when known. */
  from: Schema.NullOr(Schema.String),
  at: Schema.String,
});
export type ProjectSyncConflict = typeof ProjectSyncConflict.Type;

export const ProjectSyncMode = Schema.Literals(["snapshot", "git"]);
export type ProjectSyncMode = typeof ProjectSyncMode.Type;

export const ProjectSyncEntry = Schema.Struct({
  projectId: ProjectId,
  enabled: Schema.Boolean,
  /** The name it has in the Uno cloud (same on every computer). */
  name: Schema.NullOr(Schema.String),
  mode: Schema.NullOr(ProjectSyncMode),
  state: ProjectSyncState,
  message: Schema.String,
  lastSyncedAt: Schema.NullOr(Schema.String),
  conflict: Schema.NullOr(ProjectSyncConflict),
});
export type ProjectSyncEntry = typeof ProjectSyncEntry.Type;

/** A project in the person's Uno cloud that isn't on this computer yet. */
export const ProjectSyncElsewhere = Schema.Struct({
  name: Schema.String,
  updatedAt: Schema.NullOr(Schema.String),
  /** The computer that saved it last, when known. */
  from: Schema.NullOr(Schema.String),
  mode: ProjectSyncMode,
});
export type ProjectSyncElsewhere = typeof ProjectSyncElsewhere.Type;

export const ProjectSyncSnapshot = Schema.Struct({
  /** False when this computer can't reach the person's Uno cloud (not signed in). */
  available: Schema.Boolean,
  unavailableReason: Schema.NullOr(Schema.String),
  projects: Schema.Array(ProjectSyncEntry),
  elsewhere: Schema.Array(ProjectSyncElsewhere),
});
export type ProjectSyncSnapshot = typeof ProjectSyncSnapshot.Type;

export const ProjectSyncProjectInput = Schema.Struct({ projectId: ProjectId });
export type ProjectSyncProjectInput = typeof ProjectSyncProjectInput.Type;

export const ProjectSyncSetEnabledInput = Schema.Struct({
  projectId: ProjectId,
  enabled: Schema.Boolean,
});
export type ProjectSyncSetEnabledInput = typeof ProjectSyncSetEnabledInput.Type;

export const ProjectSyncResolveInput = Schema.Struct({
  projectId: ProjectId,
  keep: Schema.Literals(["mine", "theirs", "dismiss"]),
});
export type ProjectSyncResolveInput = typeof ProjectSyncResolveInput.Type;

export const ProjectSyncGetHereInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type ProjectSyncGetHereInput = typeof ProjectSyncGetHereInput.Type;

export const ProjectSyncGetHereResult = Schema.Struct({
  projectId: ProjectId,
  entry: ProjectSyncEntry,
});
export type ProjectSyncGetHereResult = typeof ProjectSyncGetHereResult.Type;

/** A project key by name; values never cross to the client. */
export const ProjectSecretEntry = Schema.Struct({
  name: Schema.String,
  /** Kept in the Uno vault: travels with the project. */
  inVault: Schema.Boolean,
  /** In this computer's `.env` of the project. */
  inFile: Schema.Boolean,
});
export type ProjectSecretEntry = typeof ProjectSecretEntry.Type;

export const ProjectSecretsList = Schema.Struct({
  projectId: ProjectId,
  /** On all my computers: keys go to the vault too. */
  synced: Schema.Boolean,
  secrets: Schema.Array(ProjectSecretEntry),
  /** Why the vault couldn't be read (the file's keys are still listed). */
  vaultError: Schema.NullOr(Schema.String),
});
export type ProjectSecretsList = typeof ProjectSecretsList.Type;

export const ProjectSecretSetInput = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
});
export type ProjectSecretSetInput = typeof ProjectSecretSetInput.Type;

export const ProjectSecretRemoveInput = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type ProjectSecretRemoveInput = typeof ProjectSecretRemoveInput.Type;

/** The one line under every place keys are entered (decision 22.10). */
export const PROJECT_KEYS_LINE = "Keys travel with the project, never in its files.";

export class ProjectSyncError extends Schema.TaggedErrorClass<ProjectSyncError>()(
  "ProjectSyncError",
  { message: TrimmedNonEmptyString },
) {}
