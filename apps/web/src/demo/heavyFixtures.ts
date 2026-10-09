/**
 * Demo "heavy usage" (icp3 09.10): the account of a person who runs 10–18
 * agent chats at once on three computers — a coordinator handing tasks to
 * helpers on other computers, a validator checking a release, their own
 * chats, Uno (the assistant) taking tasks from Telegram, an agent on the
 * MacBook that started a run in the cloud. Made-up work, no client data.
 *
 * Shapes follow the daemon's wire contracts so the real web client renders
 * them as it would real computers; `CHAT_META` adds what the variants need
 * on top (who coordinates whom, what exactly a chat asks for).
 */
import {
  ASSISTANT_PROJECT_ID,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ExecutionEnvironmentDescriptor,
  type InboxItem,
  type OrchestrationReadModel,
  type ServerConfig,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";

export const DEMO_VERSION = "0.0.118";

export const ENV_WORK = EnvironmentId.make("env-demo-uno-work");
export const ENV_PRODUCT = EnvironmentId.make("env-demo-uno-product");
export const ENV_MAC = EnvironmentId.make("env-demo-macbook");

export type MachineKey = "work" | "product" | "mac";

export interface DemoMachine {
  readonly key: MachineKey;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** "" = the page's own origin (the computer the page is opened from). */
  readonly host: string;
  readonly home: string;
  readonly os: "linux" | "darwin";
  readonly machineKind: "uno_box" | "computer";
  readonly boxId: number | null;
}

export const MACHINES: Record<MachineKey, DemoMachine> = {
  work: {
    key: "work",
    environmentId: ENV_WORK,
    label: "uno-work",
    host: "",
    home: "/home/uno",
    os: "linux",
    machineKind: "uno_box",
    boxId: 395,
  },
  product: {
    key: "product",
    environmentId: ENV_PRODUCT,
    label: "uno-product",
    host: "uno-product.demo.uno4.me",
    home: "/home/uno",
    os: "linux",
    machineKind: "uno_box",
    boxId: 2507,
  },
  mac: {
    key: "mac",
    environmentId: ENV_MAC,
    label: "MacBook",
    host: "macbook.demo.uno4.me",
    home: "/Users/misha",
    os: "darwin",
    machineKind: "computer",
    boxId: null,
  },
};

export const MACHINE_LIST: ReadonlyArray<DemoMachine> = [
  MACHINES.work,
  MACHINES.product,
  MACHINES.mac,
];

export function machineByEnv(environmentId: string): DemoMachine | null {
  return MACHINE_LIST.find((machine) => machine.environmentId === environmentId) ?? null;
}

/** A computer on the account that sleeps (economy): listed, not connected. */
export const SLEEPING_BOX = {
  id: 2611,
  name: "spark-lab",
  note: "Asleep since 14:10 · wakes in ~20 s",
} as const;

const NOW = Date.now();
export const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const later = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

/** Next day at hh:00 local time, or the given weekday (0 = Sunday). */
function nextAt(hour: number, weekday?: number): string {
  const at = new Date(NOW);
  at.setHours(hour, 0, 0, 0);
  if (weekday === undefined) {
    if (at.getTime() <= NOW) at.setDate(at.getDate() + 1);
  } else {
    const add = (weekday - at.getDay() + 7) % 7 || 7;
    at.setDate(at.getDate() + add);
  }
  return at.toISOString();
}

const UNO = ProviderInstanceId.make("uno");
const MODEL = { instanceId: UNO, model: "uno/smart" } as const;

export function descriptorFor(machine: DemoMachine): ExecutionEnvironmentDescriptor {
  return {
    environmentId: machine.environmentId,
    label: machine.label,
    platform: { os: machine.os, arch: machine.os === "darwin" ? "arm64" : "x64" },
    serverVersion: DEMO_VERSION,
    capabilities: {
      repositoryIdentity: true,
      threadSnooze: true,
      threadSettlement: true,
      agentThreads: true,
      threadContinueDirect: true,
      assistantChat: true,
    },
    machineKind: machine.machineKind,
    ...(machine.boxId !== null ? { unoBoxId: machine.boxId } : {}),
  } as ExecutionEnvironmentDescriptor;
}

export function serverConfigFor(machine: DemoMachine): ServerConfig {
  return {
    environment: descriptorFor(machine),
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "t3_session",
    },
    cwd: machine.home,
    keybindingsConfigPath: `${machine.home}/.t3code-keybindings.json`,
    keybindings: [],
    issues: [],
    providers: [
      {
        driver: ProviderDriverKind.make("uno"),
        instanceId: UNO,
        displayName: "Uno",
        enabled: true,
        installed: true,
        version: DEMO_VERSION,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: new Date(NOW).toISOString(),
        models: [
          { slug: "uno/smart", name: "Smart", isCustom: false, capabilities: null },
          { slug: "uno/fast", name: "Fast", isCustom: false, capabilities: null },
        ],
        slashCommands: [],
        skills: [],
      },
    ],
    availableEditors: [],
    observability: {
      logsDirectoryPath: `${machine.home}/.t3/logs`,
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: { ...DEFAULT_SERVER_SETTINGS, ...DEFAULT_CLIENT_SETTINGS },
  } as unknown as ServerConfig;
}

// ── Projects ──────────────────────────────────────────────────────────────

interface ProjectSpec {
  readonly id: string;
  readonly title: string;
  readonly root: string;
  /** Same repository on several computers = one project. */
  readonly repo?: string;
}

const REPO = {
  fishcode: "github.com/getuno/fishcode",
  work: "github.com/getuno/uno-work",
  console: "github.com/getuno/uno-console",
  modelLab: "github.com/technoob228/uno-model-lab",
  workspace: "github.com/technoob228/uno-workspace",
  landing: "github.com/getuno/landing",
} as const;

const PROJECTS: Record<MachineKey, ProjectSpec[]> = {
  work: [
    { id: "p-work-home", title: "Home folder", root: "/home/uno" },
    { id: ASSISTANT_PROJECT_ID, title: "Uno", root: "/home/uno/.uno/assistant" },
    {
      id: "p-work-fishcode",
      title: "fishcode",
      root: "/home/uno/projects/fishcode",
      repo: REPO.fishcode,
    },
    {
      id: "p-work-model-lab",
      title: "model-lab",
      root: "/home/uno/projects/model-lab",
      repo: REPO.modelLab,
    },
    {
      id: "p-work-uno-project",
      title: "uno-project",
      root: "/home/uno/projects/uno-project",
      repo: REPO.workspace,
    },
  ],
  product: [
    { id: "p-product-home", title: "Home folder", root: "/home/uno" },
    {
      id: "p-product-uno-work",
      title: "uno-work-app",
      root: "/home/uno/projects/uno-work",
      repo: REPO.work,
    },
    {
      id: "p-product-console",
      title: "uno-console",
      root: "/home/uno/projects/uno-console",
      repo: REPO.console,
    },
    {
      id: "p-product-landing",
      title: "landing",
      root: "/home/uno/projects/landing",
      repo: REPO.landing,
    },
    {
      id: "p-product-uno-project",
      title: "uno-project",
      root: "/home/uno/projects/uno-project",
      repo: REPO.workspace,
    },
  ],
  mac: [
    { id: "p-mac-home", title: "Home folder", root: "/Users/misha" },
    {
      id: "p-mac-fishcode",
      title: "fishcode",
      root: "/Users/misha/projects/fishcode",
      repo: REPO.fishcode,
    },
    {
      id: "p-mac-uno-work",
      title: "uno-work-app",
      root: "/Users/misha/projects/uno-work",
      repo: REPO.work,
    },
    {
      id: "p-mac-uno-project",
      title: "uno-project",
      root: "/Users/misha/projects/uno-project",
      repo: REPO.workspace,
    },
  ],
};

/** Project name by its id, on any computer. */
export function projectTitle(projectId: string): string {
  for (const list of Object.values(PROJECTS)) {
    const found = list.find((project) => project.id === projectId);
    if (found) return found.title;
  }
  return "Home folder";
}

// ── Chats ─────────────────────────────────────────────────────────────────

/** What a chat that waits for the person asks for. */
export type DemoAsk =
  | { kind: "question"; text: string; options: ReadonlyArray<string> }
  | { kind: "permission"; text: string; command: string }
  | { kind: "review"; text: string; pr: string; checks: string }
  | { kind: "payment"; text: string; amount: string };

export type DemoState =
  | "running"
  | "needs-you"
  | "unread"
  | "read"
  | "failed"
  | "snoozed"
  | "scheduled"
  | "done"
  | "archived";

/** How the chat is coordinated. */
export type DemoRole =
  | "coordinator"
  | "validator"
  | "helper"
  | "solo"
  | "assistant"
  | "from-uno"
  | "from-mac";

export interface ChatSpec {
  readonly id: string;
  readonly machine: MachineKey;
  readonly project: string;
  readonly title: string;
  /** Last activity. */
  readonly minutesAgo: number;
  /** Running: how long the turn has been going. */
  readonly runningFor?: number;
  readonly state: DemoState;
  readonly role: DemoRole;
  /** The chat that started this one (any computer). */
  readonly parent?: string;
  readonly ask?: DemoAsk;
  readonly error?: string;
  readonly errorClass?: "billing_error" | "transport_error" | "provider_error";
  /** Scheduled: when it runs next, and how often. */
  readonly schedule?: { at: string; every: string };
  /** Snoozed until. */
  readonly until?: string;
  /** One line about what is going on now (Running, Done). */
  readonly now?: string;
  readonly pinned?: boolean;
  readonly messages: ReadonlyArray<readonly ["user" | "assistant", string]>;
}

export const CHATS: ChatSpec[] = [
  // ── Coordinator 1: a release train, helpers on all three computers ──
  {
    id: "c-train",
    machine: "work",
    project: "p-work-uno-project",
    title: "Train 10.10 — Clean exit IP to prod",
    minutesAgo: 2,
    runningFor: 220,
    state: "running",
    role: "coordinator",
    now: "Waiting for L4 tests, then the console switch",
    messages: [
      [
        "user",
        "Take Clean exit IP to prod tonight: L4 auto for paid accounts, L5 the switch in the console, docs. Split it, run it, tell me only what needs me.",
      ],
      [
        "assistant",
        "Split into 4 tasks:\n1. L4 — paid accounts get a clean exit IP automatically (fishcode · uno-work)\n2. L5 — the switch in the console (uno-console · uno-product)\n3. Knowledge page (uno-project · MacBook)\n4. go test for the exit IP worker (fishcode · MacBook)\n\nStarted all four. I'll merge into the train when each is green.",
      ],
      [
        "assistant",
        "Status 20:40 — docs done, L4 running (tests 70%), L5 asks you about the price on the switch, go test on MacBook stopped: the MacBook went to sleep. I'll restart it on uno-work.",
      ],
    ],
  },
  {
    id: "h-l4",
    machine: "work",
    project: "p-work-fishcode",
    title: "L4: paid accounts get a clean exit IP automatically",
    minutesAgo: 1,
    runningFor: 42,
    state: "running",
    role: "helper",
    parent: "c-train",
    now: "go test ./internal/exitip/... — 31 of 44 passed",
    messages: [
      [
        "user",
        "From coordinator: L4 — give every paid account a clean exit IP on its first box start. Migration + worker + test. Branch feat/exit-ip-l4.",
      ],
      [
        "assistant",
        "Migration 211 adds exit_ip_pool; the worker assigns on box.start for plans ≥ Plus. Running the package tests now.",
      ],
    ],
  },
  {
    id: "h-l5",
    machine: "product",
    project: "p-product-console",
    title: "L5: exit IP switch in the console",
    minutesAgo: 9,
    state: "needs-you",
    role: "helper",
    parent: "c-train",
    ask: {
      kind: "question",
      text: "Show the price right on the switch, or only in Billing?",
      options: ["On the switch: “+$3/mo”", "Only in Billing"],
    },
    messages: [
      [
        "user",
        "From coordinator: L5 — a switch “Clean exit IP” on the computer page. Copy in the product's words.",
      ],
      [
        "assistant",
        "The switch is in Computer → Network, preview on stage. One thing to decide: show the price right on the switch, or only in Billing?",
      ],
    ],
  },
  {
    id: "h-docs",
    machine: "mac",
    project: "p-mac-uno-project",
    title: "Knowledge page: Clean exit IP",
    minutesAgo: 34,
    state: "unread",
    role: "helper",
    parent: "c-train",
    now: "knowledge/exit-ip.md + the SEO copy",
    messages: [
      ["user", "From coordinator: write knowledge/exit-ip.md and update knowledge-seo too."],
      [
        "assistant",
        "Done: knowledge/exit-ip.md (what it is, when you need it, price) and the same in knowledge-seo/. Committed to uno-workspace.",
      ],
    ],
  },
  {
    id: "h-gotest",
    machine: "mac",
    project: "p-mac-fishcode",
    title: "go test for the exit IP worker",
    minutesAgo: 51,
    state: "failed",
    role: "helper",
    parent: "c-train",
    error: "The MacBook went to sleep — the run stopped at 61%.",
    errorClass: "transport_error",
    messages: [
      ["user", "From coordinator: run the full go test for internal/exitip with -race."],
      ["assistant", "Running go test -race ./internal/exitip/... (61%)"],
    ],
  },

  // ── Validator: checks the 0.0.118 rollout before it goes to everyone ──
  {
    id: "v-0118",
    machine: "product",
    project: "p-product-uno-work",
    title: "Validate Work 0.0.118 before it goes to everyone",
    minutesAgo: 6,
    state: "needs-you",
    role: "validator",
    ask: {
      kind: "permission",
      text: "Canary 2534 is green. Promote 0.0.118 to latest (Update for everyone)?",
      command: "./scripts/release-work.sh promote 0.0.118",
    },
    messages: [
      [
        "user",
        "Validate 0.0.118 on the canary: smoke test, a 1 GB upload to the cloud, rollback ready. Then ask me before latest.",
      ],
      [
        "assistant",
        "Both checks passed (41/41 smoke steps, 1 GB upload in 38 s). Rollback: release-work.sh rollback 0.0.118. I need your OK to promote to latest.",
      ],
    ],
  },
  {
    id: "v-smoke",
    machine: "product",
    project: "p-product-uno-work",
    title: "Smoke test on canary 2534 (41 steps)",
    minutesAgo: 14,
    state: "unread",
    role: "helper",
    parent: "v-0118",
    now: "41 of 41 steps passed, 6 screenshots",
    messages: [
      ["user", "From validator: run the Playwright smoke on canary 2534."],
      ["assistant", "41/41 passed. Screenshots in reports/day_2026-10-09/work-0118/."],
    ],
  },
  {
    id: "v-upload",
    machine: "work",
    project: "p-work-uno-project",
    title: "1 GB upload to Uno cloud on the canary",
    minutesAgo: 19,
    state: "read",
    role: "helper",
    parent: "v-0118",
    now: "1.0 GB in 38 s, file opens in Drive",
    messages: [
      ["user", "From validator: upload a 1 GB file to the cloud from canary 2534 and open it."],
      ["assistant", "Uploaded in 38 s, opened in Drive, checksum matches."],
    ],
  },

  // ── Coordinator 2: the ICP pass, helpers mostly on uno-product ──
  {
    id: "c-icp3",
    machine: "product",
    project: "p-product-uno-project",
    title: "ICP pass v3 — fixes to stage",
    minutesAgo: 12,
    state: "read",
    role: "coordinator",
    now: "3 of 4 helpers done · 1 waits for your review",
    messages: [
      [
        "user",
        "Walk the heavy-user path again, fix what's broken, put it on stage. Ask me only for merges.",
      ],
      [
        "assistant",
        "4 helpers: stale welcome fix (done), QA prod run (done, 33 findings), sidebar variants (running), PR #412 Inbox says which computer — waits for your review.",
      ],
    ],
  },
  {
    id: "h-stale",
    machine: "product",
    project: "p-product-uno-work",
    title: "A fresh computer opens broken (stale welcome)",
    minutesAgo: 95,
    state: "read",
    role: "helper",
    parent: "c-icp3",
    now: "fix/icp3-stale-welcome merged to stage",
    messages: [
      [
        "user",
        "From coordinator: a new computer shows an old welcome until the daemon restarts. Fix.",
      ],
      ["assistant", "Fixed in fix/icp3-stale-welcome, on stage. Checked on a fresh box."],
    ],
  },
  {
    id: "h-qa",
    machine: "product",
    project: "p-product-uno-project",
    title: "QA run on prod: 33 findings",
    minutesAgo: 27,
    state: "unread",
    role: "helper",
    parent: "c-icp3",
    now: "Report: qa-prod-0910.uno4.me",
    messages: [
      [
        "user",
        "From coordinator: QA prod as a newcomer and as a heavy user, report with screenshots.",
      ],
      ["assistant", "33 findings, 1 blocker (fresh Workspace). Report: qa-prod-0910.uno4.me"],
    ],
  },
  {
    id: "h-variants",
    machine: "product",
    project: "p-product-uno-work",
    title: "Sidebar variants for heavy usage",
    minutesAgo: 0,
    runningFor: 65,
    state: "running",
    role: "helper",
    parent: "c-icp3",
    now: "Building V3 — the coordination tree",
    messages: [
      ["user", "From coordinator: 3–4 variants of the sidebar for heavy usage, Inbox first."],
      ["assistant", "V1 and V2 are done, building V3 — the coordination tree."],
    ],
  },
  {
    id: "h-pr412",
    machine: "mac",
    project: "p-mac-uno-work",
    title: "PR #412: Inbox says which computer",
    minutesAgo: 22,
    state: "needs-you",
    role: "helper",
    parent: "c-icp3",
    ask: {
      kind: "review",
      text: "PR #412 is green. Merge into release/0.0.119?",
      pr: "#412",
      checks: "tsc ✓ · 1,204 tests ✓ · 3 files",
    },
    messages: [
      ["user", "From coordinator: Inbox rows should say “project · computer”. Open a PR."],
      [
        "assistant",
        "PR #412 — every Inbox row says “uno-console · uno-product”. Checks are green. Merge into release/0.0.119?",
      ],
    ],
  },

  // ── An agent on the MacBook started a run in the cloud ──
  {
    id: "m-plan",
    machine: "mac",
    project: "p-mac-uno-project",
    title: "Plan training run #7 (Qwen, sessions corpus)",
    minutesAgo: 140,
    state: "read",
    role: "solo",
    now: "Started run #7 on uno-work",
    messages: [
      [
        "user",
        "Plan the next fine-tune: what data, how long, how much. Start it in the cloud, not here.",
      ],
      [
        "assistant",
        "Run #7: 14.7k replies, 3 epochs, 2×H100 for ~3 h ($19). The MacBook is too weak — started it on uno-work in model-lab.",
      ],
    ],
  },
  {
    id: "m-train",
    machine: "work",
    project: "p-work-model-lab",
    title: "Training run #7 on Nebius — 2×H100",
    minutesAgo: 3,
    runningFor: 130,
    state: "running",
    role: "from-mac",
    parent: "m-plan",
    now: "Epoch 2 of 3 · loss 0.81 · ~55 min left",
    messages: [
      ["user", "From MacBook chat: run #7 — config runs/r7.yaml, report loss every 30 min."],
      ["assistant", "Epoch 2/3, loss 0.81, ETA 55 min. $11.40 spent so far."],
    ],
  },
  {
    id: "w-bench",
    machine: "work",
    project: "p-work-model-lab",
    title: "Bench: our model vs Opus on 120 ops tasks",
    minutesAgo: 48,
    state: "unread",
    role: "solo",
    now: "Ours 71% · Opus 88% · 6× cheaper",
    messages: [
      ["user", "Bench run #6 against Opus on the ops set."],
      ["assistant", "Ours 71%, Opus 88%. Ours is 6× cheaper. Weak spots: ssh + psql chains."],
    ],
  },

  // ── Uno, the assistant: tasks from Telegram ──
  {
    id: "uno-main",
    machine: "work",
    project: ASSISTANT_PROJECT_ID,
    title: "Uno",
    minutesAgo: 16,
    state: "read",
    role: "assistant",
    pinned: true,
    messages: [
      ["user", "📱 Telegram: remind me to pay Hostkey before the 12th"],
      [
        "assistant",
        "Opened a chat for it: the invoice is $347 (hector-nl). I'll ask you to pay from the card — one button.",
      ],
      ["user", "📱 Telegram: what's broken on prod right now?"],
      [
        "assistant",
        "Nothing red. Contabo load is 9 (normal for evening). 2 chats failed today — both on the MacBook while it slept.",
      ],
      ["user", "📱 Telegram: every morning at 8 send me the plan for the day"],
      ["assistant", "Done — “Morning plan” runs every day at 08:00 and lands in Telegram."],
    ],
  },
  {
    id: "u-hostkey",
    machine: "work",
    project: "p-work-home",
    title: "Pay the Hostkey invoice (hector-nl)",
    minutesAgo: 15,
    state: "needs-you",
    role: "from-uno",
    parent: "uno-main",
    ask: {
      kind: "payment",
      text: "Pay $347 to Hostkey for hector-nl from the card ending 4412?",
      amount: "$347",
    },
    messages: [
      ["user", "From Uno (Telegram): pay Hostkey before the 12th."],
      [
        "assistant",
        "Invoice #HK-88213: $347 for hector-nl, due Oct 12. Pay from the card ending 4412?",
      ],
    ],
  },
  {
    id: "u-morning",
    machine: "work",
    project: "p-work-home",
    title: "Morning plan",
    minutesAgo: 60 * 13,
    state: "scheduled",
    role: "from-uno",
    parent: "uno-main",
    schedule: { at: nextAt(8), every: "every day at 08:00" },
    messages: [
      ["user", "From Uno: every morning — what's running, what needs Misha, what's due today."],
      [
        "assistant",
        "Today: 2 releases waiting, Hostkey due in 3 days, AI hours 82% used. Sent to Telegram.",
      ],
    ],
  },

  // ── The person's own chats ──
  {
    id: "s-billing",
    machine: "product",
    project: "p-product-console",
    title: "Billing page is too busy",
    minutesAgo: 0,
    runningFor: 8,
    state: "running",
    role: "solo",
    now: "Cutting the page to 3 blocks",
    messages: [
      ["user", "Billing page — nobody understands it. Three blocks max, tooltips for the rest."],
      ["assistant", "Cutting it to Plan · Balance · History. Preview on stage in a few minutes."],
    ],
  },
  {
    id: "s-macbuild",
    machine: "mac",
    project: "p-mac-uno-work",
    title: "Build Work.app for macOS (0.0.119)",
    minutesAgo: 1,
    runningFor: 12,
    state: "running",
    role: "solo",
    now: "Signing and notarizing — step 3 of 4",
    messages: [
      ["user", "Build the macOS app from release/0.0.119 and notarize it."],
      ["assistant", "Built. Signing and notarizing now (step 3 of 4)."],
    ],
  },
  {
    id: "s-contabo",
    machine: "work",
    project: "p-work-fishcode",
    title: "Why is Contabo load 9?",
    minutesAgo: 25,
    state: "unread",
    role: "solo",
    now: "The journal scan every 5 min — fixed",
    messages: [
      ["user", "Contabo load is 9 again. Why?"],
      [
        "assistant",
        "A cron did a wide journal scan every 5 min. Moved it to hourly with a window — load is 3.1 now.",
      ],
    ],
  },
  {
    id: "s-drag",
    machine: "mac",
    project: "p-mac-uno-work",
    title: "Drag chats between projects",
    minutesAgo: 70,
    state: "failed",
    role: "solo",
    error: "Claude subscription: weekly limit reached. Continue on Uno AI?",
    errorClass: "billing_error",
    messages: [
      ["user", "Let me drag a chat into another project in the sidebar."],
      ["assistant", "Half done: drag works inside one computer…"],
    ],
  },
  {
    id: "s-pricing",
    machine: "product",
    project: "p-product-landing",
    title: "Rewrite the pricing section",
    minutesAgo: 190,
    state: "read",
    role: "solo",
    now: "Live on uno.place",
    messages: [
      ["user", "Pricing on the landing: by jobs, not by specs."],
      [
        "assistant",
        "Rewritten by jobs (“one agent”, “a team of agents”, “all night”). Live on uno.place.",
      ],
    ],
  },
  {
    id: "s-hero",
    machine: "product",
    project: "p-product-landing",
    title: "Hero video — 30 s cut",
    minutesAgo: 60 * 6,
    state: "snoozed",
    role: "solo",
    until: nextAt(10, 1),
    messages: [
      ["user", "Cut the hero video to 30 s from the screen recordings."],
      ["assistant", "Draft cut is ready (34 s). Paused until Monday, as you asked."],
    ],
  },
  {
    id: "s-spark",
    machine: "work",
    project: "p-work-home",
    title: "Spark: S2 network plan",
    minutesAgo: 60 * 20,
    state: "snoozed",
    role: "solo",
    until: nextAt(9),
    messages: [
      ["user", "Plan S2 for Spark: network inside the VM on seL4."],
      ["assistant", "Plan is written (virtio-net, 5 steps). Paused until tomorrow 09:00."],
    ],
  },
  {
    id: "s-nodes",
    machine: "mac",
    project: "p-mac-home",
    title: "Order 2 more nodes from Hostkey?",
    minutesAgo: 60 * 26,
    state: "read",
    role: "solo",
    messages: [
      ["user", "Do we need 2 more nodes this month?"],
      ["assistant", "Not yet: hector-nl is at 61% RAM. Order when it passes 75%."],
    ],
  },
  {
    id: "s-memory",
    machine: "work",
    project: "p-work-uno-project",
    title: "Weekly memory cleanup",
    minutesAgo: 60 * 50,
    state: "scheduled",
    role: "solo",
    schedule: { at: nextAt(10, 0), every: "Sundays at 10:00" },
    messages: [
      ["user", "Every Sunday: tidy agent-memory, merge duplicates, archive old notes."],
      ["assistant", "Last run: 14 notes merged, 9 archived."],
    ],
  },
  {
    id: "s-hector",
    machine: "product",
    project: "p-product-home",
    title: "Answer Hector about the NL node",
    minutesAgo: 60 * 5,
    state: "read",
    role: "solo",
    messages: [
      ["user", "Draft a reply to Hector: the node is back, what happened."],
      ["assistant", "Draft is in Gmail: short, with the timeline and the credit."],
    ],
  },
  {
    id: "s-r2",
    machine: "work",
    project: "p-work-uno-project",
    title: "R2 catch-up #1",
    minutesAgo: 60 * 9,
    state: "done",
    role: "solo",
    messages: [
      ["user", "Run the first R2 catch-up for customer buckets."],
      ["assistant", "Done: 39 buckets checked, 0 files missing."],
    ],
  },
  {
    id: "s-0117",
    machine: "product",
    project: "p-product-uno-work",
    title: "Work 0.0.117: stale UI",
    minutesAgo: 60 * 28,
    state: "done",
    role: "solo",
    messages: [
      ["user", "Ship 0.0.117."],
      ["assistant", "In prod. Latest 295a8c79."],
    ],
  },
  {
    id: "a-0116",
    machine: "product",
    project: "p-product-uno-work",
    title: "Work 0.0.116 release",
    minutesAgo: 60 * 40,
    state: "archived",
    role: "solo",
    messages: [["assistant", "0.0.116 in prod."]],
  },
  {
    id: "a-bonuses",
    machine: "mac",
    project: "p-mac-home",
    title: "Bonuses program copy",
    minutesAgo: 60 * 80,
    state: "archived",
    role: "solo",
    messages: [["assistant", "Copy approved."]],
  },
  {
    id: "a-r2",
    machine: "work",
    project: "p-work-fishcode",
    title: "Customer buckets to R2",
    minutesAgo: 60 * 30,
    state: "archived",
    role: "solo",
    messages: [["assistant", "All 39 buckets on R2."]],
  },
];

export function chatById(id: string): ChatSpec | undefined {
  return CHATS.find((chat) => chat.id === id);
}

// ── Wire shapes ───────────────────────────────────────────────────────────

function requestIdOf(chat: ChatSpec) {
  return `${chat.id}-req`;
}

function askActivity(chat: ChatSpec, at: string, turnId: string) {
  const ask = chat.ask;
  if (!ask || chat.state !== "needs-you") return [];
  if (ask.kind === "permission") {
    return [
      {
        id: `${chat.id}-approval`,
        tone: "approval",
        kind: "approval.requested",
        summary: "Waiting for your OK",
        payload: {
          requestId: requestIdOf(chat),
          requestKind: "command",
          detail: ask.command,
        },
        turnId,
        createdAt: at,
      },
    ];
  }
  const options =
    ask.kind === "question"
      ? ask.options
      : ask.kind === "review"
        ? ["Merge", "Not yet"]
        : [`Pay ${ask.amount}`, "Remind me later"];
  return [
    {
      id: `${chat.id}-input`,
      tone: "info",
      kind: "user-input.requested",
      summary: "Waiting for your answer",
      payload: {
        requestId: requestIdOf(chat),
        questions: [
          {
            id: "q1",
            header:
              ask.kind === "review" ? "Review" : ask.kind === "payment" ? "Payment" : "Question",
            question: ask.text,
            options: options.map((label) => ({ label, description: label })),
          },
        ],
      },
      turnId,
      createdAt: at,
    },
  ];
}

export function buildThread(chat: ChatSpec) {
  const updated = ago(chat.minutesAgo);
  const startedMinutes = chat.runningFor ?? 6;
  const created = ago(chat.minutesAgo + Math.max(startedMinutes, chat.messages.length * 3));
  const turnId = `turn-${chat.id}`;
  const running = chat.state === "running";
  const failed = chat.state === "failed";
  const step = chat.messages.length > 1 ? 1 : 0;
  const messages = chat.messages.map(([role, text], index) => {
    const at = ago(chat.minutesAgo + (chat.messages.length - 1 - index) * (step + 2));
    const last = index === chat.messages.length - 1;
    return {
      id: `${chat.id}-m${index}`,
      role,
      text,
      turnId: role === "assistant" ? turnId : null,
      streaming: running && last && role === "assistant",
      createdAt: index === 0 ? created : at,
      updatedAt: index === 0 ? created : at,
    };
  });
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const turnStartedAt = running ? ago(chat.runningFor ?? chat.minutesAgo + 3) : created;
  return {
    id: chat.id,
    projectId: chat.project,
    title: chat.title,
    modelSelection: MODEL,
    interactionMode: "default",
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId,
      state: running ? "running" : failed ? "error" : "completed",
      requestedAt: turnStartedAt,
      startedAt: turnStartedAt,
      completedAt: running ? null : updated,
      assistantMessageId: lastAssistant?.id ?? null,
    },
    createdAt: created,
    updatedAt: updated,
    archivedAt: chat.state === "archived" ? ago(chat.minutesAgo - 30) : null,
    pinnedAt: chat.pinned ? ago(60 * 24 * 7) : null,
    snoozedUntil:
      chat.state === "snoozed"
        ? (chat.until ?? later(60 * 12))
        : chat.state === "scheduled"
          ? (chat.schedule?.at ?? later(60 * 12))
          : null,
    snoozedAt:
      chat.state === "snoozed" || chat.state === "scheduled" ? ago(chat.minutesAgo - 1) : null,
    settledOverride: chat.state === "done" ? "settled" : null,
    settledAt: chat.state === "done" ? ago(chat.minutesAgo - 10) : null,
    // The parent is linked only on its own computer (that is all the daemon
    // knows today); a helper on another computer is linked by CHAT_META.
    spawnedByThreadId:
      chat.parent && chatById(chat.parent)?.machine === chat.machine ? chat.parent : null,
    controller: chat.parent ? "agent" : "human",
    controlChangedAt: null,
    assistantRole: chat.role === "assistant" ? "chat" : chat.role === "from-uno" ? "spawned" : null,
    deletedAt: null,
    messages,
    proposedPlans: [],
    activities: askActivity(chat, updated, turnId),
    checkpoints: [],
    session: {
      threadId: chat.id,
      status: running ? "running" : failed ? "error" : "ready",
      providerName: "uno",
      providerInstanceId: UNO,
      runtimeMode: "full-access",
      activeTurnId: running ? turnId : null,
      lastError: failed ? (chat.error ?? "Stopped") : null,
      ...(failed && chat.errorClass ? { lastErrorClass: chat.errorClass } : {}),
      updatedAt: updated,
    },
  };
}

