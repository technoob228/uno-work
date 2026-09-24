/**
 * Mock workspace for the navigation prototype: one Uno Work computer, the
 * folders in its home directory, a few projects (a project = a folder with
 * its chats), chats in every state, the Uno assistant, and notifications
 * from agents and apps (Taskboard, Notetaker, Office).
 *
 * Chat titles mix Russian and English the way the founder's real sidebar
 * does. Nothing here talks to a daemon.
 */

export interface Project {
  readonly id: string;
  readonly name: string;
  /** Path inside the home folder; "~" is the home folder itself. */
  readonly path: string;
  readonly glyph: string;
  readonly tint: string;
  readonly source?: "folder" | "github" | "template" | "empty";
}

export type ThreadStatus = "approval" | "input" | "working" | "done" | "idle" | "failed";

export interface Message {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool" | "spawn" | "external";
  readonly text: string;
  /** spawn: the chat it started. external: where it came from. */
  readonly ref?: string;
  readonly via?: "telegram" | "slack";
}

export interface Thread {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly status: ThreadStatus;
  readonly unseen: boolean;
  readonly updatedMin: number;
  readonly pinned: boolean;
  /** Not sent yet: the folder chip is still editable. */
  readonly draft?: boolean;
  /** This chat is an assistant (B2) — always on, can be reached from outside. */
  readonly assistant?: boolean;
  /** Started by another chat (the assistant). */
  readonly spawnedBy?: string;
  readonly connectors?: ReadonlyArray<"telegram" | "slack">;
  readonly messages: ReadonlyArray<Message>;
  readonly approval?: { readonly command: string; readonly why: string } | undefined;
  readonly question?: { readonly text: string; readonly options: ReadonlyArray<string> } | undefined;
}

export type InboxKind = "approval" | "input" | "done" | "failed" | "app";

export interface InboxItem {
  readonly id: string;
  readonly kind: InboxKind;
  readonly title: string;
  readonly detail: string;
  readonly minAgo: number;
  readonly read: boolean;
  readonly threadId?: string;
  readonly appId?: string;
  readonly count?: number;
}

export interface AppInfo {
  readonly id: string;
  readonly name: string;
  readonly glyph: string;
  readonly color: string;
}

export interface Folder {
  readonly name: string;
  readonly children?: ReadonlyArray<Folder>;
  /** Looks like code (has package.json / .git) — shown with a hint. */
  readonly code?: boolean;
}

export const APPS: ReadonlyArray<AppInfo> = [
  { id: "taskboard", name: "Taskboard", glyph: "Tb", color: "from-indigo-500 to-violet-600" },
  { id: "notetaker", name: "Notetaker", glyph: "Nt", color: "from-amber-400 to-orange-500" },
  { id: "office", name: "Office", glyph: "Of", color: "from-sky-500 to-blue-600" },
  { id: "n8n", name: "n8n", glyph: "n8", color: "from-rose-500 to-pink-600" },
];

export const HOME_PROJECT_ID = "home";

export const PROJECTS: ReadonlyArray<Project> = [
  { id: HOME_PROJECT_ID, name: "Home folder", path: "~", glyph: "⌂", tint: "bg-zinc-500/12 text-zinc-600" },
  { id: "tracker", name: "task-tracker", path: "~/projects/task-tracker", glyph: "T", tint: "bg-indigo-500/12 text-indigo-600" },
  { id: "uno", name: "uno-project", path: "~/uno-project", glyph: "U", tint: "bg-primary/12 text-primary" },
  { id: "landing", name: "landing", path: "~/sites/landing", glyph: "L", tint: "bg-emerald-500/12 text-emerald-600" },
  { id: "bot", name: "support-bot", path: "~/projects/support-bot", glyph: "S", tint: "bg-sky-500/12 text-sky-600" },
];

export const HOME_TREE: Folder = {
  name: "~",
  children: [
    { name: "Documents", children: [{ name: "contracts" }, { name: "invoices-2026" }, { name: "pitch" }] },
    { name: "Downloads" },
    { name: "notes", children: [{ name: "calls" }, { name: "ideas" }] },
    {
      name: "projects",
      children: [
        { name: "task-tracker", code: true },
        { name: "support-bot", code: true },
        { name: "old-experiments", children: [{ name: "gpt-scraper", code: true }, { name: "tg-mini-app", code: true }] },
        { name: "price-monitor", code: true },
      ],
    },
    { name: "sites", children: [{ name: "landing", code: true }, { name: "portfolio", code: true }] },
    { name: "uno-project", code: true, children: [{ name: "fishcode", code: true }, { name: "knowledge" }] },
  ],
};

