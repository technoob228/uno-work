/**
 * Automations (28.10) in words, and the dialog's draft (pure): what a card
 * says about the last run and what's wrong, the trigger the dialog makes and
 * reads back, the mode line, the suggestions.
 */
import {
  type Automation,
  type AutomationListResult,
  type AutomationCadence,
  type AutomationRun,
  type AutomationTrigger,
  type AutomationsUnavailableReason,
  AUTOMATION_DEFAULT_PR_ACTIONS,
  AUTOMATION_NAME_MAX_CHARS,
  automationCronFor,
  automationExecutorOf,
} from "@t3tools/contracts";

// ── The last run ─────────────────────────────────────────────────────────

export type RunTone = "ok" | "running" | "wait" | "error" | "muted";

export interface RunLine {
  readonly text: string;
  readonly tone: RunTone;
}

/** The last run in one line: "Waiting — uno-work is asleep, it runs when the computer wakes". */
export function runLine(run: AutomationRun, computer: string): RunLine {
  const where = computer || "its computer";
  switch (run.state) {
    case "queued":
      return { text: "Queued — starts in a moment", tone: "running" };
    case "waiting_wake":
      return {
        text: `Waiting — ${where} is asleep, it runs when the computer wakes`,
        tone: "wait",
      };
    case "running":
      return { text: "Running now", tone: "running" };
    case "done":
      return { text: "Done", tone: "ok" };
    case "failed":
      return { text: `Failed: ${run.reason?.trim() || "it stopped with an error"}`, tone: "error" };
    case "skipped":
      return {
        text:
          run.reason === "limit"
            ? run.kind === "webhook" || run.kind === "site.form"
              ? "Skipped — too many in a row. It takes the next one after a pause."
              : "Skipped — too many runs this hour (12 at most)"
            : `Skipped${run.reason ? ` — ${run.reason}` : ""}`,
        tone: "muted",
      };
    case "superseded":
      return { text: "Skipped — a newer push came, that one ran instead", tone: "muted" };
    case "expired":
      return { text: `Missed — ${where} was off at that time`, tone: "muted" };
  }
}

/** A run that is still going: the card asks its computer again soon. */
export function runIsActive(run: AutomationRun | null): boolean {
  return run !== null && ["queued", "waiting_wake", "running"].includes(run.state);
}

// ── What's wrong with it ─────────────────────────────────────────────────

export interface StatusProblem {
  readonly text: string;
  /** The button: the place on GitHub (manageUrl), or Connect GitHub. */
  readonly action: string;
  readonly url: string | null;
  readonly kind: "github-repo" | "github-permission" | "github-connect";
}

export function statusProblem(automation: Automation): StatusProblem | null {
  const repo = automation.trigger.kind === "github.pull_request" ? automation.trigger.repo : null;
  switch (automation.status) {
    case "ok":
      return null;
    case "needs_github_repo":
      return {
        text: `Uno's GitHub app can't see ${repo ?? "this repository"}`,
        action: "Add it on GitHub",
        url: automation.manageUrl,
        kind: "github-repo",
      };
    case "needs_github_permission":
      return {
        text: "GitHub needs one more permission: to comment on pull requests",
        action: "Review on GitHub",
        url: automation.manageUrl,
        kind: "github-permission",
      };
    case "github_not_connected":
      return {
        text: "GitHub isn't connected",
        action: "Connect GitHub",
        url: automation.manageUrl,
        kind: "github-connect",
      };
  }
}

/** Why there is no list (null: hide the section — Automations are off for the account). */
export function unavailableLine(reason: AutomationsUnavailableReason | null): string | null {
  switch (reason) {
    case "not_cloud_computer":
      return "Automations run on a cloud computer — a laptop sleeps and closes.";
    case "console_unreachable":
      return "Couldn't reach Uno to load the automations. Try again in a minute.";
    default:
      return null;
  }
}

// ── Words around it ──────────────────────────────────────────────────────

export function emptyHint(name: string): string {
  return `Ask ${name} in the chat: “every time a PR comes to owner/repo, review it”.`;
}

/** How a webhook or a form works in a chat, on its card and in the dialog. */
export function askLine(ask: boolean): string {
  return ask
    ? "Ask mode: it reads and answers in the chat, anything else waits for your Allow"
    : "Works without asking, in the chat's own mode";
}