export type WireThread = ReturnType<typeof buildThread>;

function buildProject(project: ProjectSpec) {
  const at = ago(60 * 24 * 30);
  return {
    id: project.id,
    title: project.title,
    workspaceRoot: project.root,
    repositoryIdentity: project.repo
      ? {
          canonicalKey: project.repo,
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: `https://${project.repo}.git`,
          },
          rootPath: project.root,
          displayName: project.title,
          name: project.title,
        }
      : null,
    defaultModelSelection: MODEL,
    scripts: [],
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
}

export function readModelFor(machine: DemoMachine): OrchestrationReadModel {
  return {
    snapshotSequence: 5,
    projects: PROJECTS[machine.key].map(buildProject),
    threads: CHATS.filter((chat) => chat.machine === machine.key).map(buildThread),
    updatedAt: new Date(NOW).toISOString(),
  } as unknown as OrchestrationReadModel;
}

function pendingOf(thread: WireThread) {
  const open = new Map<string, string>();
  for (const activity of thread.activities as Array<{ kind: string; payload: unknown }>) {
    const requestId = (activity.payload as { requestId?: string } | null)?.requestId;
    if (!requestId) continue;
    if (activity.kind.endsWith(".requested")) open.set(requestId, activity.kind);
    if (activity.kind.endsWith(".resolved")) open.delete(requestId);
  }
  const kinds = [...open.values()];
  return {
    approvals: kinds.includes("approval.requested"),
    input: kinds.includes("user-input.requested"),
  };
}

