/**
 * Automations as this computer sees them: a thin client over the console's
 * `/api/v1/boxes/{id}/work/automations*` and `/work/git/github/{repos,pr-comment}`
 * routes, called with the machine's own token (`settings.uno.boxToken`).
 *
 * The console keeps automations and runs them (it is always on and can wake
 * this computer); the daemon lists / changes them for the web and the
 * assistant tools, pulls the queue of events and reports results.
 *
 * The console speaks snake_case, Work camelCase (`@t3tools/contracts`
 * `automations.ts`): every answer is translated here, leniently — a field the
 * console adds later is ignored, a missing one gets its empty value.
 *
 * Contract: reports/day_2026-10-28/automations/CONTRACT.md.
 *
 * @module automations/consoleClient
 */
import type {
  Automation,
  AutomationExecutor,
  AutomationGithubReposResult,
  AutomationHook,
  AutomationListResult,
  AutomationRun,
  AutomationRunKind,
  AutomationRunState,
  AutomationStatus,
  AutomationTrigger,
  AutomationUpdateInput,
  AutomationsUnavailableReason,
} from "@t3tools/contracts";
import { Data, Effect } from "effect";

import {
  callMachineConsole,
  type FetchLike,
  type WorkConsoleResponse,
  type WorkMachineIdentity,
} from "../manager/workConsole.ts";

// ── Errors ─────────────────────────────────────────────────────────────

/** A refusal or failure with the console's code and a line a person can read. */
export class AutomationClientError extends Data.TaggedError("AutomationClientError")<{
  /** HTTP status the daemon answers with (the console's, 502 when unreachable). */
  readonly status: number;
  /** `AutomationErrorCode`, or the console's own code when it is a new one. */
  readonly code: string;
  readonly message: string;
  /** Where on GitHub the person fixes it (add the repo, accept a permission). */
  readonly manageUrl?: string;
  /** Where the person connects GitHub. */
  readonly connectUrl?: string;
}> {}

/** The `{error:{code, message, manageUrl?, connectUrl?}}` the daemon answers with. */
export function automationErrorBody(error: AutomationClientError) {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.manageUrl ? { manageUrl: error.manageUrl } : {}),
      ...(error.connectUrl ? { connectUrl: error.connectUrl } : {}),
    },
  };
}

export const NOT_CLOUD_COMPUTER_MESSAGE =
  "Automations run on an Uno cloud computer: this one isn't linked to the Uno console (a laptop sleeps, the console can't wake it).";

export const notCloudComputerError = () =>
  new AutomationClientError({
    status: 409,
    code: "NOT_CLOUD_COMPUTER",
    message: NOT_CLOUD_COMPUTER_MESSAGE,
  });

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

/** github.com links only: a manage / connect link we show the person. */
function githubUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (raw === null) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      (url.hostname === "github.com" || url.hostname.endsWith(".github.com"))
      ? raw
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The console's error answer: `{error: CODE, code: CODE, detail, manage_url?}`
 * (fishcode `writeConnectorError`), or `{error: {code, message}}`.
 */
export function readConsoleError(body: unknown): {
  readonly code: string | null;
  readonly detail: string | null;
  readonly manageUrl: string | undefined;
  readonly connectUrl: string | undefined;
} {
  const top = record(body);
  const nested = record(top?.["error"]);
  const code = text(top?.["code"]) ?? text(nested?.["code"]) ?? text(top?.["error"]);
  const detail =
    text(top?.["detail"]) ??
    text(top?.["message"]) ??
    text(nested?.["message"]) ??
    text(nested?.["detail"]);
  return {
    code,
    detail,
    manageUrl: githubUrl(
      top?.["manage_url"] ?? top?.["manageUrl"] ?? nested?.["manage_url"] ?? nested?.["manageUrl"],
    ),
    connectUrl: githubUrl(
      top?.["connect_url"] ??
        top?.["authorize_url"] ??
        nested?.["connect_url"] ??
        nested?.["connectUrl"],
    ),
  };
}

