/**
 * Automations in the demo (28.10): what the daemon's `/api/manager/automations*`
 * answers (kept in memory per computer, in the wire shapes of
 * `@t3tools/contracts`), the runs and the scenes — a pull request opens, is
 * pushed twice, comes while the computer sleeps — and the chat phrase
 * "every time a PR comes to … review it".
 *
 * The console's checks are played here: GitHub not connected, the Uno app
 * not seeing the repo (`gh=norepo`), no "Pull requests: write" (`gh=noperm`),
 * the MacBook ("Automations run on a cloud computer").
 */
import {
  ASSISTANT_PROJECT_ID,
  type Automation,
  type AutomationExecutor,
  type AutomationRun,
  type AutomationTrigger,
  AUTOMATION_DEFAULT_PR_ACTIONS,
  automationCronFor,
  describeAutomationTrigger,
} from "@t3tools/contracts";
import { HttpResponse, http, type HttpHandler } from "msw";

import { browserTimeZone } from "../../components/automations/automations.logic";
import { MACHINES, type DemoMachine, type MachineKey } from "../heavyFixtures";
import { DEMO_PERSONAS } from "./fixtures";
import {
  type Script,
  type ScriptContext,
  addScene,
  addTrigger,
  machineName,
  mainChatOf,
  playWith,
} from "./engine";
import { type AssistWorld, WORLD } from "./world";

// ── An assistant on the MacBook (`?macassistant=on`) ─────────────────────

// Automations run on a cloud computer: an assistant living on the laptop
// shows that on its page. Only with the param — variant D keeps its own cast.
if (
  typeof location !== "undefined" &&
  WORLD.account === "live" &&
  /[?&]macassistant=on\b/.test(location.search)
) {
  DEMO_PERSONAS.push({
    projectId: "assistant-kit",
    machine: "mac",
    name: "Kit",
    emoji: "🛠️",
    tone: "slate",
    roles: ["Ops"],
    character: "Direct · Brief",
    duties: [],
    setUp: true,
    chats: [],
  });
}

// ── The store ────────────────────────────────────────────────────────────

const automations = new Map<MachineKey, Automation[]>();
const runs = new Map<number, AutomationRun[]>();
let nextId = 1;
let nextRunId = 1;
let world: AssistWorld = WORLD;

const MANAGE_URL = "https://github.com/settings/installations/52011978";
const CONNECT_URL = "https://github.com/apps/uno-deploy/installations/new";
const ALL_REPOS: ReadonlyArray<{ fullName: string; private: boolean }> = [
  { fullName: "getuno/web", private: true },
  { fullName: "getuno/api", private: true },
  { fullName: "misha-demo/landing", private: false },
  { fullName: "misha-demo/orders-bot", private: true },
];
/** The repo of the demo's pull requests (the one `gh=norepo` hides). */
export const DEMO_REPO = "getuno/web";

function visibleRepos() {
  if (world.gh === "off") return [];
  return world.gh === "norepo"
    ? ALL_REPOS.filter((repo) => repo.fullName !== DEMO_REPO)
    : ALL_REPOS;
}

const sees = (repo: string) =>
  visibleRepos().some((item) => item.fullName.toLowerCase() === repo.toLowerCase());

/** The console's status of an automation, asked again on every list (as the console does). */
function statusOf(
  trigger: AutomationTrigger,
): Pick<Automation, "status" | "statusDetail" | "manageUrl"> {
  if (trigger.kind !== "github.pull_request") {
    return { status: "ok", statusDetail: null, manageUrl: null };
  }
  if (world.gh === "off") {
    return {
      status: "github_not_connected",
      statusDetail: "Connect GitHub to Uno",
      manageUrl: CONNECT_URL,
    };
  }
  if (!sees(trigger.repo)) {
    return {
      status: "needs_github_repo",
      statusDetail: `Uno's GitHub app can't see ${trigger.repo}`,
      manageUrl: MANAGE_URL,
    };
  }
  if (world.gh === "noperm") {
    return {
      status: "needs_github_permission",
      statusDetail: "Accept the new permission on GitHub",
      manageUrl: `${MANAGE_URL}/permissions/update`,
    };
  }
  return { status: "ok", statusDetail: null, manageUrl: null };
}

