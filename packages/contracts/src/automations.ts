import { Schema } from "effect";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

// ===============================
// Automations (28.10): an assistant's work on a schedule or on an event
// ===============================
//
// Automation = When (trigger) → Who (an assistant) → What (an instruction);
// the mode (Autonomous / Cautious) is the assistant's own.
//
// The Uno console keeps them (it is always on and can wake a sleeping
// computer): it runs the clock, receives GitHub's pull request events through
// the Uno GitHub App and queues events per computer. The daemon of the
// assistant's computer pulls the queue with its machine token, wakes the
// assistant with the event and reports the result. The web client talks to
// its daemon only (`/api/manager/automations*`).
//
// Contract: reports/day_2026-10-28/automations/CONTRACT.md.

export const AUTOMATION_NAME_MAX_CHARS = 80;
export const AUTOMATION_INSTRUCTION_MAX_CHARS = 2_000;
/** Thread a non-default assistant's automation turns run in (Uno: its main thread). */
export const AUTOMATION_THREAD_TITLE = "Automations";

/** Pull request actions an automation can react to. */
export const AutomationPullRequestAction = Schema.Literals([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
]);
export type AutomationPullRequestAction = typeof AutomationPullRequestAction.Type;

export const AUTOMATION_DEFAULT_PR_ACTIONS: ReadonlyArray<AutomationPullRequestAction> = [
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
];

export const AutomationScheduleTrigger = Schema.Struct({
  kind: Schema.Literal("schedule"),
  /** Five fields (`min hour day month weekday`); at most once an hour. */
  cron: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  /** IANA zone, e.g. `Europe/Berlin`. */
  timezone: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** The same in words, shown to the person: "Weekdays at 09:00". */
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type AutomationScheduleTrigger = typeof AutomationScheduleTrigger.Type;

export const AutomationPullRequestTrigger = Schema.Struct({
  kind: Schema.Literal("github.pull_request"),
  /** `owner/name`. */
  repo: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  actions: Schema.optional(Schema.Array(AutomationPullRequestAction)),
  /** Run on draft pull requests too. Default false (`ready_for_review` still runs). */
  drafts: Schema.optional(Schema.Boolean),
});
export type AutomationPullRequestTrigger = typeof AutomationPullRequestTrigger.Type;

/** The notes of a call the assistant's notetaker joined (local on the computer). */
export const AutomationCallEndedTrigger = Schema.Struct({
  kind: Schema.Literal("call.ended"),
});
export type AutomationCallEndedTrigger = typeof AutomationCallEndedTrigger.Type;

/** Reserved — the console answers TRIGGER_NOT_SUPPORTED_YET; the UI shows "Soon". */
export const AutomationGmailTrigger = Schema.Struct({
  kind: Schema.Literal("gmail.message"),
  from: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type AutomationGmailTrigger = typeof AutomationGmailTrigger.Type;

export const AutomationTrigger = Schema.Union([
  AutomationScheduleTrigger,
  AutomationPullRequestTrigger,
  AutomationCallEndedTrigger,
  AutomationGmailTrigger,
]);
export type AutomationTrigger = typeof AutomationTrigger.Type;
export type AutomationTriggerKind = AutomationTrigger["kind"];

export const AutomationStatus = Schema.Literals([
  "ok",
  "needs_github_repo",
  "needs_github_permission",
  "github_not_connected",
]);
export type AutomationStatus = typeof AutomationStatus.Type;

export const AutomationRunState = Schema.Literals([
  "queued",
  "waiting_wake",
  "running",
  "done",
  "failed",
  "skipped",
  "superseded",
  "expired",
]);
export type AutomationRunState = typeof AutomationRunState.Type;

export const AutomationRunKind = Schema.Literals([
  "schedule",
  "github.pull_request",
  "manual",
  "call.ended",
]);
export type AutomationRunKind = typeof AutomationRunKind.Type;

export const AutomationRun = Schema.Struct({
  id: PositiveInt,
  automationId: PositiveInt,
  kind: AutomationRunKind,
  /** "PR #12 · Fix login" / "Weekdays at 09:00" / "Run now". */
  title: Schema.String,
  url: Schema.NullOr(Schema.String),
  state: AutomationRunState,
  /** "limit" | "computer_asleep" | "newer push" | "computer was off" | an error. */
  reason: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  /** What went to the person (≤ 500 chars). */
  summary: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
});
export type AutomationRun = typeof AutomationRun.Type;

export const Automation = Schema.Struct({
  id: PositiveInt,
  boxId: PositiveInt,
  /** The assistant's project id on its computer ("assistant-home" = Uno). */
  assistant: Schema.String,
  assistantName: Schema.String,
  name: Schema.String,
  instruction: Schema.String,
  enabled: Schema.Boolean,
  trigger: AutomationTrigger,
  status: AutomationStatus,
  statusDetail: Schema.NullOr(Schema.String),
  /** Where on GitHub the person fixes the status (add the repo, accept a permission). */
  manageUrl: Schema.NullOr(Schema.String),
  nextRunAt: Schema.NullOr(Schema.String),
  lastRun: Schema.NullOr(AutomationRun),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Automation = typeof Automation.Type;

export const AutomationsUnavailableReason = Schema.Literals([
  /** A laptop: the console can't wake it — automations run on a cloud computer. */
  "not_cloud_computer",
  /** The console has automations off for this account (flag) or predates them. */
  "disabled",
  "console_unreachable",
]);
export type AutomationsUnavailableReason = typeof AutomationsUnavailableReason.Type;

/** `GET /api/manager/automations`. */
export const AutomationListResult = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.NullOr(AutomationsUnavailableReason),
  automations: Schema.Array(Automation),
  /**
   * The console's last word on automations for this account, remembered by
   * the daemon: true — switched on (a 2xx), false — AUTOMATIONS_DISABLED;
   * absent — never heard (a laptop, or not asked yet). Work shows anything
   * of Automations only where some computer says true (gating, 28.10).
   */
  consoleEnabled: Schema.optional(Schema.Boolean),
});
export type AutomationListResult = typeof AutomationListResult.Type;

/** `POST /api/manager/automations` (web) and `automation_create` (assistant). */
export const AutomationCreateInput = Schema.Struct({
  /** The assistant's project id. The assistant tool takes it from the caller's token instead. */
  assistant: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(AUTOMATION_NAME_MAX_CHARS))),
  instruction: TrimmedNonEmptyString.check(Schema.isMaxLength(AUTOMATION_INSTRUCTION_MAX_CHARS)),
  trigger: AutomationTrigger,
  enabled: Schema.optional(Schema.Boolean),
});
export type AutomationCreateInput = typeof AutomationCreateInput.Type;

/** `PATCH /api/manager/automations/:id`, `automation_update`. */
export const AutomationUpdateInput = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(AUTOMATION_NAME_MAX_CHARS))),
  instruction: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(AUTOMATION_INSTRUCTION_MAX_CHARS)),
  ),
  trigger: Schema.optional(AutomationTrigger),
});
export type AutomationUpdateInput = typeof AutomationUpdateInput.Type;