/** A line a person (and the assistant) can act on, for every console code we know. */
export function automationErrorMessage(
  code: string,
  detail: string | null,
  links: { readonly manageUrl?: string | undefined; readonly connectUrl?: string | undefined } = {},
): string {
  const said = detail ? ` (${detail})` : "";
  switch (code) {
    case "INVALID_TRIGGER":
      return `The "when" isn't right${said}. A schedule is a five-field cron (minute hour day month weekday, at most once an hour) with an IANA time zone like Europe/Berlin; a repository is owner/name.`;
    case "GITHUB_NOT_CONNECTED":
      return links.connectUrl
        ? `GitHub isn't connected to this Uno account yet: connect it once — ${links.connectUrl}.`
        : "GitHub isn't connected to this Uno account yet.";
    case "GITHUB_REPO_NOT_ALLOWED":
      return `Uno's GitHub app can't see this repository${said}. Add it on GitHub${links.manageUrl ? `: ${links.manageUrl}` : " (the Uno app's settings)"}.`;
    case "GITHUB_NOT_ALLOWED_FOR_ASSISTANT":
      return "This computer isn't allowed to use GitHub (the person's choice in the Uno console, Settings → Computer access).";
    case "GITHUB_PR_PERMISSION_MISSING":
      return `GitHub needs one more permission for Uno to comment on pull requests: accept it on GitHub${links.manageUrl ? ` — ${links.manageUrl}` : ""}.`;
    case "TRIGGER_NOT_SUPPORTED_YET":
      return "That kind of automation is coming soon (new emails). For now: on a schedule, when a pull request opens or updates, after a call, by webhook or from a site's form.";
    case "HOOKS_DISABLED":
      return "Webhooks and site forms aren't switched on for this Uno account yet.";
    case "NOT_RUNNABLE":
      return "This one runs when its URL is called or its form is sent, not by hand.";
    case "SITE_FORM_TAKEN":
      return "This site's form was being set up at the same moment. Try again.";
    case "AUTOMATIONS_LIMIT":
      return `The account already has as many automations as it may${said}. Delete one first.`;
    case "AUTOMATIONS_DISABLED":
      return "Automations aren't switched on for this Uno account yet.";
    case "NOT_CLOUD_COMPUTER":
      return NOT_CLOUD_COMPUTER_MESSAGE;
    case "NO_OPEN_PR":
      return "There's no open pull request in that repository to run it on right now.";
    case "NOT_FOUND":
      return "That automation doesn't exist (any more).";
    case "CONSOLE_UNREACHABLE":
      return `The Uno console didn't answer${said}. Try again in a minute.`;
    default:
      return `The Uno console refused${said || ` (${code})`}.`;
  }
}

/** Any non-2xx console answer → the error the daemon passes on. */
export function consoleRefusal(response: WorkConsoleResponse): AutomationClientError {
  const parsed = readConsoleError(response.body);
  let code = parsed.code ?? "";
  if (response.status === 401) {
    return new AutomationClientError({
      status: 409,
      code: "NOT_CLOUD_COMPUTER",
      message:
        "This computer isn't signed in to the Uno console any more, so it can't reach automations. Open Uno Work from the Uno console once.",
    });
  }
  // A console from before automations (or with the flag off) answers a bare 404.
  if (response.status === 404 && (code === "" || code === "NOT_FOUND")) {
    code = code === "NOT_FOUND" ? "NOT_FOUND" : "AUTOMATIONS_DISABLED";
  }
  if (code === "")
    code = response.status >= 500 ? "CONSOLE_UNREACHABLE" : `HTTP_${response.status}`;
  return new AutomationClientError({
    status: response.status >= 500 ? 502 : response.status,
    code,
    message: automationErrorMessage(code, parsed.detail, parsed),
    ...(parsed.manageUrl ? { manageUrl: parsed.manageUrl } : {}),
    ...(parsed.connectUrl ? { connectUrl: parsed.connectUrl } : {}),
  });
}

const unreachable = (message: string) =>
  new AutomationClientError({
    status: 502,
    code: "CONSOLE_UNREACHABLE",
    message: automationErrorMessage("CONSOLE_UNREACHABLE", message),
  });

// ── snake_case → camelCase ─────────────────────────────────────────────

const positiveInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

const nullableText = (value: unknown): string | null => (typeof value === "string" ? value : null);

const STATUSES: ReadonlySet<string> = new Set<AutomationStatus>([
  "ok",
  "needs_github_repo",
  "needs_github_permission",
  "github_not_connected",
]);
const RUN_STATES: ReadonlySet<string> = new Set<AutomationRunState>([
  "queued",
  "waiting_wake",
  "running",
  "done",
  "failed",
  "skipped",
  "superseded",
  "expired",
]);
const RUN_KINDS: ReadonlySet<string> = new Set<AutomationRunKind>([
  "schedule",
  "github.pull_request",
  "manual",
  "call.ended",
  "webhook",
  "site.form",
]);

