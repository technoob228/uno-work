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