const listOf = (machine: MachineKey) => automations.get(machine) ?? [];

function fresh(automation: Automation): Automation {
  return { ...automation, ...statusOf(automation.trigger) };
}

/** The next slot of a simple schedule (weekdays/daily/weekly/hourly), in the browser's time. */
function nextSlot(cron: string, from = Date.now()): string | null {
  const [minute, hour, , , days] = cron.split(" ");
  const step = /^\*\/(\d+)$/.exec(minute ?? "");
  if (step) {
    const every = Number(step[1]) * 60_000;
    return new Date(Math.ceil((from + 1) / every) * every).toISOString();
  }
  const at = new Date(from);
  at.setSeconds(0, 0);
  for (let step = 0; step < 24 * 8; step += 1) {
    at.setTime(at.getTime() + (step === 0 ? 60_000 : 3_600_000));
    if (step === 0) at.setMinutes(Number(minute), 0, 0);
    if (at.getTime() <= from) continue;
    if (hour !== "*" && at.getHours() !== Number(hour)) continue;
    if (days === "1-5" && (at.getDay() === 0 || at.getDay() === 6)) continue;
    if (days && days.includes(",") && !days.split(",").map(Number).includes(at.getDay())) continue;
    if (days && /^\d$/.test(days) && at.getDay() !== Number(days)) continue;
    return at.toISOString();
  }
  return null;
}

function make(
  machine: MachineKey,
  input: {
    assistant: string;
    assistantName: string;
    name: string;
    instruction: string;
    trigger: AutomationTrigger;
    executor?: AutomationExecutor;
    enabled?: boolean;
    createdAgo?: number;
  },
): Automation {
  const created = new Date(Date.now() - (input.createdAgo ?? 0)).toISOString();
  const automation: Automation = fresh({
    id: nextId++ as never,
    boxId: (MACHINES[machine].boxId ?? 2601) as never,
    assistant: input.assistant,
    assistantName: input.assistantName,
    name: input.name,
    instruction: input.instruction,
    enabled: input.enabled ?? true,
    trigger: input.trigger,
    executor: input.executor ?? { kind: "assistant" },
    status: "ok",
    statusDetail: null,
    manageUrl: null,
    nextRunAt: input.trigger.kind === "schedule" ? nextSlot(input.trigger.cron) : null,
    lastRun: null,
    createdAt: created,
    updatedAt: created,
  });
  automations.set(machine, [...listOf(machine), automation]);
  return automation;
}

function update(machine: MachineKey, id: number, patch: Partial<Automation>): Automation | null {
  let found: Automation | null = null;
  automations.set(
    machine,
    listOf(machine).map((item) => {
      if (item.id !== id) return item;
      found = fresh({ ...item, ...patch, updatedAt: new Date().toISOString() });
      return found;
    }),
  );
  return found;
}

const find = (machine: MachineKey, id: number) =>
  listOf(machine).find((item) => item.id === id) ?? null;

function machineOfAutomation(id: number): MachineKey | null {
  for (const [machine, list] of automations) {
    if (list.some((item) => item.id === id)) return machine;
  }
  return null;
}

function addRun(
  automation: Automation,
  run: Omit<AutomationRun, "id" | "automationId">,
): AutomationRun {
  const full: AutomationRun = { ...run, id: nextRunId++ as never, automationId: automation.id };
  runs.set(automation.id, [full, ...(runs.get(automation.id) ?? [])]);
  const machine = machineOfAutomation(automation.id);
  if (machine) update(machine, automation.id, { lastRun: full });
  return full;
}