/** The console's trigger (its keys are one word, so the same in both cases). */
export function parseTrigger(raw: unknown): AutomationTrigger | null {
  const r = record(raw);
  switch (r?.["kind"]) {
    case "schedule": {
      const cron = text(r["cron"]);
      const timezone = text(r["timezone"]) ?? "UTC";
      if (cron === null) return null;
      return { kind: "schedule", cron, timezone, label: text(r["label"]) ?? cron };
    }
    case "github.pull_request": {
      const repo = text(r["repo"]);
      if (repo === null) return null;
      const actions = Array.isArray(r["actions"])
        ? r["actions"].filter(
            (a): a is "opened" | "reopened" | "synchronize" | "ready_for_review" =>
              a === "opened" || a === "reopened" || a === "synchronize" || a === "ready_for_review",
          )
        : undefined;
      return {
        kind: "github.pull_request",
        repo,
        ...(actions !== undefined ? { actions } : {}),
        ...(typeof r["drafts"] === "boolean" ? { drafts: r["drafts"] } : {}),
      };
    }
    case "call.ended":
      return { kind: "call.ended" };
    case "gmail.message": {
      const from = text(r["from"]);
      return { kind: "gmail.message", ...(from !== null ? { from } : {}) };
    }
    case "webhook":
      return {
        kind: "webhook",
        ...(typeof r["ask"] === "boolean" ? { ask: r["ask"] } : {}),
        ...(typeof r["require_signature"] === "boolean"
          ? { requireSignature: r["require_signature"] }
          : {}),
      };
    case "site.form": {
      const slug = text(r["slug"]);
      if (slug === null) return null;
      return {
        kind: "site.form",
        slug,
        ...(typeof r["ask"] === "boolean" ? { ask: r["ask"] } : {}),
      };
    }
    default:
      return null;
  }
}

/** The console's executor (snake_case) → Work's; absent or unknown → the assistant. */
export function parseExecutor(raw: unknown): AutomationExecutor {
  const r = record(raw);
  const title = text(r?.["title"]);
  switch (r?.["kind"]) {
    case "chat": {
      const threadId = text(r["thread_id"]);
      if (threadId !== null) return { kind: "chat", threadId, ...(title ? { title } : {}) };
      break;
    }
    case "new_chat": {
      const projectId = text(r["project_id"]);
      const fromThreadId = text(r["from_thread_id"]);
      if (projectId !== null) {
        return {
          kind: "new_chat",
          projectId,
          ...(fromThreadId ? { fromThreadId } : {}),
          ...(title ? { title } : {}),
        };
      }
      break;
    }
  }
  return { kind: "assistant" };
}

/** Work's executor → the console's body. */
export function executorToConsole(executor: AutomationExecutor): Record<string, unknown> {
  switch (executor.kind) {
    case "assistant":
      return { kind: "assistant" };
    case "chat":
      return {
        kind: "chat",
        thread_id: executor.threadId,
        ...(executor.title ? { title: executor.title } : {}),
      };
    case "new_chat":
      return {
        kind: "new_chat",
        project_id: executor.projectId,
        ...(executor.fromThreadId ? { from_thread_id: executor.fromThreadId } : {}),
        ...(executor.title ? { title: executor.title } : {}),
      };
  }
}

/** The console's name for `requireSignature`; the other keys are one word. */
export function triggerToConsole(trigger: AutomationTrigger): Record<string, unknown> {
  if (trigger.kind !== "webhook") return { ...trigger };
  const { requireSignature, ...rest } = trigger;
  return {
    ...rest,
    ...(requireSignature !== undefined ? { require_signature: requireSignature } : {}),
  };
}

export function parseRun(raw: unknown): AutomationRun | null {
  const r = record(raw);
  const id = positiveInt(r?.["id"]);
  const automationId = positiveInt(r?.["automation_id"]);
  if (r === null || id === null || automationId === null) return null;
  const state = typeof r["state"] === "string" && RUN_STATES.has(r["state"]) ? r["state"] : null;
  const kind = typeof r["kind"] === "string" && RUN_KINDS.has(r["kind"]) ? r["kind"] : "manual";
  return {
    id,
    automationId,
    kind: kind as AutomationRunKind,
    title: nullableText(r["title"]) ?? "",
    url: text(r["url"]),
    state: (state ?? "queued") as AutomationRunState,
    reason: text(r["reason"]),
    threadId: text(r["thread_id"]),
    summary: text(r["summary"]),
    createdAt: nullableText(r["created_at"]) ?? "",
    startedAt: text(r["started_at"]),
    finishedAt: text(r["finished_at"]),
  };
}

