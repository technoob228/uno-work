/**
 * Skills shipped with Uno Work (the catalog in the web client's `skills/`
 * assets) and installed for every agent on the machine by the daemon.
 */
import { Schema } from "effect";

export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SkillId = Schema.String.check(Schema.isPattern(SKILL_ID_PATTERN));

export const SkillsStatusInput = Schema.Struct({
  ids: Schema.Array(SkillId).check(Schema.isMaxLength(64)),
});
export type SkillsStatusInput = typeof SkillsStatusInput.Type;

export const SkillsStatusResult = Schema.Struct({
  /** Of the asked ids, the ones installed for the agents. */
  installed: Schema.Array(SkillId),
  /** Every skill this daemon can install offline. */
  available: Schema.Array(SkillId),
});
export type SkillsStatusResult = typeof SkillsStatusResult.Type;

export const SkillsInstallInput = Schema.Struct({ id: SkillId });
export type SkillsInstallInput = typeof SkillsInstallInput.Type;

export const SkillsInstallResult = Schema.Struct({
  id: SkillId,
  /** Folders the skill was written to (one per agent family). */
  paths: Schema.Array(Schema.String),
});
export type SkillsInstallResult = typeof SkillsInstallResult.Type;

export class SkillsError extends Schema.TaggedErrorClass<SkillsError>()("SkillsError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

// ── Skills already on the computer, and skills of your own ───────────

/** Agents that read a skills folder (`uno` = Uno AI, our OpenCode-based harness). */
export const SkillAgent = Schema.Literals(["claude", "codex", "uno", "opencode", "hermes"]);
export type SkillAgent = typeof SkillAgent.Type;

/** `project` — inside the opened project; `computer` — for every project; `plugin` — a Claude Code plugin. */
export const FoundSkillScope = Schema.Literals(["project", "computer", "plugin"]);
export type FoundSkillScope = typeof FoundSkillScope.Type;

export const FoundSkill = Schema.Struct({
  /** `name:` from SKILL.md (the folder name when it has none). */
  name: Schema.String,
  description: Schema.String,
  scope: FoundSkillScope,
  /** Every folder it was found in (absolute), e.g. Claude's and Codex's copy. */
  paths: Schema.Array(Schema.String),
  /** Who reads it now. Empty = off, or a folder no agent loads (a `skills/` in the project). */
  agents: Schema.Array(SkillAgent),
  /**
   * On, or turned off on the setup step: the folders were moved to
   * `<skills folder>-off/` (files kept); for a plugin skill, the plugin is off.
   */
  enabled: Schema.Boolean,
  /** Agents that would read it but have it off in their own settings. */
  offIn: Schema.Array(SkillAgent),
  /** The Claude Code plugin it comes with: its name, and the id to turn it on or off. */
  plugin: Schema.optional(Schema.String),
  pluginId: Schema.optional(Schema.String),
});
export type FoundSkill = typeof FoundSkill.Type;

export const SkillsScanInput = Schema.Struct({
  /** The project folder to look in; without it only the computer's skills. */
  projectPath: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
});
export type SkillsScanInput = typeof SkillsScanInput.Type;

export const SkillsScanResult = Schema.Struct({ skills: Schema.Array(FoundSkill) });
export type SkillsScanResult = typeof SkillsScanResult.Type;

export const SKILL_UPLOAD_ID_PATTERN = /^[a-z0-9]{8,40}$/;
/** Largest archive one import takes (link or upload). */
export const SKILL_IMPORT_MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
/** One upload chunk, binary; ~4 MB of base64 per WebSocket message. */
export const SKILL_UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;

export const SkillsUploadChunkInput = Schema.Struct({
  uploadId: Schema.String.check(Schema.isPattern(SKILL_UPLOAD_ID_PATTERN)),
  /** Base64 of the next piece of a .zip. */
  chunk: Schema.String.check(Schema.isMaxLength(Math.ceil(SKILL_UPLOAD_CHUNK_BYTES / 3) * 4 + 4)),
  /** The first chunk starts a new file. */
  first: Schema.Boolean,
});
export type SkillsUploadChunkInput = typeof SkillsUploadChunkInput.Type;

export const SkillsUploadChunkResult = Schema.Struct({ bytes: Schema.Number });
export type SkillsUploadChunkResult = typeof SkillsUploadChunkResult.Type;

/** Where the skills to add come from. Nothing is installed or run yet. */
export const SkillsStageInput = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("link"),
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  }),
  Schema.Struct({
    source: Schema.Literal("upload"),
    uploadId: Schema.String.check(Schema.isPattern(SKILL_UPLOAD_ID_PATTERN)),
    /** What the person dropped, for the "From" line. */
    name: Schema.String.check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    source: Schema.Literal("folder"),
    /** A folder on this computer, e.g. a project's `skills/`. */
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  }),
]);
export type SkillsStageInput = typeof SkillsStageInput.Type;

export const StagedSkill = Schema.Struct({
  /** Pick key for `skills.add`. */
  key: Schema.String,
  /** The folder it will get: `name:` from SKILL.md, made safe. */
  name: Schema.String,
  description: Schema.String,
  /** Where it sits in the archive or repository ("" = the top). */
  location: Schema.String,
  files: Schema.Number,
  bytes: Schema.Number,
  /** Files an agent could run (.sh, .py, .js…). */
  scripts: Schema.Number,
});
export type StagedSkill = typeof StagedSkill.Type;

export const SkillsStageResult = Schema.Struct({
  token: Schema.String,
  /** "github.com/anthropics/skills · skills/pdf", "skills.zip". */
  sourceLabel: Schema.String,
  sourceUrl: Schema.optional(Schema.String),
  skills: Schema.Array(StagedSkill),
  /** SKILL.md files that aren't usable, and why. */
  skipped: Schema.Array(Schema.Struct({ location: Schema.String, reason: Schema.String })),
});
export type SkillsStageResult = typeof SkillsStageResult.Type;

export const SkillsAddInput = Schema.Struct({
  token: Schema.String.check(Schema.isMaxLength(64)),
  keys: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  /** `computer` = every project (all agents' home folders); `project` = only this one. */
  scope: Schema.Literals(["computer", "project"]),
  projectPath: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
});
export type SkillsAddInput = typeof SkillsAddInput.Type;

export const SkillsAddResult = Schema.Struct({
  added: Schema.Array(Schema.Struct({ name: Schema.String, paths: Schema.Array(Schema.String) })),
});
export type SkillsAddResult = typeof SkillsAddResult.Type;

export const SkillsSetEnabledInput = Schema.Struct({
  /** Folders from `FoundSkill.paths`; each must sit in a skills folder (or its `-off`). */
  paths: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  enabled: Schema.Boolean,
  /** The project the step is about, for skills inside it. */
  projectPath: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
});
export type SkillsSetEnabledInput = typeof SkillsSetEnabledInput.Type;

export const SkillsSetEnabledResult = Schema.Struct({
  /** Where the folders are now. */
  paths: Schema.Array(Schema.String),
});
export type SkillsSetEnabledResult = typeof SkillsSetEnabledResult.Type;

export const SkillsSetPluginEnabledInput = Schema.Struct({
  /** `name@marketplace`, as in Claude Code's `enabledPlugins`. */
  pluginId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  enabled: Schema.Boolean,
});
export type SkillsSetPluginEnabledInput = typeof SkillsSetPluginEnabledInput.Type;