export const RECENT_FOLDERS: ReadonlyArray<string> = [
  "~/projects/price-monitor",
  "~/Documents/pitch",
  "~/notes/calls",
];

export const TEMPLATES: ReadonlyArray<{ id: string; name: string; hint: string; glyph: string }> = [
  { id: "site", name: "Website", hint: "A landing or portfolio, published on Uno Hosting", glyph: "🌐" },
  { id: "tgbot", name: "Telegram bot", hint: "Python bot that runs on this computer", glyph: "✈️" },
  { id: "app", name: "Web app", hint: "React + a small backend, opens as an app", glyph: "▦" },
  { id: "data", name: "Data analysis", hint: "Drop CSV/Excel files in, ask questions", glyph: "▤" },
];

export const GITHUB_REPOS: ReadonlyArray<string> = [
  "mikhail/uno4-dev-site",
  "mikhail/price-monitor",
  "godovasik/fishcode",
  "technoob228/uno-api",
];

const m = (id: string, role: Message["role"], text: string, extra: Partial<Message> = {}): Message => ({
  id,
  role,
  text,
  ...extra,
});

export const ASSISTANT_ID = "uno";

export const THREADS: ReadonlyArray<Thread> = [
  {
    id: ASSISTANT_ID,
    title: "Uno",
    projectId: HOME_PROJECT_ID,
    status: "idle",
    unseen: true,
    updatedMin: 3,
    pinned: true,
    assistant: true,
    connectors: ["telegram"],
    messages: [
      m("u1", "external", "Что там с таск-трекером? И напомни, что я просил про список компьютеров", { via: "telegram" }),
      m("u2", "assistant", "Task tracker: the agent is on step 4 of 7 (boards + drag & drop). The computers list is ready — 12 machines, 2 asleep, 1 not responding."),
      m("u3", "spawn", "Список компьютеров Uno", { ref: "computers" }),
      m("u4", "external", "Ок. Лендинг тоже почини, там деплой упал", { via: "telegram" }),
      m("u5", "spawn", "Почини деплой лендинга", { ref: "landing-fix" }),
      m("u6", "assistant", "Started it in landing. It wants to run a deploy command — I left the approval for you in the chat (I don't approve deploys on my own)."),
      m("u7", "user", "Сделай короткую сводку за день"),
      m("u8", "assistant", "Today: 3 chats finished, 1 waits for approval (landing deploy), 1 asks a question (call notes). Taskboard: Anna moved “Billing page” to Done. Notetaker: notes from the call with Hector are ready."),
    ],
  },
  {
    id: "tracker",
    title: "Task tracker app like Jira",
    projectId: "tracker",
    status: "working",
    unseen: false,
    updatedMin: 1,
    pinned: false,
    messages: [
      m("t1", "user", "Сделай таск-трекер как Jira: доски, колонки, drag & drop, исполнители. Чтобы открывался как приложение."),
      m("t2", "assistant", "Plan: 1) data model 2) API 3) board UI 4) drag & drop 5) assignees 6) login with Uno 7) register as an app. Starting."),
      m("t3", "tool", "Edited src/board/Board.tsx, src/api/tasks.ts (+412 −18)"),
      m("t4", "assistant", "Boards and columns work. Now: drag & drop between columns…"),
    ],
  },
  {
    id: "landing-fix",
    title: "Почини деплой лендинга",
    projectId: "landing",
    status: "approval",
    unseen: true,
    updatedMin: 4,
    pinned: false,
    spawnedBy: ASSISTANT_ID,
    messages: [
      m("l1", "user", "Деплой лендинга упал, почини"),
      m("l2", "assistant", "The build failed on a missing image (hero@2x.png). Fixed the path. Ready to publish again."),
    ],
    approval: { command: "npm run build && uno sites publish landing", why: "Publishes the fixed site to landing.uno4.site" },
  },
  {
    id: "notes-q",
    title: "Summarize the call with Hector",
    projectId: HOME_PROJECT_ID,
    status: "input",
    unseen: true,
    updatedMin: 12,
    pinned: false,
    messages: [
      m("n1", "user", "Take the Notetaker notes from today's call with Hector and make a one-page summary."),
      m("n2", "assistant", "I have the 42-minute transcript."),
    ],
    question: { text: "Who is the summary for?", options: ["Just me", "Hector's team", "Investors update"] },
  },
  {
    id: "computers",
    title: "Список компьютеров Uno",
    projectId: "uno",
    status: "done",
    unseen: true,
    updatedMin: 26,
    pinned: false,
    spawnedBy: ASSISTANT_ID,
    messages: [
      m("c1", "user", "Собери список всех компьютеров Uno с состоянием и тарифом"),
      m("c2", "tool", "Ran uno boxes list --json"),
      m("c3", "assistant", "Done: computers.xlsx in ~/uno-project — 12 machines, 2 asleep, 1 not responding (box 1522)."),
    ],
  },
  {
    id: "hetzner",
    title: "Сравни тарифы Hetzner и Contabo",
    projectId: HOME_PROJECT_ID,
    status: "done",
    unseen: false,
    updatedMin: 180,
    pinned: false,
    messages: [
      m("h1", "user", "Сравни тарифы Hetzner и Contabo для 8 ГБ RAM"),
      m("h2", "assistant", "Table saved to ~/Documents/hosting-compare.xlsx. Short: Contabo is cheaper, Hetzner is faster on disk."),
    ],
  },
  {
    id: "bot",
    title: "Telegram bot for bookings",
    projectId: "bot",
    status: "failed",
    unseen: true,
    updatedMin: 95,
    pinned: false,
    messages: [
      m("b1", "user", "Сделай бота для записи на встречи в Telegram"),
      m("b2", "assistant", "Tests fail: the bot token in .env is empty. Add it in Settings → Secrets and I'll continue."),
    ],
  },
  {
    id: "invoice",
    title: "Invoice parser from PDFs",
    projectId: HOME_PROJECT_ID,
    status: "idle",
    unseen: false,
    updatedMin: 60 * 26,
    pinned: false,
    messages: [m("i1", "user", "Parse all PDFs in ~/Documents/invoices-2026 into one sheet"), m("i2", "assistant", "Done — invoices.xlsx, 34 rows.")],
  },
  {
    id: "uno-site",
    title: "uno4.dev hero A/B",
    projectId: "uno",
    status: "idle",
    unseen: false,
    updatedMin: 60 * 50,
    pinned: false,
    messages: [m("s1", "user", "Сделай два варианта hero для uno4.dev"), m("s2", "assistant", "Two variants are in ~/uno-project/site/hero-a|b.")],
  },
];

