/**
 * Sidebar prototype (w0115, NOT FOR MERGE): the mock account — two computers,
 * a handful of projects (one empty), ~16 chats, some Done / Snoozed / waiting
 * for the person. Shapes follow the daemon's wire contracts so the real web
 * client renders them as it would a real computer.
 */
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationReadModel,
  type ServerConfig,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";

export const ENV_CLOUD = EnvironmentId.make("env-proto-cloud");
export const ENV_MAC = EnvironmentId.make("env-proto-mac");

export interface ProtoMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly host: string;
  readonly home: string;
  readonly os: "linux" | "darwin";
  readonly machineKind: "uno_box" | "computer";
}

export const MACHINES: Record<string, ProtoMachine> = {
  [ENV_CLOUD]: {
    environmentId: ENV_CLOUD,
    label: "Cloud",
    host: "",
    home: "/home/anna",
    os: "linux",
    machineKind: "uno_box",
  },
  [ENV_MAC]: {
    environmentId: ENV_MAC,
    label: "MacBook",
    host: "macbook.proto.uno4.me",
    home: "/Users/anna",
    os: "darwin",
    machineKind: "computer",
  },
};

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const later = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const UNO = ProviderInstanceId.make("uno");
const MODEL = { instanceId: UNO, model: "uno/smart" } as const;

export function descriptorFor(machine: ProtoMachine): ExecutionEnvironmentDescriptor {
  return {
    environmentId: machine.environmentId,
    label: machine.label,
    platform: { os: machine.os, arch: machine.os === "darwin" ? "arm64" : "x64" },
    serverVersion: "0.0.115",
    capabilities: {
      repositoryIdentity: true,
      threadSnooze: true,
      threadSettlement: true,
      agentThreads: true,
      threadContinueDirect: true,
      assistantChat: true,
    },
    machineKind: machine.machineKind,
    ...(machine.machineKind === "uno_box" ? { unoBoxId: 2401 } : {}),
  };
}