function setRun(automationId: number, runId: number, patch: Partial<AutomationRun>) {
  const list = (runs.get(automationId) ?? []).map((run) =>
    run.id === runId ? Object.assign({}, run, patch) : run,
  );
  runs.set(automationId, list);
  const machine = machineOfAutomation(automationId);
  if (machine) update(machine, automationId, { lastRun: list[0] ?? null });
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** The demo's start: a few automations on uno-work in the live account (`automations=some`). */
export function resetAutomations(input: { readonly world: AssistWorld }) {
  world = input.world;
  automations.clear();
  runs.clear();
  nextId = 1;
  nextRunId = 1;
  registerOnce();
  if (world.account !== "live" || world.automations !== "some") return;
  const timezone = browserTimeZone();
  const evening = automationCronFor({ cadence: "weekdays", time: "18:00" });
  const uno = make("work", {
    assistant: ASSISTANT_PROJECT_ID,
    assistantName: "Uno",
    name: "Sum up my day",
    instruction: "Sum up my day: mail, calls, what's waiting for me tomorrow.",
    trigger: { kind: "schedule", cron: evening.cron, timezone, label: evening.label },
    createdAgo: 86_400_000 * 9,
  });
  addRun(uno, {
    kind: "schedule",
    title: evening.label,
    url: null,
    state: "done",
    reason: null,
    threadId: "uno-main",
    summary: "3 mails need you, Dana's call moved to 15:00, the landing build is green.",
    createdAt: ago(60 * 20),
    startedAt: ago(60 * 20),
    finishedAt: ago(60 * 20 - 2),
  });
  const bolt = make("work", {
    assistant: "assistant-bolt",
    assistantName: "Bolt",
    name: `Review PRs in ${DEMO_REPO}`,
    instruction: "Review the PR and leave a comment",
    trigger: prTrigger(DEMO_REPO),
    createdAgo: 86_400_000 * 4,
  });
  addRun(bolt, {
    kind: "github.pull_request",
    title: "PR #11 · Add a pricing toggle",
    url: `https://github.com/${DEMO_REPO}/pull/11`,
    state: "done",
    reason: null,
    threadId: "assistant-bolt-main",
    summary: "Commented: looks good, one nit about the toggle's label.",
    createdAt: ago(180),
    startedAt: ago(180),
    finishedAt: ago(176),
  });
  // A chat runs this one (29.10): the export chat, Mon/Wed/Fri at 19:00.
  const days = automationCronFor({ cadence: "days", time: "19:00", weekdays: [1, 3, 5] });
  const exportRun = make("work", {
    assistant: "",
    assistantName: "",
    name: "Export today's orders",
    instruction: "Export today's orders to Drive as orders-<date>.csv and tell me the total.",
    trigger: { kind: "schedule", cron: days.cron, timezone, label: days.label },
    executor: { kind: "chat", threadId: "w-export", title: "Daily orders export to Drive" },
    createdAgo: 86_400_000 * 3,
  });
  addRun(exportRun, {
    kind: "schedule",
    title: days.label,
    url: null,
    state: "done",
    reason: null,
    threadId: "w-export",
    summary: "orders-2026-10-28.csv saved to Drive · 41 orders, $3,180.",
    createdAt: ago(60 * 22),
    startedAt: ago(60 * 22),
    finishedAt: ago(60 * 22 - 1),
  });
  const every = automationCronFor({ cadence: "every", time: "09:00", everyMinutes: 30 });
  make("work", {
    assistant: "",
    assistantName: "",
    name: "Watch the checkout error rate",
    instruction: "Check the checkout error rate in the logs; tell me only if it is over 2%.",
    trigger: { kind: "schedule", cron: every.cron, timezone, label: every.label },
    executor: { kind: "chat", threadId: "w-export", title: "Daily orders export to Drive" },
    enabled: false,
    createdAgo: 86_400_000,
  });
  make("work", {
    assistant: "assistant-mia",
    assistantName: "Mia",
    name: "Follow-up after calls",
    instruction: "Draft the follow-up email and show it to me",
    trigger: { kind: "call.ended" },
    createdAgo: 86_400_000 * 2,
  });
}

function prTrigger(repo: string): AutomationTrigger {
  return {
    kind: "github.pull_request",
    repo,
    actions: [...AUTOMATION_DEFAULT_PR_ACTIONS],
    drafts: false,
  };
}

// ── The console's checks on create ───────────────────────────────────────

interface Refusal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly manageUrl?: string;
  readonly connectUrl?: string;
}