/** Codes the daemon answers with (the console's, passed through). */
export const AutomationErrorCode = Schema.Literals([
  "INVALID_TRIGGER",
  "GITHUB_NOT_CONNECTED",
  "GITHUB_REPO_NOT_ALLOWED",
  "GITHUB_NOT_ALLOWED_FOR_ASSISTANT",
  "GITHUB_PR_PERMISSION_MISSING",
  "TRIGGER_NOT_SUPPORTED_YET",
  "AUTOMATIONS_LIMIT",
  "AUTOMATIONS_DISABLED",
  "NOT_CLOUD_COMPUTER",
  "NO_OPEN_PR",
  "NOT_FOUND",
  "CONSOLE_UNREACHABLE",
]);
export type AutomationErrorCode = typeof AutomationErrorCode.Type;

export const AutomationError = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    manageUrl: Schema.optional(Schema.String),
    connectUrl: Schema.optional(Schema.String),
  }),
});
export type AutomationError = typeof AutomationError.Type;

/** `GET /api/manager/automations/:id/runs`. */
export const AutomationRunsResult = Schema.Struct({
  runs: Schema.Array(AutomationRun),
});
export type AutomationRunsResult = typeof AutomationRunsResult.Type;

/** `GET /api/manager/automations/github/repos?q=`. */
export const AutomationGithubReposResult = Schema.Struct({
  connected: Schema.Boolean,
  repos: Schema.Array(Schema.Struct({ fullName: Schema.String, private: Schema.Boolean })),
  /** Where to add a repository to the Uno GitHub app. */
  manageUrl: Schema.NullOr(Schema.String),
  /** The GitHub accounts the app is installed on, each with its own settings link. */
  accounts: Schema.optional(
    Schema.Array(Schema.Struct({ login: Schema.String, manageUrl: Schema.NullOr(Schema.String) })),
  ),
});
export type AutomationGithubReposResult = typeof AutomationGithubReposResult.Type;

/** `github_pr_comment` (uno-work tool; an outward step — Cautious waits for Allow). */
export const GithubPrCommentInput = Schema.Struct({
  repo: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  number: PositiveInt,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(60_000)),
});
export type GithubPrCommentInput = typeof GithubPrCommentInput.Type;

/** Simple schedule choices of the dialog → cron. */
export type AutomationCadence = "daily" | "weekdays" | "weekly" | "hourly";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** "09:00" + cadence (+ weekday 0–6 for weekly) → cron and its label. */
export function automationCronFor(input: {
  readonly cadence: AutomationCadence;
  readonly time: string;
  readonly weekday?: number;
}): { readonly cron: string; readonly label: string } {
  const [hRaw, mRaw] = input.time.split(":");
  const hour = Math.min(23, Math.max(0, Number.parseInt(hRaw ?? "9", 10) || 0));
  const minute = Math.min(59, Math.max(0, Number.parseInt(mRaw ?? "0", 10) || 0));
  const hhmm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  switch (input.cadence) {
    case "hourly":
      return {
        cron: `${minute} * * * *`,
        label: `Every hour at :${String(minute).padStart(2, "0")}`,
      };
    case "weekdays":
      return { cron: `${minute} ${hour} * * 1-5`, label: `Weekdays at ${hhmm}` };
    case "weekly": {
      const day = Math.min(6, Math.max(0, input.weekday ?? 1));
      return {
        cron: `${minute} ${hour} * * ${day}`,
        label: `Every ${WEEKDAY_NAMES[day]} at ${hhmm}`,
      };
    }
    case "daily":
      return { cron: `${minute} ${hour} * * *`, label: `Every day at ${hhmm}` };
  }
}

/** The trigger in words, for cards and the chat ("When a pull request opens or updates in owner/x"). */
export function describeAutomationTrigger(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case "schedule":
      return trigger.label;
    case "github.pull_request":
      return `When a pull request opens or updates in ${trigger.repo}`;
    case "call.ended":
      return "After each call it joins";
    case "gmail.message":
      return trigger.from ? `When an email arrives from ${trigger.from}` : "When an email arrives";
  }
}