export function toShellThread(thread: WireThread) {
  const pending = pendingOf(thread);
  const lastUser = [...thread.messages].reverse().find((message) => message.role === "user");
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    snoozedUntil: thread.snoozedUntil,
    snoozedAt: thread.snoozedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    spawnedByThreadId: thread.spawnedByThreadId,
    controller: thread.controller,
    controlChangedAt: null,
    assistantRole: thread.assistantRole,
    session: thread.session,
    latestUserMessageAt: lastUser?.createdAt ?? null,
    hasPendingApprovals: pending.approvals,
    hasPendingUserInput: pending.input,
    hasActionableProposedPlan: false,
  };
}

export function toShellSnapshot(model: OrchestrationReadModel) {
  const threads = model.threads as unknown as Array<WireThread & { deletedAt: string | null }>;
  return {
    snapshotSequence: model.snapshotSequence,
    projects: model.projects.map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      repositoryIdentity: project.repositoryIdentity ?? null,
      defaultModelSelection: project.defaultModelSelection,
      scripts: project.scripts,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })),
    threads: threads.filter((thread) => thread.deletedAt === null).map(toShellThread),
    updatedAt: model.updatedAt,
  };
}

// ── Inbox ─────────────────────────────────────────────────────────────────

interface InboxSpec {
  readonly id: string;
  readonly machine: MachineKey;
  readonly kind: InboxItem["kind"];
  readonly minutesAgo: number;
  readonly title: string;
  readonly body: string | null;
  /** Agent items: the chat. */
  readonly chat?: string;
  /** App / Uno items. */
  readonly source?: { kind: "app" | "system"; id: string; name: string; icon: string | null };
  readonly open?: InboxItem["open"];
  readonly read?: boolean;
  /** For the variants: deploy / merge / money read differently from a chat event. */
  readonly tag?: "deploy" | "merge" | "money";
}