function refusalFor(machine: MachineKey, trigger: AutomationTrigger): Refusal | null {
  if (machine !== "work" && machine !== "product") {
    return {
      status: 409,
      code: "NOT_CLOUD_COMPUTER",
      message: "Automations run on a cloud computer — a laptop sleeps and closes.",
    };
  }
  if (trigger.kind === "gmail.message") {
    return {
      status: 422,
      code: "TRIGGER_NOT_SUPPORTED_YET",
      message: "Email triggers are coming soon.",
    };
  }
  if (trigger.kind === "github.pull_request") {
    if (!/^[\w.-]+\/[\w.-]+$/.test(trigger.repo)) {
      return { status: 400, code: "INVALID_TRIGGER", message: "Pick a repository as owner/name." };
    }
    if (world.gh === "off") {
      return {
        status: 409,
        code: "GITHUB_NOT_CONNECTED",
        message: "GitHub isn't connected to Uno yet — connect it, then try again.",
        connectUrl: CONNECT_URL,
      };
    }
    if (!sees(trigger.repo)) {
      return {
        status: 409,
        code: "GITHUB_REPO_NOT_ALLOWED",
        message: `Uno's GitHub app can't see ${trigger.repo}. Add it on GitHub, then try again.`,
        manageUrl: MANAGE_URL,
      };
    }
  }
  if (listOf(machine).length >= 20) {
    return { status: 402, code: "AUTOMATIONS_LIMIT", message: "20 automations at most for now." };
  }
  return null;
}

const refuse = (refusal: Refusal) =>
  HttpResponse.json(
    {
      error: {
        code: refusal.code,
        message: refusal.message,
        ...(refusal.manageUrl ? { manageUrl: refusal.manageUrl } : {}),
        ...(refusal.connectUrl ? { connectUrl: refusal.connectUrl } : {}),
      },
    },
    { status: refusal.status },
  );

/** Made from the chat (`automation_create`): the automation, or why not. */
export function createFromChat(
  machine: MachineKey,
  input: { assistant: string; assistantName: string; repo: string; instruction: string },
): { automation: Automation } | { refusal: Refusal } {
  const trigger = prTrigger(input.repo);
  const refusal = refusalFor(machine, trigger);
  if (refusal) return { refusal };
  return {
    automation: make(machine, {
      assistant: input.assistant,
      assistantName: input.assistantName,
      name: `Review PRs in ${input.repo}`,
      instruction: input.instruction,
      trigger,
    }),
  };
}

// ── The daemon's routes ──────────────────────────────────────────────────

const body = async (request: Request) =>
  ((await request.json().catch(() => null)) as Record<string, unknown> | null) ?? {};