export const INBOX: ReadonlyArray<InboxItem> = [
  { id: "i-landing", kind: "approval", title: "Почини деплой лендинга", detail: "Wants to publish the fixed site", minAgo: 4, read: false, threadId: "landing-fix" },
  { id: "i-notes", kind: "input", title: "Summarize the call with Hector", detail: "Asks: Who is the summary for?", minAgo: 12, read: false, threadId: "notes-q" },
  { id: "i-tb1", kind: "app", title: "Anna moved “Billing page” to Done", detail: "Taskboard · Sprint 14", minAgo: 18, read: false, appId: "taskboard" },
  { id: "i-computers", kind: "done", title: "Список компьютеров Uno", detail: "Finished: computers.xlsx — 12 machines", minAgo: 26, read: false, threadId: "computers" },
  { id: "i-nt", kind: "app", title: "Notes ready: Call with Hector — 42 min", detail: "Notetaker · 5 action items", minAgo: 40, read: false, appId: "notetaker" },
  { id: "i-office", kind: "app", title: "Boris commented on pricing-v2.docx", detail: "Office · “Can we drop the $5 tier?”", minAgo: 70, read: true, appId: "office", count: 3 },
  { id: "i-bot", kind: "failed", title: "Telegram bot for bookings", detail: "Stopped: bot token in .env is empty", minAgo: 95, read: false, threadId: "bot" },
  { id: "i-tb2", kind: "app", title: "3 tasks due today", detail: "Taskboard · assigned to you", minAgo: 60 * 5, read: true, appId: "taskboard" },
  { id: "i-hetzner", kind: "done", title: "Сравни тарифы Hetzner и Contabo", detail: "Finished: hosting-compare.xlsx", minAgo: 180, read: true, threadId: "hetzner" },
  { id: "i-n8n", kind: "app", title: "Workflow “Daily leads” ran 24 times", detail: "n8n · 2 errors", minAgo: 60 * 20, read: true, appId: "n8n" },
];