export function parseAutomation(raw: unknown): Automation | null {
  const r = record(raw);
  const id = positiveInt(r?.["id"]);
  const trigger = parseTrigger(r?.["trigger"]);
  if (r === null || id === null || trigger === null) return null;
  const status = typeof r["status"] === "string" && STATUSES.has(r["status"]) ? r["status"] : "ok";
  return {
    id,
    boxId: positiveInt(r["box_id"]) ?? 1,
    assistant: nullableText(r["assistant"]) ?? "",
    assistantName: nullableText(r["assistant_name"]) ?? "",
    name: nullableText(r["name"]) ?? "",
    instruction: nullableText(r["instruction"]) ?? "",
    enabled: r["enabled"] !== false,
    trigger,
    executor: parseExecutor(r["executor"]),
    status: status as AutomationStatus,
    statusDetail: text(r["status_detail"]),
    manageUrl: githubUrl(r["manage_url"]) ?? null,
    nextRunAt: text(r["next_run_at"]),
    lastRun: parseRun(r["last_run"]),
    createdAt: nullableText(r["created_at"]) ?? "",
    updatedAt: nullableText(r["updated_at"]) ?? "",
  };
}

export function parseAutomationList(body: unknown): ReadonlyArray<Automation> {
  const list = record(body)?.["automations"];
  if (!Array.isArray(list)) return [];
  return list.map(parseAutomation).filter((a): a is Automation => a !== null);
}

/** An event of the queue as the console hands it to this computer. */
export interface AutomationEvent {
  readonly id: number;
  readonly automationId: number;
  readonly assistant: string;
  readonly assistantName: string;
  readonly name: string;
  readonly instruction: string;
  /** Who runs it (an older console: the assistant). */
  readonly executor: AutomationExecutor;
  readonly kind: AutomationRunKind;
  readonly title: string;
  readonly url: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export function parseEvent(raw: unknown): AutomationEvent | null {
  const r = record(raw);
  const id = positiveInt(r?.["id"]);
  const automationId = positiveInt(r?.["automation_id"]);
  if (r === null || id === null || automationId === null) return null;
  const kind = typeof r["kind"] === "string" && RUN_KINDS.has(r["kind"]) ? r["kind"] : "manual";
  return {
    id,
    automationId,
    assistant: nullableText(r["assistant"]) ?? "",
    assistantName: nullableText(r["assistant_name"]) ?? "",
    name: nullableText(r["name"]) ?? "",
    instruction: nullableText(r["instruction"]) ?? "",
    executor: parseExecutor(r["executor"]),
    kind: kind as AutomationRunKind,
    title: nullableText(r["title"]) ?? "",
    url: text(r["url"]),
    payload: record(r["payload"]) ?? {},
    createdAt: nullableText(r["created_at"]) ?? "",
  };
}

export function parseHook(body: unknown): AutomationHook | null {
  const r = record(body);
  const url = text(r?.["url"]);
  const signingSecret = text(r?.["signing_secret"]);
  if (r === null || url === null || signingSecret === null) return null;
  return {
    url,
    signingSecret,
    requireSignature: r["require_signature"] === true,
    perMinute: positiveInt(r["per_minute"]) ?? 60,
    maxBodyBytes: positiveInt(r["max_body_bytes"]) ?? 0,
  };
}

export function parseEvents(body: unknown): ReadonlyArray<AutomationEvent> {
  const list = record(body)?.["events"];
  if (!Array.isArray(list)) return [];
  return list.map(parseEvent).filter((e): e is AutomationEvent => e !== null);
}

export function parseRepos(body: unknown): AutomationGithubReposResult["repos"] {
  const list = record(body)?.["repos"];
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const r = record(raw);
    const fullName = text(r?.["full_name"]) ?? text(r?.["fullName"]);
    return fullName === null ? [] : [{ fullName, private: r?.["private"] === true }];
  });
}