export function automationHandlers(deps: {
  readonly machineOf: (request: Request) => DemoMachine;
  readonly nameOf: (machine: MachineKey, projectId: string) => string | null;
}): HttpHandler[] {
  const json = HttpResponse.json;
  const notFound = () => refuse({ status: 404, code: "NOT_FOUND", message: "No such automation." });
  return [
    http.get("*/api/manager/automations/github/repos", ({ request }) => {
      const q = (new URL(request.url).searchParams.get("q") ?? "").toLowerCase();
      return json({
        connected: world.gh !== "off",
        repos: visibleRepos().filter((repo) => repo.fullName.toLowerCase().includes(q)),
        // The daemon puts the connect link here when GitHub isn't connected (CONTRACT.md, note 9).
        manageUrl: world.gh === "off" ? CONNECT_URL : MANAGE_URL,
      });
    }),
    http.get("*/api/manager/automations", ({ request }) => {
      const machine = deps.machineOf(request);
      if (machine.key === "mac") {
        return json({ available: false, reason: "not_cloud_computer", automations: [] });
      }
      return json({ available: true, reason: null, automations: listOf(machine.key).map(fresh) });
    }),
    http.post("*/api/manager/automations", async ({ request }) => {
      const machine = deps.machineOf(request);
      const input = await body(request);
      const trigger = input.trigger as AutomationTrigger | undefined;
      const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";
      if (!trigger || typeof trigger !== "object" || !instruction) {
        return refuse({
          status: 400,
          code: "INVALID_TRIGGER",
          message: "Say when and what to do.",
        });
      }
      const refusal = refusalFor(machine.key, trigger);
      if (refusal) return refuse(refusal);
      const assistant =
        typeof input.assistant === "string" ? input.assistant : ASSISTANT_PROJECT_ID;
      const executor = (input.executor as AutomationExecutor | undefined) ?? { kind: "assistant" };
      const created = make(machine.key, {
        assistant: executor.kind === "assistant" ? assistant : "",
        assistantName:
          executor.kind === "assistant" ? (deps.nameOf(machine.key, assistant) ?? "Assistant") : "",
        executor,
        name:
          typeof input.name === "string" && input.name.trim()
            ? input.name.trim()
            : describeAutomationTrigger(trigger),
        instruction,
        trigger,
        enabled: input.enabled !== false,
      });
      return json(created, { status: 201 });
    }),
    http.get("*/api/manager/automations/:id/runs", ({ params }) =>
      json({ runs: runs.get(Number(params.id)) ?? [] }),
    ),
    http.post("*/api/manager/automations/:id/run", ({ request, params }) => {
      const machine = deps.machineOf(request);
      const automation = find(machine.key, Number(params.id));
      if (!automation) return notFound();
      const run = runNow(machine.key, automation);
      return run
        ? json({ run })
        : refuse({ status: 409, code: "NO_OPEN_PR", message: "No open pull request right now." });
    }),
    http.patch("*/api/manager/automations/:id", async ({ request, params }) => {
      const machine = deps.machineOf(request);
      const id = Number(params.id);
      if (!find(machine.key, id)) return notFound();
      const input = await body(request);
      const patch: { -readonly [K in keyof Automation]?: Automation[K] } = {};
      if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
      if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim();
      if (typeof input.instruction === "string" && input.instruction.trim()) {
        patch.instruction = input.instruction.trim();
      }
      if (input.executor && typeof input.executor === "object") {
        patch.executor = input.executor as AutomationExecutor;
      }
      if (input.trigger && typeof input.trigger === "object") {
        const trigger = input.trigger as AutomationTrigger;
        const refusal = refusalFor(machine.key, trigger);
        if (refusal) return refuse(refusal);
        patch.trigger = trigger;
        patch.nextRunAt = trigger.kind === "schedule" ? nextSlot(trigger.cron) : null;
      }
      return json(update(machine.key, id, patch));
    }),
    http.delete("*/api/manager/automations/:id", ({ request, params }) => {
      const machine = deps.machineOf(request);
      const id = Number(params.id);
      if (!find(machine.key, id)) return notFound();
      automations.set(
        machine.key,
        listOf(machine.key).filter((item) => item.id !== id),
      );
      return json({ ok: true });
    }),
  ];
}

// ── Runs: the assistant's turn for an event ──────────────────────────────

interface PrEvent {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly sha: string;
}

const PR_12: PrEvent = {
  number: 12,
  title: "Fix the login redirect",
  author: "alice",
  sha: "3f2a1c0",
};

function prOf(automation: Automation): string {
  return automation.trigger.kind === "github.pull_request" ? automation.trigger.repo : DEMO_REPO;
}