/** The assistant's mode for this automation, said plainly. */
export function modeLine(
  name: string,
  asksFirst: boolean,
  kind: AutomationTrigger["kind"],
): string {
  const pr = kind === "github.pull_request";
  if (asksFirst) {
    return pr
      ? `Cautious — ${name} asks you before commenting`
      : `Cautious — ${name} asks you before sending anything`;
  }
  return pr
    ? `Autonomous — ${name} comments on its own`
    : `Autonomous — ${name} acts and tells you after`;
}

export type EventSource = "github" | "call" | "gmail" | "webhook" | "form";

export function suggestionsFor(
  when: "schedule" | "event",
  source: EventSource,
): ReadonlyArray<string> {
  if (when === "schedule") {
    return ["Sum up my day", "Check my mail and tell me what needs me", "Check CI on my repos"];
  }
  if (source === "call") {
    return ["Draft the follow-up email", "Put the action items in my notes"];
  }
  if (source === "webhook") {
    return ["Tell me what happened and what to do", "Look into the failure and find the cause"];
  }
  if (source === "form") {
    return ["Read the note and propose the change", "Answer the question from the project's files"];
  }
  return ["Review the PR and leave a comment", "Check it builds and the tests pass"];
}

// ── The dialog's draft ───────────────────────────────────────────────────

export interface AutomationDraft {
  readonly when: "schedule" | "event";
  readonly cadence: AutomationCadence;
  /** "09:00" (hourly: only the minutes count). */
  readonly time: string;
  /** 0 = Sunday. */
  readonly weekday: number;
  /** "Days…": the weekdays picked, 0 = Sunday. */
  readonly weekdays: ReadonlyArray<number>;
  /** "Every…": minutes between runs (15 … 720). */
  readonly everyMinutes: number;
  readonly source: EventSource;
  readonly repo: string;
  /** A form: the site's name. */
  readonly slug: string;
  /** A webhook or a form in a chat: Ask mode. On unless the person turns it off. */
  readonly ask: boolean;
  /** A webhook: refuse a request without a valid signature. */
  readonly requireSignature: boolean;
  readonly instruction: string;
  /** Empty: made from the trigger and the instruction. */
  readonly name: string;
}

export const EMPTY_DRAFT: AutomationDraft = {
  when: "schedule",
  cadence: "weekdays",
  time: "09:00",
  weekday: 1,
  weekdays: [1, 3, 5],
  everyMinutes: 60,
  source: "github",
  repo: "",
  slug: "",
  ask: true,
  requireSignature: false,
  instruction: "",
  name: "",
};

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `https://github.com/owner/x(.git)`, ` owner/x ` → `owner/x`. */
export function normalizeRepo(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
}

export function isRepoName(value: string): boolean {
  return REPO_PATTERN.test(normalizeRepo(value));
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** `https://report.uno4.me/`, ` Report ` → `report`. */
export function normalizeSlug(value: string): string {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "");
  return host.split(".")[0] ?? "";
}

export function isSlug(value: string): boolean {
  return SLUG_PATTERN.test(normalizeSlug(value));
}

/** The trigger of the draft (the browser's time zone for a schedule). */
export function triggerOf(draft: AutomationDraft, timezone: string): AutomationTrigger {
  if (draft.when === "schedule") {
    const { cron, label } = automationCronFor({
      cadence: draft.cadence,
      time: draft.time,
      weekday: draft.weekday,
      weekdays: draft.weekdays,
      everyMinutes: draft.everyMinutes,
    });
    return { kind: "schedule", cron, timezone, label };
  }
  if (draft.source === "call") return { kind: "call.ended" };
  if (draft.source === "gmail") return { kind: "gmail.message" };
  if (draft.source === "webhook") {
    return { kind: "webhook", ask: draft.ask, requireSignature: draft.requireSignature };
  }
  if (draft.source === "form") {
    return { kind: "site.form", slug: normalizeSlug(draft.slug), ask: draft.ask };
  }
  return {
    kind: "github.pull_request",
    repo: normalizeRepo(draft.repo),
    actions: [...AUTOMATION_DEFAULT_PR_ACTIONS],
    drafts: false,
  };
}

/** What stops "Create" (null: good to go). */
export function draftProblem(draft: AutomationDraft): string | null {
  if (draft.when === "schedule" && draft.cadence === "days" && draft.weekdays.length === 0) {
    return "Pick at least one day.";
  }
  if (draft.when === "event") {
    if (draft.source === "gmail") return "Email triggers are coming soon.";
    if (draft.source === "github" && !isRepoName(draft.repo)) return "Pick a repository.";
    if (draft.source === "form" && !isSlug(draft.slug)) return "Enter the site's name.";
  }
  if (draft.instruction.trim() === "") return "Say what to do.";
  return null;
}