export const INBOX: InboxSpec[] = [
  // uno-work
  {
    id: "i-hostkey",
    machine: "work",
    kind: "agent.input",
    minutesAgo: 15,
    chat: "u-hostkey",
    title: "Pay the Hostkey invoice (hector-nl)",
    body: "Pay $347 to Hostkey for hector-nl from the card ending 4412?",
  },
  {
    id: "i-contabo",
    machine: "work",
    kind: "agent.done",
    minutesAgo: 25,
    chat: "s-contabo",
    title: "Finished: Why is Contabo load 9?",
    body: "A cron did a wide journal scan every 5 min. Load is 3.1 now.",
  },
  {
    id: "i-bench",
    machine: "work",
    kind: "agent.done",
    minutesAgo: 48,
    chat: "w-bench",
    title: "Finished: Bench — our model vs Opus",
    body: "Ours 71%, Opus 88%, 6× cheaper.",
  },
  {
    id: "i-hours",
    machine: "work",
    kind: "app",
    minutesAgo: 32,
    tag: "money",
    source: { kind: "system", id: "uno", name: "Uno", icon: "⏱" },
    title: "AI hours: 82% of this week used",
    body: "9 h left, resets Monday. Agents switch to economy at 95%.",
    open: { kind: "url", url: "https://console.uno4.dev/billing" },
  },
  {
    id: "i-deploy-fishcode",
    machine: "work",
    kind: "app",
    minutesAgo: 66,
    tag: "deploy",
    read: true,
    source: { kind: "app", id: "deploy", name: "Deploy", icon: "🚀" },
    title: "fishcode a210f14 is in prod",
    body: "R2 customer buckets · 0 errors in 10 min",
    open: { kind: "url", url: "https://api.getuno.xyz/health" },
  },
  // uno-product
  {
    id: "i-l5",
    machine: "product",
    kind: "agent.input",
    minutesAgo: 9,
    chat: "h-l5",
    title: "L5: exit IP switch in the console",
    body: "Show the price right on the switch, or only in Billing?",
  },
  {
    id: "i-0118",
    machine: "product",
    kind: "agent.approval",
    minutesAgo: 6,
    chat: "v-0118",
    title: "Validate Work 0.0.118 before it goes to everyone",
    body: "Promote 0.0.118 to latest (Update for everyone)?",
  },
  {
    id: "i-qa",
    machine: "product",
    kind: "agent.done",
    minutesAgo: 27,
    chat: "h-qa",
    title: "Finished: QA run on prod — 33 findings",
    body: "1 blocker (fresh Workspace). Report: qa-prod-0910.uno4.me",
  },
  {
    id: "i-smoke",
    machine: "product",
    kind: "agent.done",
    minutesAgo: 14,
    chat: "v-smoke",
    title: "Finished: Smoke test on canary 2534",
    body: "41 of 41 steps passed.",
  },
  {
    id: "i-merge-409",
    machine: "product",
    kind: "app",
    minutesAgo: 88,
    tag: "merge",
    source: { kind: "app", id: "github", name: "GitHub", icon: "⑂" },
    title: "PR #409 merged into release/0.0.119",
    body: "A fresh computer opens broken (stale welcome)",
    open: { kind: "url", url: "https://github.com/getuno/uno-work/pull/409" },
  },
  {
    id: "i-stage",
    machine: "product",
    kind: "app",
    minutesAgo: 40,
    tag: "deploy",
    read: true,
    source: { kind: "app", id: "deploy", name: "Deploy", icon: "🚀" },
    title: "stage.uno4.dev updated",
    body: "console 966324b · Work stage/work 4c1e0aa",
    open: { kind: "url", url: "https://stage.uno4.dev" },
  },
  // MacBook
  {
    id: "i-pr412",
    machine: "mac",
    kind: "agent.input",
    minutesAgo: 22,
    chat: "h-pr412",
    title: "PR #412: Inbox says which computer",
    body: "PR #412 is green. Merge into release/0.0.119?",
  },
  {
    id: "i-gotest",
    machine: "mac",
    kind: "agent.error",
    minutesAgo: 51,
    chat: "h-gotest",
    title: "Stopped: go test for the exit IP worker",
    body: "The MacBook went to sleep — the run stopped at 61%.",
  },
  {
    id: "i-drag",
    machine: "mac",
    kind: "agent.error",
    minutesAgo: 70,
    chat: "s-drag",
    tag: "money",
    title: "Stopped: Drag chats between projects",
    body: "Claude subscription: weekly limit reached. Continue on Uno AI?",
  },
  {
    id: "i-docs",
    machine: "mac",
    kind: "agent.done",
    minutesAgo: 34,
    chat: "h-docs",
    title: "Finished: Knowledge page — Clean exit IP",
    body: "knowledge/exit-ip.md and knowledge-seo/ updated.",
  },
];

export function inboxSpecById(id: string): InboxSpec | undefined {
  return INBOX.find((item) => item.id === id);
}

export function buildInboxItem(spec: InboxSpec): InboxItem {
  const at = ago(spec.minutesAgo);
  const chat = spec.chat ? chatById(spec.chat) : undefined;
  return {
    id: spec.id,
    kind: spec.kind,
    source: chat
      ? { kind: "agent", id: chat.id, name: chat.title, icon: null }
      : (spec.source ?? { kind: "system", id: "uno", name: "Uno", icon: null }),
    title: spec.title,
    body: spec.body,
    open: chat ? { kind: "thread", threadId: chat.id } : (spec.open ?? null),
    createdAt: at,
    updatedAt: at,
    count: 1,
    readAt: spec.read ? at : null,
    snoozedUntil: null,
  };
}