/** The turn of a PR event: a review chat on the computer, then the comment (Allow in Cautious). */
function prScript(automation: Automation, run: AutomationRun, pr: PrEvent) {
  const repo = prOf(automation);
  const url = `https://github.com/${repo}/pull/${pr.number}`;
  const finish = (patch: Partial<AutomationRun>): Script => [
    {
      run: () => setRun(automation.id, run.id, { finishedAt: new Date().toISOString(), ...patch }),
    },
  ];
  return (ctx: ScriptContext): Script => [
    {
      run: (inner) => {
        inner.ops.userSays(
          inner.machine,
          inner.threadId,
          `⚙️ ${automation.name}\n\nPR #${pr.number} “${pr.title}” opened by ${pr.author} in ${repo} — ${url}, head ${pr.sha}.\nInstruction from you: ${automation.instruction}`,
        );
        setRun(automation.id, run.id, { threadId: inner.threadId });
      },
    },
    {
      elsewhere: {
        machine: ctx.machine,
        projectId: world.account === "live" ? "p-work-landing" : ctx.persona.projectId,
        title: `Review PR #${pr.number}`,
        prompt: `Review PR #${pr.number} in ${repo}: git fetch origin pull/${pr.number}/head, read the diff, write the review.`,
        steps: [
          `git fetch origin pull/${pr.number}/head…`,
          "Reading the diff — 4 files, +86 −12…",
          "Writing the review…",
        ],
        result: "Review ready: 1 bug (the redirect drops ?next=), 2 small nits.",
      },
    },
    ...(world.gh === "noperm"
      ? ([
          ...finish({
            state: "failed",
            reason: "GitHub needs one more permission to comment — Review on GitHub",
          }),
          {
            fail: "GitHub said no: Uno's app needs the “Pull requests: write” permission to comment. Accept it on GitHub — the review stays in the chat.",
          },
        ] satisfies Script)
      : ([
          {
            act: {
              command: `Comment on PR #${pr.number} in ${repo}`,
              why: "The review goes on GitHub as uno-deploy[bot].",
            },
            allowed: [
              ...finish({
                state: "done",
                summary: `Commented on PR #${pr.number}: 1 bug, 2 nits.`,
              }),
              { say: `Commented on PR #${pr.number}: 1 bug, 2 nits — ${url}#issuecomment-1` },
            ],
            declined: [
              ...finish({
                state: "done",
                summary: "Not commented — you declined. The review is in the chat.",
              }),
              {
                say: `OK, no comment on GitHub. The review stays in the chat “Review PR #${pr.number}”.`,
              },
            ],
          },
        ] satisfies Script)),
  ];
}

/** Any other run (a schedule, Run now): a short turn with its result. */
function plainScript(automation: Automation, run: AutomationRun) {
  const summary = /sum up|summary/i.test(automation.instruction)
    ? "3 mails need you, Dana's call moved to 15:00, the landing build is green."
    : `Done: ${automation.instruction.replace(/[.!]+$/, "")}.`;
  return (): Script => [
    {
      run: (inner) => {
        inner.ops.userSays(inner.machine, inner.threadId, `⚙️ ${automation.name} · ${run.title}`);
        setRun(automation.id, run.id, { threadId: inner.threadId });
      },
    },
    { work: "On it…" },
    {
      run: () =>
        setRun(automation.id, run.id, {
          state: "done",
          summary,
          finishedAt: new Date().toISOString(),
        }),
    },
    { say: summary },
  ];
}

function playIn(
  machine: MachineKey,
  automation: Automation,
  script: (ctx: ScriptContext) => Script,
) {
  const threadId = mainChatOf(machine, automation.assistant);
  if (threadId) void playWith(machine, threadId, script);
}