function clip(text: string, max: number): string {
  const line = text.trim().split(/\n|(?<=\.)\s/)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Its name when the person gave none: "Review PRs in getuno/web", or the instruction's first line. */
export function autoName(draft: AutomationDraft): string {
  if (draft.when === "event" && draft.source === "github" && isRepoName(draft.repo)) {
    const repo = normalizeRepo(draft.repo);
    return /review/i.test(draft.instruction) || draft.instruction.trim() === ""
      ? `Review PRs in ${repo}`
      : clip(`${clip(draft.instruction, 40)} · ${repo}`, AUTOMATION_NAME_MAX_CHARS);
  }
  if (draft.when === "event" && draft.source === "form" && isSlug(draft.slug)) {
    return `Form on ${normalizeSlug(draft.slug)}`;
  }
  const first = clip(draft.instruction, 60).replace(/[.!]+$/, "");
  if (first) return first;
  if (draft.when === "event" && draft.source === "webhook") return "Webhook";
  return draft.when === "event" && draft.source === "call" ? "After each call" : "Automation";
}

const CRON_DAILY = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;
const CRON_WEEKDAYS = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/;
const CRON_WEEKLY = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/;
const CRON_HOURLY = /^(\d{1,2}) \* \* \* \*$/;
const CRON_DAYS = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6](?:,[0-6])+)$/;
const CRON_EVERY_MINUTES = /^\*\/(\d{1,2}) \* \* \* \*$/;
const CRON_EVERY_HOURS = /^(\d{1,2}) \*\/(\d{1,2}) \* \* \*$/;

const hhmm = (hour: string, minute: string) =>
  `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

/** The draft of an automation (Edit). A cron the dialog can't say comes back as weekdays 09:00. */
export function draftOf(automation: Automation): AutomationDraft {
  const base = {
    ...EMPTY_DRAFT,
    instruction: automation.instruction,
    name: automation.name,
  };
  const trigger = automation.trigger;
  switch (trigger.kind) {
    case "github.pull_request":
      return { ...base, when: "event", source: "github", repo: trigger.repo };
    case "call.ended":
      return { ...base, when: "event", source: "call" };
    case "gmail.message":
      return { ...base, when: "event", source: "gmail" };
    case "webhook":
      return {
        ...base,
        when: "event",
        source: "webhook",
        ask: trigger.ask !== false,
        requireSignature: trigger.requireSignature === true,
      };
    case "site.form":
      return {
        ...base,
        when: "event",
        source: "form",
        slug: trigger.slug,
        ask: trigger.ask !== false,
      };
    case "schedule": {
      const cron = trigger.cron.trim();
      let match = CRON_WEEKDAYS.exec(cron);
      if (match) return { ...base, cadence: "weekdays", time: hhmm(match[2]!, match[1]!) };
      match = CRON_DAILY.exec(cron);
      if (match) return { ...base, cadence: "daily", time: hhmm(match[2]!, match[1]!) };
      match = CRON_WEEKLY.exec(cron);
      if (match) {
        return {
          ...base,
          cadence: "weekly",
          time: hhmm(match[2]!, match[1]!),
          weekday: Number(match[3]),
        };
      }
      match = CRON_HOURLY.exec(cron);
      if (match) return { ...base, cadence: "every", everyMinutes: 60, time: hhmm("9", match[1]!) };
      match = CRON_DAYS.exec(cron);
      if (match) {
        return {
          ...base,
          cadence: "days",
          time: hhmm(match[2]!, match[1]!),
          weekdays: match[3]!.split(",").map(Number),
        };
      }
      match = CRON_EVERY_MINUTES.exec(cron);
      if (match && [15, 20, 30].includes(Number(match[1]))) {
        return { ...base, cadence: "every", everyMinutes: Number(match[1]) };
      }
      match = CRON_EVERY_HOURS.exec(cron);
      if (match) {
        return {
          ...base,
          cadence: "every",
          time: hhmm("9", match[1]!),
          everyMinutes: Number(match[2]) * 60,
        };
      }
      return base;
    }
  }
}

/** The browser's IANA time zone ("UTC" when it won't say). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// ── Grouping for the Automations screen ──────────────────────────────────

/** The group key of automations chats run. */
export const CHATS_GROUP = "chats";

/** Who runs it, in words: "Ada", "in “Release notes”", "a new chat in site". */
export function executorLabel(automation: Automation): string {
  const executor = automationExecutorOf(automation);
  switch (executor.kind) {
    case "assistant":
      return automation.assistantName || automation.assistant;
    case "chat":
      return `in “${executor.title || "a chat"}”`;
    case "new_chat":
      return `a new chat in ${executor.title || "its project"}`;
  }
}

/** "in 3h", "in 12 min", "in 2 days" — how soon the next run is (null: none / past). */
export function nextInLabel(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - nowMs;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 60_000) return "any moment";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)} days`;
}

