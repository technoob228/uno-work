/**
 * Computers lifecycle demo (Misha 02.11, SPEC
 * reports/day_2026-11-02/computers-lifecycle/SPEC.md): what the backend would
 * answer for the one "Add computer" window and the computer menu.
 *
 *   - "Connect my computer" RPCs: the pairing is claimed ~2.5 s after the
 *     person presses Download or copies the command; the MacBook (a
 *     `MyComputer`) is then listed, online unless the panel put it to sleep;
 *   - the chat import: Claude Code 4 chats, Codex 2, OpenCode not installed;
 *     imported chats land on the MacBook (full computer) or on uno-work with
 *     their source (tool) — then "Continue in the cloud";
 *   - projects in ~/projects with key names from their .env;
 *   - a full computer: the MacBook becomes a computer of its own (the real
 *     `addSavedEnvironment`); its chat's turn waits while it sleeps and goes
 *     on when it wakes;
 *   - delete / turn off a cloud computer, and what is on it.
 *
 * `?lc=fresh` (default): the MacBook isn't connected yet; `?lc=connected`:
 * it already is a full computer; `?lc=off`: the demo as before.
 */
import type {
  ImportedChatTool,
  MyComputerImportStatus,
  ThreadComputerSource,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";

import { LC_START } from "../../computersLifecycle/flag";
import type { FoundProject, LifecycleDemoHooks } from "../../computersLifecycle/backend";
import { lifecycle } from "../../computersLifecycle/store";
import {
  addSavedEnvironment,
  reconnectSavedEnvironment,
  removeSavedEnvironment,
} from "../../environments/runtime";
import { demoHooks } from "../demoFlag";
import { MACHINES, type DemoMachine, type MachineKey } from "../heavyFixtures";
import { isSleeping, setSleeping } from "./links";

export const LC_ON = LC_START !== "off";
export const MAC_COMPUTER_ID = "mc-macbook";

/** What demoBoot lends this module (its models and chats). */
export interface LifecycleOps {
  addThread(
    key: MachineKey,
    input: {
      id: string;
      projectId: string;
      title: string;
      minutesAgo: number;
      messages: ReadonlyArray<readonly ["user" | "assistant", string]>;
      source?: ThreadComputerSource;
    },
  ): void;
  addProject(key: MachineKey, input: { id: string; title: string; workspaceRoot: string }): void;
  hasProject(key: MachineKey, projectId: string): boolean;
  /** The chat's messages and project title (null: no such chat). */
  readThread(
    environmentId: string,
    threadId: string,
  ): {
    title: string;
    projectTitle: string;
    messages: ReadonlyArray<readonly ["user" | "assistant", string]>;
  } | null;
  finishTurn(key: MachineKey, threadId: string, text: string): void;
}

let ops: LifecycleOps | null = null;

// ── State ───────────────────────────────────────────────────────────────

let macConnected = LC_START === "connected";
let macFull = LC_START === "connected";
let installStartedAt: number | null = null;
const deletedBoxes = new Set<number>();
const resumeOnWake = new Map<string, string>();
let waitingThread: { environmentId: string; threadId: string } | null = null;

/** The MacBook isn't one of the page's computers at the start (fresh). */
export function lcHidesMac(): boolean {
  return LC_ON && !macFull;
}

/** A fresh MacBook has no chats of Uno's yet: they come with the import. */
export function lcStripsMacChats(): boolean {
  return LC_START === "fresh";
}

export function lcDeletedBox(id: number): boolean {
  return deletedBoxes.has(id);
}

function mac() {
  return {
    id: MAC_COMPUTER_ID,
    name: "MacBook",
    os: "darwin",
    arch: "arm64",
    online: !isSleeping("mac"),
    connectedAt: new Date(Date.now() - 60_000).toISOString(),
    lastSeenAt: new Date().toISOString(),
    helperVersion: "0.4.0",
  };
}

// ── The chat import ─────────────────────────────────────────────────────

interface ImportedSpec {
  readonly tool: ImportedChatTool;
  readonly title: string;
  readonly project: string;
  readonly minutesAgo: number;
  readonly messages: ReadonlyArray<readonly ["user" | "assistant", string]>;
}

const IMPORTED: ReadonlyArray<ImportedSpec> = [
  {
    tool: "claude",
    title: "Fix the landing build",
    project: "landing",
    minutesAgo: 50,
    messages: [
      ["user", "The landing build fails on the hero image."],
      [
        "assistant",
        "A missing image in /public/hero.webp. Added it back, `npm run build` is green.",
      ],
    ],
  },
  {
    tool: "claude",
    title: "Stripe webhooks for refunds",
    project: "landing",
    minutesAgo: 60 * 5,
    messages: [
      ["user", "Handle refund webhooks from Stripe and mark the order refunded."],
      [
        "assistant",
        "Added /api/stripe/webhook with the refund event. Needs STRIPE_WEBHOOK_SECRET.",
      ],
    ],
  },
  {
    tool: "claude",
    title: "Refactor auth middleware",
    project: "fishcode",
    minutesAgo: 60 * 26,
    messages: [
      ["user", "Split the auth middleware: API keys and sessions separately."],
      ["assistant", "Done: auth/apikey.go and auth/session.go, tests pass."],
    ],
  },
  {
    tool: "claude",
    title: "Rename screenshots by date",
    project: "Home folder",
    minutesAgo: 60 * 30,
    messages: [
      ["user", "Rename the screenshots on my Desktop by date."],
      ["assistant", "Renamed 214 files, like 2026-10-28 14.03.png."],
    ],
  },
  {
    tool: "codex",
    title: "Speed up the orders query",
    project: "fishcode",
    minutesAgo: 60 * 50,
    messages: [
      ["user", "The orders list is slow for big accounts."],
      ["assistant", "Added an index on (user_id, created_at): 1.8 s → 40 ms."],
    ],
  },
  {
    tool: "codex",
    title: "Write the README",
    project: "uno-work-app",
    minutesAgo: 60 * 72,
    messages: [
      ["user", "Write a short README for the app."],
      ["assistant", "README.md: what it is, how to run it, how to release."],
    ],
  },
];

const countOf = (tool: ImportedChatTool) => IMPORTED.filter((spec) => spec.tool === tool).length;
const projectsOf = (tool: ImportedChatTool) =>
  new Set(IMPORTED.filter((spec) => spec.tool === tool).map((spec) => spec.project)).size;

type ImportPhase =
  | { kind: "idle" }
  | { kind: "scanning"; until: number }
  | { kind: "ready" }
  | { kind: "importing"; startedAt: number; tools: ReadonlyArray<ImportedChatTool> }
  | { kind: "done"; imported: number };

let importPhase: ImportPhase = { kind: "idle" };
let declined = false;
let importedCount = 0;
const importedHistory = new Map<string, ImportedSpec>();
const IMPORT_MS = 1_800;

function advanceImport() {
  if (importPhase.kind === "scanning" && Date.now() >= importPhase.until) {
    importPhase = { kind: "ready" };
  }
  if (importPhase.kind === "importing" && Date.now() - importPhase.startedAt >= IMPORT_MS) {
    const chosen = new Set(importPhase.tools);
    const specs = IMPORTED.filter((spec) => chosen.has(spec.tool));
    landImported(specs);
    importPhase = { kind: "done", imported: specs.length };
  }
}

function importStatus(): MyComputerImportStatus {
  advanceImport();
  const tools = (["claude", "codex", "opencode"] as const).map((id) => ({
    id,
    name: id === "claude" ? "Claude Code" : id === "codex" ? "Codex" : "OpenCode",
    chats: id === "opencode" ? 0 : countOf(id),
    newChats:
      id === "opencode" || importPhase.kind === "done" || importedCount > 0 ? 0 : countOf(id),
    projects: id === "opencode" ? 0 : projectsOf(id),
    available: id !== "opencode",
    unavailableReason: id === "opencode" ? "Not installed" : null,
  }));
  const phase = importPhase;
  return {
    computerId: MAC_COMPUTER_ID,
    state: phase.kind,
    declined,
    tools,
    alsoFound: [],
    skipped: { unreadable: 0, unknownFormat: 0 },
    scanned: { done: phase.kind === "scanning" ? 3 : 6, total: 6 },
    progress:
      phase.kind === "importing"
        ? {
            done: Math.min(
              phase.tools.length,
              Math.floor(((Date.now() - phase.startedAt) / IMPORT_MS) * phase.tools.length),
            ),
            total: IMPORTED.filter((spec) => phase.tools.includes(spec.tool)).length,
          }
        : { done: 0, total: 0 },
    result:
      phase.kind === "done"
        ? { imported: phase.imported, recent: phase.imported, snoozed: 0, failed: 0 }
        : null,
    importedChats: importedCount,
    importedProjects: importedCount > 0 ? 3 : 0,
    message: null,
  };
}

const MAC_PROJECT_ID: Record<string, string> = {
  landing: "p-mac-landing",
  fishcode: "p-mac-fishcode",
  "uno-work-app": "p-mac-uno-work",
  "uno-project": "p-mac-uno-project",
  "Home folder": "p-mac-home",
};

/** The project of that name on uno-work, made if it isn't there (an imported chat's folder). */
function workProject(name: string): string {
  if (name === "Home folder") return "p-work-home";
  const id = `p-work-${name}`;
  if (!ops!.hasProject("work", id)) {
    ops!.addProject("work", { id, title: name, workspaceRoot: `/home/uno/projects/${name}` });
  }
  return id;
}

function landImported(specs: ReadonlyArray<ImportedSpec>) {
  if (!ops) return;
  importedCount += specs.length;
  specs.forEach((spec, index) => {
    const id = `imp-${spec.tool}-${index}-${spec.title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
    importedHistory.set(id, spec);
    if (macFull) {
      // A full computer: the chat goes on on the MacBook, in its project's folder.
      ops!.addThread("mac", {
        id,
        projectId: MAC_PROJECT_ID[spec.project] ?? "p-mac-home",
        title: spec.title,
        minutesAgo: spec.minutesAgo,
        messages: spec.messages,
      });
    } else {
      // A tool: the chat is a copy on uno-work, read-only until "Continue in the cloud".
      ops!.addThread("work", {
        id,
        projectId: workProject(spec.project),
        title: spec.title,
        minutesAgo: spec.minutesAgo,
        messages: [],
        source: {
          kind: "computer",
          computerId: MAC_COMPUTER_ID,
          computerName: "MacBook",
          tool: spec.tool,
          sessionId: id,
          path: `/Users/misha/.claude/projects/${spec.project}/${id}.jsonl`,
          cwd: `/Users/misha/projects/${spec.project}`,
          lastActiveAt: new Date(Date.now() - spec.minutesAgo * 60_000).toISOString(),
        },
      });
    }
  });
}

// ── Projects and keys ───────────────────────────────────────────────────

const FOUND: ReadonlyArray<FoundProject> = [
  {
    name: "landing",
    path: "~/projects/landing",
    keys: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RESEND_API_KEY"],
    fromChats: true,
  },
  {
    name: "fishcode",
    path: "~/projects/fishcode",
    keys: ["DATABASE_URL", "TELEGRAM_BOT_TOKEN"],
    fromChats: true,
  },
  { name: "uno-work-app", path: "~/projects/uno-work", keys: [], fromChats: true },
  { name: "uno-project", path: "~/projects/uno-project", keys: [], fromChats: false },
];

// ── RPC ─────────────────────────────────────────────────────────────────

/** The answer to a "Connect my computer" RPC (undefined: not one, or the demo is off). */
export function answerLifecycleRpc(_machine: DemoMachine, tag: string, body: unknown): unknown {
  if (!LC_ON) return undefined;
  switch (tag) {
    case WS_METHODS.myComputerStatus:
      return { enabled: true, computers: macConnected ? [mac()] : [] };
    case WS_METHODS.myComputerPairStatus: {
      if (installStartedAt !== null && Date.now() - installStartedAt > 2_500) {
        macConnected = true;
        return { state: "claimed", step: null, message: null, computerId: MAC_COMPUTER_ID };
      }
      return {
        state: installStartedAt === null ? "waiting" : "claimed",
        step: null,
        message: null,
        computerId: null,
      };
    }
    case WS_METHODS.myComputerDisconnect:
      macConnected = false;
      installStartedAt = null;
      return null;
    case WS_METHODS.myComputerActivity:
      return [];
    case WS_METHODS.myComputerImportStatus:
      return importStatus();
    case WS_METHODS.myComputerImportScan:
      if (importPhase.kind === "idle" || importPhase.kind === "ready") {
        importPhase = { kind: "scanning", until: Date.now() + 1_200 };
      }
      return importStatus();
    case WS_METHODS.myComputerImportStart: {
      const tools = ((body as { tools?: ImportedChatTool[] }).tools ?? []).filter(
        (tool) => tool !== "opencode",
      );
      importPhase = { kind: "importing", startedAt: Date.now(), tools };
      setTimeout(advanceImport, IMPORT_MS + 50);
      return importStatus();
    }
    case WS_METHODS.myComputerImportDecline:
      declined = true;
      return importStatus();
    case WS_METHODS.myComputerChatHistory: {
      const threadId = String((body as { threadId?: string }).threadId ?? "");
      const spec = importedHistory.get(threadId);
      if (!spec) return { kind: "gone" };
      return {
        kind: "ready",
        truncated: false,
        stale: false,
        messages: spec.messages.map(([role, text], index) => ({
          id: `${threadId}-h${index}`,
          role,
          text,
          createdAt: new Date(
            Date.now() - (spec.minutesAgo + (spec.messages.length - index) * 2) * 60_000,
          ).toISOString(),
        })),
      };
    }
    default:
      return undefined;
  }
}

// ── A full computer's turn waits for it ─────────────────────────────────

/** A message in a MacBook chat: the agent works ~5 s; asleep by then, it goes on at the wake. */
export function lcOnTurn(key: MachineKey, threadId: string, text: string): boolean {
  if (!LC_ON || key !== "mac" || !ops) return false;
  const reply = /test/i.test(text)
    ? "Ran the tests on MacBook: 42 passed in 8 s."
    : "Done on MacBook — the files are in the project folder.";
  setTimeout(() => {
    if (isSleeping("mac")) resumeOnWake.set(threadId, reply);
    else ops?.finishTurn("mac", threadId, reply);
  }, 5_000);
  return true;
}

export function lcSleepMac() {
  setSleeping("mac", true);
}

export function lcWakeMac() {
  setSleeping("mac", false);
  if (macFull) void reconnectSavedEnvironment(MACHINES.mac.environmentId).catch(() => undefined);
  setTimeout(() => {
    for (const [threadId, reply] of resumeOnWake) {
      ops?.finishTurn("mac", threadId, `MacBook is back. ${reply}`);
    }
    resumeOnWake.clear();
  }, 2_500);
}

// ── Hooks for the real components (computersLifecycle/backend.ts) ───────

async function makeFull(): Promise<string> {
  macFull = true;
  const record = await addSavedEnvironment({
    label: "MacBook",
    host: `https://${MACHINES.mac.host}/`,
    pairingCode: "demo-macbook",
  });
  return record.environmentId;
}

async function makeTool(): Promise<void> {
  macFull = false;
  await removeSavedEnvironment(MACHINES.mac.environmentId).catch(() => undefined);
}

const CLOUD_CONTENTS: Record<string, { apps: string[]; sites: string[] }> = {
  work: { apps: ["orders-bot", "crm"], sites: ["misha-portfolio.uno4.me"] },
  product: { apps: ["landing-preview"], sites: ["uno-pitch.uno4.me"] },
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const hooks: LifecycleDemoHooks = {
  installStarted: () => {
    installStartedAt ??= Date.now();
  },
  projects: () => FOUND,
  bring: ({ projects }) => {
    for (const project of projects) workProject(project.name);
  },
  makeFull,
  makeTool,
  removeComputer: async () => {
    if (macFull) await makeTool();
    macConnected = false;
    installStartedAt = null;
    importPhase = { kind: "idle" };
    declined = false;
  },
  continueInCloud: async (environmentId, threadId) => {
    const from = ops?.readThread(environmentId, threadId);
    const spec = importedHistory.get(threadId);
    const title = from?.title ?? spec?.title ?? "Chat";
    const projectName = spec?.project ?? from?.projectTitle ?? "Home folder";
    const messages = spec?.messages ?? from?.messages ?? [];
    await wait(900);
    const id = `${threadId}-cloud`;
    ops?.addThread("work", {
      id,
      projectId: workProject(projectName),
      title,
      minutesAgo: 0,
      messages: [
        ...messages,
        [
          "assistant",
          `Continued from MacBook. Copied ${projectName} to uno-work and picked up where it stopped.`,
        ],
      ],
    });
    await wait(500);
    return { environmentId: MACHINES.work.environmentId, threadId: id };
  },
  cloudContents: (boxId) => {
    const key =
      boxId === MACHINES.work.boxId ? "work" : boxId === MACHINES.product.boxId ? "product" : null;
    return key ? CLOUD_CONTENTS[key]! : { apps: [], sites: [] };
  },
  deleteBox: async (boxId) => {
    await wait(600);
    deletedBoxes.add(boxId);
  },
  sleepBox: async () => {
    await wait(400);
  },
  waiting: (environmentId, threadId) => {
    waitingThread = { environmentId, threadId };
  },
};

/** For the panel and Playwright. */
export const lcDemo = {
  sleep: lcSleepMac,
  wake: lcWakeMac,
  asleep: () => isSleeping("mac"),
  waiting: () => waitingThread,
  connected: () => macConnected,
  full: () => macFull,
};

export function startLifecycle(next: LifecycleOps) {
  if (!LC_ON) return;
  ops = next;
  demoHooks.lc = hooks;
  (window as unknown as { __lcDemo: typeof lcDemo }).__lcDemo = lcDemo;
  if (macFull) {
    lifecycle.setPurpose(MAC_COMPUTER_ID, "full");
    lifecycle.linkEnvironment(MAC_COMPUTER_ID, MACHINES.mac.environmentId);
  }
}