/** The GitHub accounts the Uno app is installed on, each with its own settings link. */
export function parseRepoAccounts(
  body: unknown,
): ReadonlyArray<{ readonly login: string; readonly manageUrl: string | null }> {
  const list = record(body)?.["accounts"];
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const r = record(raw);
    const login = text(r?.["login"]);
    return login === null ? [] : [{ login, manageUrl: githubUrl(r?.["manage_url"]) ?? null }];
  });
}

/**
 * Where "Add it on GitHub" goes: the settings of the account that owns the
 * repository the person typed (`owner/…`), else the only account's, else
 * the console's general link.
 */
export function repoManageUrl(
  body: unknown,
  accounts: ReadonlyArray<{ readonly login: string; readonly manageUrl: string | null }>,
  query: string,
): string | null {
  const owner = query.trim().includes("/") ? query.trim().split("/")[0]!.toLowerCase() : null;
  const own =
    owner !== null ? accounts.find((account) => account.login.toLowerCase() === owner) : undefined;
  const only = accounts.length === 1 ? accounts[0] : undefined;
  return (
    own?.manageUrl ??
    only?.manageUrl ??
    githubUrl(record(body)?.["manage_url"]) ??
    accounts.find((account) => account.manageUrl !== null)?.manageUrl ??
    null
  );
}

// ── camelCase → snake_case ─────────────────────────────────────────────

export interface AutomationCreateBody {
  readonly assistant: string;
  readonly assistantName: string;
  readonly name: string;
  readonly instruction: string;
  readonly trigger: AutomationTrigger;
  readonly executor?: AutomationExecutor | undefined;
  readonly enabled?: boolean | undefined;
}