/** The dot of an automation: on and fine, running, a problem, or off. */
export function automationDot(automation: Automation): RunTone {
  if (!automation.enabled) return "muted";
  if (automation.status !== "ok") return "error";
  if (automation.lastRun !== null) {
    if (runIsActive(automation.lastRun)) return "running";
    if (automation.lastRun.state === "failed") return "error";
  }
  return "ok";
}

export interface AutomationGroup<T> {
  readonly key: string;
  readonly environmentId: string;
  readonly assistant: string;
  readonly assistantName: string;
  readonly items: ReadonlyArray<T>;
}

/**
 * By assistant (per computer), in the order of `order` (the team: Uno first);
 * assistants not in it (removed) come last, by name.
 */
export function groupByAssistant<
  T extends { readonly environmentId: string; readonly automation: Automation },
>(
  items: ReadonlyArray<T>,
  order: ReadonlyArray<{ readonly environmentId: string; readonly projectId: string }>,
): ReadonlyArray<AutomationGroup<T>> {
  const groups = new Map<
    string,
    { environmentId: string; assistant: string; name: string; items: T[] }
  >();
  for (const item of items) {
    // Automations chats run (29.10) go together under "Chats", after the assistants.
    const inChat = automationExecutorOf(item.automation).kind !== "assistant";
    const key = inChat
      ? `${item.environmentId}:${CHATS_GROUP}`
      : `${item.environmentId}:${item.automation.assistant}`;
    const group = groups.get(key) ?? {
      environmentId: item.environmentId,
      assistant: inChat ? CHATS_GROUP : item.automation.assistant,
      name: inChat ? "Chats" : item.automation.assistantName,
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  const rank = (key: string) => {
    if (key.endsWith(`:${CHATS_GROUP}`)) return Number.MAX_SAFE_INTEGER - 1;
    const at = order.findIndex((member) => `${member.environmentId}:${member.projectId}` === key);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  return [...groups.entries()]
    .toSorted(([a, ga], [b, gb]) => rank(a) - rank(b) || ga.name.localeCompare(gb.name))
    .map(([key, group]) => ({
      key,
      environmentId: group.environmentId,
      assistant: group.assistant,
      assistantName: group.name,
      items: group.items.toSorted((x, y) => x.automation.id - y.automation.id),
    }));
}

// ── The chat card ────────────────────────────────────────────────────────

/**
 * The automation an `automation_create` call returned (its result is the
 * Automation, or `{automation: …}`); null when it isn't one — then the call
 * stays a plain line.
 */
export function automationFromToolResult(raw: string | undefined): Automation | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const candidate =
    record && record.automation && typeof record.automation === "object"
      ? (record.automation as Record<string, unknown>)
      : record;
  if (
    !candidate ||
    typeof candidate.id !== "number" ||
    typeof candidate.name !== "string" ||
    !candidate.trigger ||
    typeof candidate.trigger !== "object" ||
    typeof (candidate.trigger as { kind?: unknown }).kind !== "string"
  ) {
    return null;
  }
  return candidate as unknown as Automation;
}

// ── Gating (28.10) ───────────────────────────────────────────────────────

/** What the console said, on one computer: on (a 2xx, now or before), or not known/off. */
export function automationsConsoleOn(data: AutomationListResult | undefined): boolean {
  return data?.available === true || data?.consoleEnabled === true;
}

/**
 * Whether anything of Automations shows (the sidebar's icon, `/automations`,
 * the section on an assistant's page, the dialog): only with the assistants
 * update on the account AND the console's AUTOMATIONS on — some computer of
 * the account heard it say so. A laptop alone never hears it (automations run
 * on a cloud computer), so it shows nothing.
 */
export function automationsShown(input: {
  readonly teamShown: boolean;
  readonly computers: ReadonlyArray<AutomationListResult | undefined>;
}): boolean {
  return input.teamShown && input.computers.some(automationsConsoleOn);
}