function prRun(automation: Automation, pr: PrEvent, state: AutomationRun["state"] = "running") {
  const now = new Date().toISOString();
  return addRun(automation, {
    kind: "github.pull_request",
    title: `PR #${pr.number} · ${pr.title}`,
    url: `https://github.com/${prOf(automation)}/pull/${pr.number}`,
    state,
    reason: state === "waiting_wake" ? "computer_asleep" : null,
    threadId: null,
    summary: null,
    createdAt: now,
    startedAt: state === "running" ? now : null,
    finishedAt: null,
  });
}

/** A PR event for an automation that can't see it: a failed run, nothing in the chat. */
function refusedRun(automation: Automation, pr: PrEvent): boolean {
  const status = fresh(automation).status;
  if (status !== "needs_github_repo" && status !== "github_not_connected") return false;
  const run = prRun(automation, pr);
  setRun(automation.id, run.id, {
    state: "failed",
    reason:
      status === "github_not_connected"
        ? "GitHub isn't connected"
        : `Uno's GitHub app can't see ${prOf(automation)}`,
    finishedAt: new Date().toISOString(),
  });
  return true;
}

function runNow(machine: MachineKey, automation: Automation): AutomationRun | null {
  if (automation.trigger.kind === "github.pull_request") {
    if (refusedRun(automation, PR_12)) return find(machine, automation.id)?.lastRun ?? null;
    const run = prRun(automation, PR_12);
    playIn(machine, automation, prScript(automation, run, PR_12));
    return run;
  }
  const now = new Date().toISOString();
  const run = addRun(automation, {
    kind: "manual",
    title: "Run now",
    url: null,
    state: "running",
    reason: null,
    threadId: null,
    summary: null,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
  });
  playIn(machine, automation, plainScript(automation, run));
  return run;
}

/** The PR automation of an assistant (made now for the scene if it has none). */
function prAutomationOf(machine: MachineKey, projectId: string, name: string): Automation {
  const found = listOf(machine).find(
    (item) => item.assistant === projectId && item.trigger.kind === "github.pull_request",
  );
  if (found) return found;
  // The scene needs one: made as if the console had it (whatever GitHub says).
  return make(machine, {
    assistant: projectId,
    assistantName: name,
    name: `Review PRs in ${DEMO_REPO}`,
    instruction: "Review the PR and leave a comment",
    trigger: prTrigger(DEMO_REPO),
  });
}

// ── Scenes and the chat phrase ───────────────────────────────────────────

const SCENE_TARGET =
  WORLD.account === "live" ? { machine: "work" as const, projectId: "assistant-bolt" } : undefined;

/** "every time a PR comes to getuno/web, review it" / «каждый раз, когда приходит PR … делай ревью». */
export const AUTOMATION_PHRASE =
  /(every time|whenever|each time)[^.?!]*\b(pr|prs|pull requests?)\b|каждый раз[^.?!]*(pr|пул)|когда приход\S* pr/i;