export function serverConfigFor(machine: ProtoMachine): ServerConfig {
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
        version: "0.0.115",
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

// ── Projects and chats ──────────────────────────────────────────────────

interface ChatSpec {
  id: string;
  project: string;
  title: string;
  minutesAgo: number;
  state?: "done" | "snoozed" | "running" | "needs-you" | "unread";
  ask?: string;
  answer?: string;
}

interface ProjectSpec {
  id: string;
  title: string;
  root: string;
  /** Same repository on several computers = one project (shared Uno folder on our git). */
  repo?: string;
}

/** brand-kit lives on both computers: a shared Uno folder, i.e. one repository on our git. */
const BRAND_KIT_REPO = "git.uno4.me/anna/brand-kit";

function repositoryIdentityOf(project: ProjectSpec) {
  if (!project.repo) return null;
  return {
    canonicalKey: project.repo,
    locator: { source: "git-remote" as const, remoteName: "uno", remoteUrl: `https://${project.repo}.git` },
    rootPath: project.root,
    displayName: project.title,
    name: project.title,
  };
}

const CLOUD_PROJECTS: ProjectSpec[] = [
  { id: "p-cloud-home", title: "Home folder", root: "/home/anna" },
  { id: "p-yoga-site", title: "yoga-site", root: "/home/anna/projects/yoga-site" },
  { id: "p-studio-bot", title: "studio-bot", root: "/home/anna/projects/studio-bot" },
  { id: "p-newsletter", title: "newsletter", root: "/home/anna/projects/newsletter" },
  {
    id: "p-cloud-brand-kit",
    title: "brand-kit",
    root: "/home/anna/projects/brand-kit",
    repo: BRAND_KIT_REPO,
  },
];

const MAC_PROJECTS: ProjectSpec[] = [
  { id: "p-mac-home", title: "Home folder", root: "/Users/anna" },
  {
    id: "p-brand-kit",
    title: "brand-kit",
    root: "/Users/anna/projects/brand-kit",
    repo: BRAND_KIT_REPO,
  },
];

const CLOUD_CHATS: ChatSpec[] = [
  {
    id: "t-booking",
    project: "p-yoga-site",
    title: "Add a booking form to the site",
    minutesAgo: 3,
    state: "running",
    ask: "Add a form so people can book a class: name, phone, which class.",
    answer: "Adding the form to the Schedule page now — I'll show you a preview in a minute.",
  },
  {
    id: "t-bot-reminders",
    project: "p-studio-bot",
    title: "Remind people an hour before class",
    minutesAgo: 12,
    state: "needs-you",
    ask: "Can the bot remind people one hour before their class?",
    answer: "Yes. Which time zone is the studio in? I need it to send reminders on time.",
  },
  {
    id: "t-instagram",
    project: "p-cloud-home",
    title: "Plan this week's Instagram posts",
    minutesAgo: 40,
    state: "unread",
    ask: "Plan 5 Instagram posts for this week about the new morning classes.",
    answer: "Here are five posts with captions and photo ideas. The first one is ready to post today.",
  },
  {
    id: "t-prices",
    project: "p-cloud-home",
    title: "Autumn price list",
    minutesAgo: 95,
    ask: "Make a one-page price list for autumn: drop-in, 10 classes, monthly.",
    answer: "Done — autumn-prices.pdf is in your Home folder.",
  },
  {
    id: "t-print-files",
    project: "p-cloud-brand-kit",
    title: "Print-ready files for the printer",
    minutesAgo: 55,
    ask: "Make print-ready PDFs of the business cards for the print shop.",
    answer: "cards-print.pdf is in brand-kit — CMYK, 3 mm bleed, as the shop asked.",
  },
  {
    id: "t-teachers",
    project: "p-yoga-site",
    title: "Photos on the Teachers page look blurry",
    minutesAgo: 180,
    ask: "The teachers' photos look blurry on phones.",
    answer: "I replaced them with sharper versions. Check the Teachers page on your phone.",
  },
  {
    id: "t-bot-times",
    project: "p-studio-bot",
    title: "Bot answers about class times",
    minutesAgo: 60 * 26,
    ask: "Teach the bot to answer 'when is the next class?'",
    answer: "The bot now answers with the next three classes from your schedule.",
  },
  {
    id: "t-spanish",
    project: "p-cloud-home",
    title: "Translate the schedule to Spanish",
    minutesAgo: 60 * 30,
    state: "snoozed",
    ask: "Translate the schedule to Spanish for the website.",
    answer: "Translated. Want me to add a language switch to the site?",
  },
  {
    id: "t-emails",
    project: "p-cloud-home",
    title: "Reply to studio emails",
    minutesAgo: 60 * 50,
    state: "done",
    ask: "Draft polite replies to the three emails about refunds.",
    answer: "Three drafts are ready in your Gmail.",
  },
  {
    id: "t-publish-schedule",
    project: "p-yoga-site",
    title: "Publish the autumn schedule",
    minutesAgo: 60 * 72,
    state: "done",
    ask: "Put the autumn schedule on the site.",
    answer: "It's live on the Schedule page.",
  },
  {
    id: "t-newsletter",
    project: "p-cloud-home",
    title: "October newsletter draft",
    minutesAgo: 60 * 96,
    state: "done",
    ask: "Write the October newsletter.",
    answer: "Draft is in newsletter-october.md.",
  },
];

CLOUD_CHATS.push({
  id: "t-flyer",
  project: "p-cloud-brand-kit",
  title: "Autumn flyer with the new logo",
  minutesAgo: 60 * 50,
  state: "done",
  ask: "Make an A5 flyer for autumn classes with the new logo.",
  answer: "flyer-autumn.pdf is in brand-kit.",
});

const MAC_CHATS: ChatSpec[] = [
  {
    id: "t-logo",
    project: "p-brand-kit",
    title: "Logo options for the new studio",
    minutesAgo: 25,
    state: "needs-you",
    ask: "Give me three logo ideas for 'Lotus Room'.",
    answer: "Three options are ready. Which one should I polish — A, B or C?",
  },
  {
    id: "t-photos",
    project: "p-mac-home",
    title: "Sort the retreat photos",
    minutesAgo: 70,
    ask: "Sort the retreat photos in Downloads by day and remove duplicates.",
    answer: "Sorted into 4 folders by day, 37 duplicates moved to Trash.",
  },
  {
    id: "t-cards",
    project: "p-brand-kit",
    title: "Business card layout",
    minutesAgo: 60 * 20,
    ask: "Make a business card with the new logo.",
    answer: "card-front.pdf and card-back.pdf are in brand-kit.",
  },
  {
    id: "t-invoice",
    project: "p-mac-home",
    title: "Invoice for Maria (design work)",
    minutesAgo: 60 * 28,
    state: "snoozed",
    ask: "Make an invoice for Maria for 12 hours of design work.",
    answer: "Invoice ready. Should I email it on Monday?",
  },
  {
    id: "t-palette",
    project: "p-brand-kit",
    title: "Color palette",
    minutesAgo: 60 * 80,
    state: "done",
    ask: "Pick a calm color palette for the brand.",
    answer: "Five colors with codes are in palette.png.",
  },
];

function buildThread(machine: ProtoMachine, chat: ChatSpec) {
  const created = ago(chat.minutesAgo + 6);
  const updated = ago(chat.minutesAgo);
  const turnId = `turn-${chat.id}`;
  const running = chat.state === "running";
  const messages = [
    {
      id: `${chat.id}-u`,
      role: "user" as const,
      text: chat.ask ?? chat.title,
      turnId: null,
      streaming: false,
      createdAt: created,
      updatedAt: created,
    },
    {
      id: `${chat.id}-a`,
      role: "assistant" as const,
      text: chat.answer ?? "Done.",
      turnId,
      streaming: running,
      createdAt: updated,
      updatedAt: updated,
    },
  ];
  const activities =
    chat.state === "needs-you"
      ? [
          {
            id: `${chat.id}-input`,
            tone: "info",
            kind: "user-input.requested",
            summary: "Waiting for your answer",
            payload: {
              requestId: `${chat.id}-req`,
              questions: [
                {
                  id: "q1",
                  header: "Question",
                  question: chat.answer ?? "Which one?",
                  options: [
                    { label: "Option A", description: "The first one" },
                    { label: "Option B", description: "The second one" },
                  ],
                },
              ],
            },
            turnId,
            createdAt: updated,
          },
        ]
      : [];
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
      state: running ? "running" : "completed",
      requestedAt: created,
      startedAt: created,
      completedAt: running ? null : updated,
      assistantMessageId: `${chat.id}-a`,
    },
    createdAt: created,
    updatedAt: updated,
    archivedAt: null,
    pinnedAt: null,
    snoozedUntil: chat.state === "snoozed" ? later(60 * 20) : null,
    snoozedAt: chat.state === "snoozed" ? ago(chat.minutesAgo - 5) : null,
    settledOverride: chat.state === "done" ? "settled" : null,
    settledAt: chat.state === "done" ? ago(chat.minutesAgo - 10) : null,
    spawnedByThreadId: null,
    controller: "human",
    controlChangedAt: null,
    assistantRole: null,
    deletedAt: null,
    messages,
    proposedPlans: [],
    activities,
    checkpoints: [],
    session: {
      threadId: chat.id,
      status: running ? "running" : "ready",
      providerName: "uno",
      providerInstanceId: UNO,
      runtimeMode: "full-access",
      activeTurnId: running ? turnId : null,
      lastError: null,
      updatedAt: updated,
    },
    _machine: machine.environmentId,
    _state: chat.state ?? null,
  };
}

