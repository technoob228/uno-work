import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Home's "AI plan limits": how much of the person's own Claude (Claude Code)
 * and ChatGPT (Codex) plan is used on this computer's sign-ins, read by the
 * daemon from the providers' usage endpoints with the CLIs' own tokens.
 *
 * A window has the shape of upstream T3 Code's `ServerProviderUsageWindow`
 * (providerUsageLimits.ts) — same ids (`five_hour`, `seven_day`,
 * `seven_day_<model>`, `primary`, `secondary`), kinds and fields — plus
 * `scope`, so a later port of upstream's Limits UI can take it as is.
 */
export const PlanLimitsWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
  /** The model or feature the window is for ("Opus"); absent for the whole plan. */
  scope: Schema.optional(TrimmedNonEmptyString),
});
export type PlanLimitsWindow = typeof PlanLimitsWindow.Type;

/**
 * Why the latest read gave no fresh numbers: the sign-in's token ran out and
 * only the CLI itself renews it (`expired`), the provider refused the token
 * (`rejected`), asked to wait (`busy`), couldn't be reached (`unreachable`),
 * or answered something unreadable (`unexpected`); or the Mac's Keychain
 * didn't hand over Claude Code's sign-in (`locked`).
 */
export const PlanLimitsProblem = Schema.Literals([
  "expired",
  "rejected",
  "busy",
  "unreachable",
  "unexpected",
  "locked",
]);
export type PlanLimitsProblem = typeof PlanLimitsProblem.Type;

export const PlanLimitsAccount = Schema.Struct({
  /** `claude:<email>` / `chatgpt:<email>` — stable across reads. */
  id: TrimmedNonEmptyString,
  provider: Schema.Literals(["claude", "chatgpt"]),
  /**
   * A second account on this computer (Settings → AI → "Use more than one
   * account"): the provider instance it signs in. Absent: the computer's main
   * sign-in.
   */
  instanceId: Schema.optional(TrimmedNonEmptyString),
  /** "Max 20x", "Pro", "Plus" — without the provider's name. */
  plan: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
  windows: Schema.Array(PlanLimitsWindow),
  /** When `windows` were read. Absent: never read on this computer. */
  checkedAt: Schema.optional(IsoDateTime),
  /** `windows` are the last known numbers, not from the latest read. */
  stale: Schema.optional(Schema.Boolean),
  problem: Schema.optional(PlanLimitsProblem),
});
export type PlanLimitsAccount = typeof PlanLimitsAccount.Type;

export const PlanLimitsInput = Schema.Struct({
  /**
   * Only which sign-ins this computer has (local files, nothing sent
   * anywhere); windows are the last known ones. For "is the widget available".
   */
  signInsOnly: Schema.optionalKey(Schema.Boolean),
});
export type PlanLimitsInput = typeof PlanLimitsInput.Type;

/** No accounts — no Claude Code or Codex sign-in on this computer. */
export const PlanLimits = Schema.Struct({
  accounts: Schema.Array(PlanLimitsAccount),
});
export type PlanLimits = typeof PlanLimits.Type;

/** "Resumes at 16:40 · Cancel": the chat stays stopped until the person goes on. */
export const PlanResumeCancelInput = Schema.Struct({
  threadId: ThreadId,
});
export type PlanResumeCancelInput = typeof PlanResumeCancelInput.Type;

export const PlanResumeCancelResult = Schema.Struct({
  cancelled: Schema.Boolean,
});
export type PlanResumeCancelResult = typeof PlanResumeCancelResult.Type;