export function createBodyToConsole(input: AutomationCreateBody): Record<string, unknown> {
  return {
    assistant: input.assistant,
    assistant_name: input.assistantName,
    name: input.name,
    instruction: input.instruction,
    trigger: triggerToConsole(input.trigger),
    ...(input.executor !== undefined ? { executor: executorToConsole(input.executor) } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  };
}

export function updateBodyToConsole(
  input: AutomationUpdateInput & { readonly assistantName?: string | undefined },
): Record<string, unknown> {
  return {
    ...(input.assistantName !== undefined ? { assistant_name: input.assistantName } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
    ...(input.trigger !== undefined ? { trigger: triggerToConsole(input.trigger) } : {}),
    ...(input.executor !== undefined ? { executor: executorToConsole(input.executor) } : {}),
  };
}

export interface AutomationResultBody {
  readonly state: "done" | "failed" | "skipped";
  readonly summary?: string | null;
  readonly threadId?: string | null;
  readonly reason?: string | null;
}

/** Summaries and reasons are clipped to what the console keeps (≤ 500). */
export function clip(value: string, max = 500): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function resultBodyToConsole(input: AutomationResultBody): Record<string, unknown> {
  return {
    state: input.state,
    ...(input.summary ? { summary: clip(input.summary) } : {}),
    ...(input.threadId ? { thread_id: input.threadId } : {}),
    ...(input.reason ? { reason: clip(input.reason) } : {}),
  };
}

// ── Client ─────────────────────────────────────────────────────────────

export interface AutomationsClientDeps {
  /** This computer's identity on the console; null off a cloud computer. */
  readonly identity: Effect.Effect<WorkMachineIdentity | null>;
  readonly fetchImpl?: FetchLike;
}

export type ClaimOutcome = "claimed" | "already_claimed";

export interface AutomationsClient {
  /** Never fails: an unavailable console is an answer (`available: false`). */
  readonly list: Effect.Effect<AutomationListResult>;
  /**
   * The console's last word on automations for this account (gating, 28.10):
   * true after a 2xx of an automations route, false after
   * AUTOMATIONS_DISABLED, null — never heard (a laptop, not asked yet). A
   * console that didn't answer changes nothing.
   */
  readonly consoleEnabled: () => boolean | null;
  readonly create: (
    input: AutomationCreateBody,
  ) => Effect.Effect<Automation, AutomationClientError>;
  readonly update: (
    id: number,
    /** `assistantName`: the assistant was renamed (the console keeps it for lists and Inbox). */
    input: AutomationUpdateInput & { readonly assistantName?: string | undefined },
  ) => Effect.Effect<Automation, AutomationClientError>;
  readonly remove: (
    id: number,
  ) => Effect.Effect<{ readonly deleted: boolean }, AutomationClientError>;
  readonly runNow: (id: number) => Effect.Effect<AutomationRun | null, AutomationClientError>;
  readonly runs: (
    id: number,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<AutomationRun>, AutomationClientError>;
  readonly repos: (
    query: string,
  ) => Effect.Effect<AutomationGithubReposResult, AutomationClientError>;
  /** A webhook's URL: only for the person's own session. */
  readonly hook: (id: number) => Effect.Effect<AutomationHook, AutomationClientError>;
  readonly rotateHook: (id: number) => Effect.Effect<AutomationHook, AutomationClientError>;
  readonly events: (input: {
    readonly after: number;
    readonly waitSec: number;
  }) => Effect.Effect<ReadonlyArray<AutomationEvent>, AutomationClientError>;
  readonly claim: (eventId: number) => Effect.Effect<ClaimOutcome, AutomationClientError>;
  readonly result: (
    eventId: number,
    input: AutomationResultBody,
  ) => Effect.Effect<void, AutomationClientError>;
  readonly prComment: (input: {
    readonly repo: string;
    readonly number: number;
    readonly body: string;
  }) => Effect.Effect<
    { readonly id: number | null; readonly htmlUrl: string | null },
    AutomationClientError
  >;
}

const ok = (status: number) => status >= 200 && status < 300;

/** Long-poll answers come back within `wait`; the request waits that plus slack. */
const LONG_POLL_SLACK_MS = 15_000;

export function unavailableReasonOf(error: AutomationClientError): AutomationsUnavailableReason {
  switch (error.code) {
    case "NOT_CLOUD_COMPUTER":
      return "not_cloud_computer";
    case "AUTOMATIONS_DISABLED":
      return "disabled";
    default:
      return "console_unreachable";
  }
}

/** What an answer of the console says about automations being on (null: nothing). */
export function verdictOfAnswer(subpath: string, response: WorkConsoleResponse): boolean | null {
  if (!subpath.startsWith("automations")) return null;
  if (ok(response.status)) return true;
  return consoleRefusal(response).code === "AUTOMATIONS_DISABLED" ? false : null;
}

export function makeAutomationsClient(deps: AutomationsClientDeps): AutomationsClient {
  let consoleOn: boolean | null = null;
  const remember = (subpath: string, response: WorkConsoleResponse) => {
    const verdict = verdictOfAnswer(subpath, response);
    if (verdict !== null) consoleOn = verdict;
  };
  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    subpath: string,
    body?: unknown,
    timeoutMs?: number,
  ) =>
    Effect.gen(function* () {
      const identity = yield* deps.identity;
      if (identity === null) return yield* notCloudComputerError();
      return yield* callMachineConsole({
        identity,
        method,
        path: `/api/v1/boxes/${identity.boxId}/work/${subpath}`,
        ...(body !== undefined ? { body } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }).pipe(
        Effect.tap((response) => Effect.sync(() => remember(subpath, response))),
        Effect.mapError((cause) => unreachable(cause.message)),
      );
    });

  /** 2xx → the body; anything else → the console's refusal. */
  const expectOk = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    subpath: string,
    body?: unknown,
    timeoutMs?: number,
  ) =>
    call(method, subpath, body, timeoutMs).pipe(
      Effect.flatMap((response) =>
        ok(response.status) ? Effect.succeed(response.body) : Effect.fail(consoleRefusal(response)),
      ),
    );

  const oneAutomation = (body: unknown) => {
    const parsed = parseAutomation(record(body)?.["automation"] ?? body);
    return parsed === null
      ? Effect.fail(
          new AutomationClientError({
            status: 502,
            code: "CONSOLE_UNREACHABLE",
            message: "The Uno console answered without the automation. Try again in a minute.",
          }),
        )
      : Effect.succeed(parsed);
  };

  const withVerdict = (result: AutomationListResult): AutomationListResult =>
    consoleOn === null ? result : { ...result, consoleEnabled: consoleOn };
  const list: AutomationsClient["list"] = expectOk("GET", "automations").pipe(
    Effect.map(
      (body): AutomationListResult => ({
        available: true,
        reason: null,
        automations: parseAutomationList(body),
        hooksEnabled: record(body)?.["hooks_enabled"] === true,
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed<AutomationListResult>({
        available: false,
        reason: unavailableReasonOf(error),
        automations: [],
      }),
    ),
    Effect.map(withVerdict),
  );

  const oneHook = (body: unknown) => {
    const parsed = parseHook(body);
    return parsed === null
      ? Effect.fail(
          new AutomationClientError({
            status: 502,
            code: "CONSOLE_UNREACHABLE",
            message: "The Uno console answered without the URL. Try again in a minute.",
          }),
        )
      : Effect.succeed(parsed);
  };

  return {
    list,
    consoleEnabled: () => consoleOn,
    create: (input) =>
      expectOk("POST", "automations", createBodyToConsole(input)).pipe(
        Effect.flatMap(oneAutomation),
      ),
    update: (id, input) =>
      expectOk("PATCH", `automations/${id}`, updateBodyToConsole(input)).pipe(
        Effect.flatMap(oneAutomation),
      ),
    remove: (id) =>
      call("DELETE", `automations/${id}`).pipe(
        Effect.flatMap((response) => {
          if (ok(response.status))
            return Effect.succeed<{ readonly deleted: boolean }>({ deleted: true });
          const refusal = consoleRefusal(response);
          return refusal.code === "NOT_FOUND"
            ? Effect.succeed<{ readonly deleted: boolean }>({ deleted: false })
            : Effect.fail(refusal);
        }),
      ),
    runNow: (id) =>
      expectOk("POST", `automations/${id}/run`, {}).pipe(
        Effect.map((body) => parseRun(record(body)?.["run"] ?? body)),
      ),
    runs: (id, limit = 20) =>
      expectOk("GET", `automations/${id}/runs?limit=${Math.min(100, Math.max(1, limit))}`).pipe(
        Effect.map((body) => {
          const runs = record(body)?.["runs"];
          return Array.isArray(runs)
            ? runs.map(parseRun).filter((run): run is AutomationRun => run !== null)
            : [];
        }),
      ),
    repos: (query) =>
      call(
        "GET",
        `git/github/repos${query.trim() ? `?q=${encodeURIComponent(query.trim().slice(0, 100))}` : ""}`,
      ).pipe(
        Effect.flatMap((response) => {
          if (ok(response.status)) {
            const accounts = parseRepoAccounts(response.body);
            return Effect.succeed<AutomationGithubReposResult>({
              connected: record(response.body)?.["connected"] !== false,
              repos: parseRepos(response.body),
              manageUrl: repoManageUrl(response.body, accounts, query),
              ...(accounts.length > 0 ? { accounts } : {}),
            });
          }
          const refusal = consoleRefusal(response);
          return refusal.code === "GITHUB_NOT_CONNECTED"
            ? Effect.succeed<AutomationGithubReposResult>({
                connected: false,
                repos: [],
                manageUrl: refusal.connectUrl ?? refusal.manageUrl ?? null,
              })
            : Effect.fail(refusal);
        }),
      ),
    hook: (id) => expectOk("GET", `automations/${id}/hook`).pipe(Effect.flatMap(oneHook)),
    rotateHook: (id) =>
      expectOk("POST", `automations/${id}/hook/rotate`, {}).pipe(Effect.flatMap(oneHook)),
    events: ({ after, waitSec }) => {
      const wait = Math.min(25, Math.max(0, Math.floor(waitSec)));
      return expectOk(
        "GET",
        `automations/events?after=${Math.max(0, Math.floor(after))}&wait=${wait}`,
        undefined,
        wait * 1_000 + LONG_POLL_SLACK_MS,
      ).pipe(Effect.map(parseEvents));
    },
    claim: (eventId) =>
      call("POST", `automations/events/${eventId}/claim`, {}).pipe(
        Effect.flatMap((response) => {
          if (ok(response.status)) return Effect.succeed<ClaimOutcome>("claimed");
          const refusal = consoleRefusal(response);
          return response.status === 409 || refusal.code === "ALREADY_CLAIMED"
            ? Effect.succeed<ClaimOutcome>("already_claimed")
            : Effect.fail(refusal);
        }),
      ),
    result: (eventId, input) =>
      expectOk("POST", `automations/events/${eventId}/result`, resultBodyToConsole(input)).pipe(
        Effect.asVoid,
      ),
    prComment: (input) =>
      expectOk("POST", "git/github/pr-comment", {
        repo: input.repo,
        number: input.number,
        body: input.body,
      }).pipe(
        Effect.map((body) => ({
          id: positiveInt(record(body)?.["id"]),
          htmlUrl: text(record(body)?.["html_url"]),
        })),
      ),
  };
}