function buildProject(project: ProjectSpec) {
  const at = ago(60 * 24 * 14);
  return {
    id: project.id,
    title: project.title,
    workspaceRoot: project.root,
    repositoryIdentity: repositoryIdentityOf(project),
    defaultModelSelection: MODEL,
    scripts: [],
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
}

export function readModelFor(machine: ProtoMachine): OrchestrationReadModel {
  const isCloud = machine.environmentId === ENV_CLOUD;
  const projects = (isCloud ? CLOUD_PROJECTS : MAC_PROJECTS).map(buildProject);
  const threads = (isCloud ? CLOUD_CHATS : MAC_CHATS).map((chat) => buildThread(machine, chat));
  return {
    snapshotSequence: 5,
    projects,
    threads,
    updatedAt: new Date(NOW).toISOString(),
  } as unknown as OrchestrationReadModel;
}

type ReadThread = ReturnType<typeof buildThread>;

export function toShellSnapshot(model: OrchestrationReadModel) {
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
    threads: (model.threads as unknown as ReadThread[])
      .filter((thread) => thread.deletedAt === null)
      .map((thread) => ({
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
      spawnedByThreadId: null,
      controller: "human",
      controlChangedAt: null,
      assistantRole: null,
      session: thread.session,
      latestUserMessageAt: thread.createdAt,
      hasPendingApprovals: false,
      hasPendingUserInput: thread._state === "needs-you",
      hasActionableProposedPlan: false,
    })),
    updatedAt: model.updatedAt,
  };
}

export function threadForSubscription(model: OrchestrationReadModel, threadId: string) {
  const thread = (model.threads as unknown as ReadThread[]).find((t) => t.id === threadId);
  if (!thread) return null;
  const { _machine: _m, _state: _s, ...wire } = thread;
  return wire;
}

/** The Inbox each computer keeps: questions waiting for the person, finished work. */
export function inboxFor(machine: ProtoMachine) {
  const chats = machine.environmentId === ENV_CLOUD ? CLOUD_CHATS : MAC_CHATS;
  const items = chats
    .filter((chat) => chat.state === "needs-you" || chat.state === "unread" || chat.minutesAgo < 120)
    .filter((chat) => chat.state !== "running")
    .map((chat) => {
      const at = ago(chat.minutesAgo);
      const needs = chat.state === "needs-you";
      return {
        id: `inbox-${chat.id}`,
        kind: needs ? ("agent.input" as const) : ("agent.done" as const),
        source: { kind: "agent" as const, id: chat.id, name: chat.title, icon: null },
        title: needs ? chat.title : `Finished: ${chat.title}`,
        body: chat.answer ?? null,
        open: { kind: "thread" as const, threadId: chat.id },
        createdAt: at,
        updatedAt: at,
        count: 1,
        readAt: chat.state === "unread" || needs ? null : at,
        snoozedUntil: null,
      };
    });
  return { items, unread: items.filter((item) => item.readAt === null).length };
}