let registered = false;
/** At the start, after the variant: the phrase wins over its looser words, the scenes survive its keepScenes. */
function registerOnce() {
  if (registered) return;
  registered = true;
  // Scenes too: the variant keeps only its own list at import (keepScenes), these come after.
  addScene({
    id: "auto-pr-opened",
    title: "Автоматизация: пришёл PR",
    hint: "PR #12 открыт в getuno/web → ход ассистента → чат «Review PR #12» на uno-work → в «Спрашивает» карточка Allow «Comment on PR #12» + Inbox; после Allow — «Commented» и ссылка. В «Всё сам» — сразу.",
    ...(SCENE_TARGET ? { target: SCENE_TARGET } : {}),
    run: ({ target }) => {
      const automation = prAutomationOf(
        target.machine,
        target.persona.projectId,
        target.persona.name,
      );
      if (refusedRun(automation, PR_12)) return;
      const run = prRun(automation, PR_12);
      playIn(target.machine, automation, prScript(automation, run, PR_12));
    },
  });

  addScene({
    id: "auto-pr-twice",
    title: "Автоматизация: PR обновили дважды",
    hint: "Два пуша подряд в PR #12: первый ждёт в очереди и заменяется вторым («superseded») — запуск один.",
    ...(SCENE_TARGET ? { target: SCENE_TARGET } : {}),
    run: ({ target, play }) => {
      const automation = prAutomationOf(
        target.machine,
        target.persona.projectId,
        target.persona.name,
      );
      if (refusedRun(automation, PR_12)) return;
      const first = prRun(automation, { ...PR_12, sha: "1b7e9d2" }, "queued");
      void play([
        {
          run: () => {
            setRun(automation.id, first.id, {
              state: "superseded",
              reason: "newer push",
              finishedAt: new Date().toISOString(),
            });
            const second = prRun(automation, PR_12);
            playIn(target.machine, automation, prScript(automation, second, PR_12));
          },
          delay: 2_400,
        },
      ]);
    },
  });

  addScene({
    id: "auto-asleep",
    title: "Автоматизация: компьютер спит",
    hint: "PR пришёл, пока компьютер спал: на карточке «Waiting — uno-work is asleep…», потом компьютер просыпается и запуск идёт.",
    ...(SCENE_TARGET ? { target: SCENE_TARGET } : {}),
    run: ({ target, play }) => {
      const automation = prAutomationOf(
        target.machine,
        target.persona.projectId,
        target.persona.name,
      );
      if (refusedRun(automation, PR_12)) return;
      const run = prRun(automation, PR_12, "waiting_wake");
      void play([
        {
          run: () => {
            setRun(automation.id, run.id, {
              state: "running",
              reason: null,
              startedAt: new Date().toISOString(),
            });
            playIn(target.machine, automation, prScript(automation, run, PR_12));
          },
          delay: 15_000,
        },
      ]);
    },
  });
  addTrigger({
    id: "automation-phrase",
    match: AUTOMATION_PHRASE,
    script: (ctx, text) => {
      const repo = /\b([\w.-]+\/[\w.-]+)\b/.exec(text)?.[1] ?? DEMO_REPO;
      const comment = /comment|коммент/i.test(text) || /review|ревью/i.test(text);
      const asks = ctx.ops.asksFirst(ctx.persona.machine, ctx.persona.projectId);
      return [
        { work: `Setting it up for ${repo}…` },
        {
          run: (inner) => {
            if (inner.machine !== "work" && inner.machine !== "product") {
              inner.ops.say(
                inner.machine,
                inner.threadId,
                `Automations run on a cloud computer — ${machineName(inner.machine)} sleeps and closes. Ask Uno on uno-work and it'll set it up there.`,
              );
              return;
            }
            const result = createFromChat(inner.machine, {
              assistant: inner.persona.projectId,
              assistantName: inner.persona.name,
              repo,
              instruction: comment ? "Review the PR and leave a comment" : "Review the PR",
            });
            if ("refusal" in result) {
              inner.ops.say(
                inner.machine,
                inner.threadId,
                result.refusal.code === "GITHUB_REPO_NOT_ALLOWED"
                  ? `I can't watch ${repo} yet: Uno's GitHub app can't see it. Add it on GitHub (${result.refusal.manageUrl}), then ask me again.`
                  : result.refusal.code === "GITHUB_NOT_CONNECTED"
                    ? "I can't watch it yet: GitHub isn't connected to Uno. Connect it in Settings → Connectors, then ask me again."
                    : result.refusal.message,
              );
              return;
            }
            inner.ops.toolCall(inner.machine, inner.threadId, {
              server: "uno-manager",
              tool: "automation_create",
              input: {
                instruction: result.automation.instruction,
                trigger: result.automation.trigger,
              },
              output: { automation: result.automation },
            });
            inner.ops.say(
              inner.machine,
              inner.threadId,
              `Done — every time a pull request opens or updates in [${repo}](https://github.com/${repo}), I review it${
                asks ? " and ask you before I comment" : " and comment"
              }.`,
            );
          },
          delay: 1_400,
        },
      ];
    },
  });
}
