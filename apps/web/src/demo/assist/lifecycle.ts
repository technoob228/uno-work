/**
 * Computers lifecycle demo (Misha 02.11, SPEC
 * reports/day_2026-11-02/computers-lifecycle/SPEC.md, CONTRACT.md): what the
 * cloud computer (uno-work) answers for the person's own MacBook — the same
 * RPCs the real daemon serves, so the screens run their real code:
 *
 *   - "Connect my computer": the pairing is claimed ~2.5 s after the person
 *     presses Download or copies the command; the MacBook is then listed,
 *     online unless the panel put it to sleep;
 *   - `computers.*`: what it is for, projects in ~/projects with key names,
 *     bringing them over, a MacBook folder as a uno-work project
 *     (`project.computer`), continuing a chat in the cloud;
 *   - the chat import: Claude Code 4 chats, Codex 2, OpenCode not installed;
 *     a full computer's chats land in MacBook folder projects, a tool's on
 *     uno-work with their source (then "Continue in the cloud");
 *   - a chat on the MacBook waits while it sleeps (`thread.computerWait`) and
 *     goes on when it wakes;
 *   - delete / turn off a cloud computer.
 *
 * The MacBook is never a computer of its own here (brain in the cloud): its
 * chats live on uno-work.
 *
 * `?lc=fresh` (default): the MacBook isn't connected yet; `?lc=connected`:
 * it already is a full computer; `?lc=off`: the demo as before.
 */
import type {
  ComputerPurpose,
  ComputerWorkStatus,
  DesktopConnectHelperState,
  FoundProject,
  ImportedChatTool,
  MyComputerImportStatus,
  ProjectComputer,
  ThreadComputerSource,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";

import { LC_START } from "../../computersLifecycle/flag";
import type { LifecycleDemoHooks } from "../../computersLifecycle/backend";
import { demoHooks } from "../demoFlag";
import { MACHINES, type DemoMachine, type MachineKey } from "../heavyFixtures";
import { isSleeping, setSleeping } from "./links";

export const LC_ON = LC_START !== "off";
export const MAC_COMPUTER_ID = "41";
const MAC_NAME = "MacBook";
const MAC_HOME = "/Users/misha";

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
  addProject(
    key: MachineKey,
    input: { id: string; title: string; workspaceRoot: string; computer?: ProjectComputer },
  ): void;
  hasProject(key: MachineKey, projectId: string): boolean;
  /** The chat's messages, project and that project's computer (null: no such chat). */
  readThread(
    environmentId: string,
    threadId: string,
  ): {
    title: string;
    projectTitle: string;
    computer: ProjectComputer | null;
    messages: ReadonlyArray<readonly ["user" | "assistant", string]>;
  } | null;
  /** Sets fields on a chat and publishes it. */
  patchThread(key: MachineKey, threadId: string, patch: Record<string, unknown>): void;
  finishTurn(key: MachineKey, threadId: string, text: string): void;
}

let ops: LifecycleOps | null = null;

// ── State ───────────────────────────────────────────────────────────────

let macConnected = LC_START === "connected";
const purposes = new Map<string, ComputerPurpose>(
  LC_START === "connected" ? [[MAC_COMPUTER_ID, "full"]] : [],
);
let installStartedAt: number | null = null;
const deletedBoxes = new Set<number>();
/** MacBook chats whose turn waits for it: the reply they give when it wakes. */
const resumeOnWake = new Map<string, string>();

/** The MacBook is never a computer of its own in the page: its chats live on uno-work. */
export function lcHidesMac(): boolean {
  return LC_ON;
}

/** The MacBook has no chats of Uno's: they come with the import. */
export function lcStripsMacChats(): boolean {
  return LC_ON;
}

export function lcDeletedBox(id: number): boolean {
  return deletedBoxes.has(id);
}

const isFull = () => purposes.get(MAC_COMPUTER_ID) === "full";

function mac() {
  return {
    id: MAC_COMPUTER_ID,
    name: MAC_NAME,
    os: "darwin",
    arch: "arm64",
    online: !isSleeping("mac"),
    connectedAt: new Date(Date.now() - 60_000).toISOString(),
    lastSeenAt: new Date().toISOString(),
    helperVersion: "0.4.0",
    mode: purposes.get(MAC_COMPUTER_ID) ?? "tool",
    trustsThisComputer: true,
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

/** The project of that name on uno-work, made if it isn't there (a copy in the cloud). */
function workProject(name: string): string {
  if (name === "Home folder") return "p-work-home";
  const id = `p-work-${name}`;
  if (!ops!.hasProject("work", id)) {
    ops!.addProject("work", { id, title: name, workspaceRoot: `/home/uno/projects/${name}` });
  }
  return id;
}

/** The uno-work project that stands for a MacBook folder (computers.openFolder). */
function macFolderProject(path: string): {
  projectId: string;
  workspaceRoot: string;
  title: string;
} {
  const home = path === "~" || path === MAC_HOME;
  const name = home ? "Home folder" : (path.split("/").pop() ?? path);
  const slug = home ? "home" : name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const projectId = `p-mac-${slug}`;
  const workspaceRoot = `/home/uno/computers/${MAC_COMPUTER_ID}/${slug}`;
  if (!ops!.hasProject("work", projectId)) {
    ops!.addProject("work", {
      id: projectId,
      title: name,
      workspaceRoot,
      computer: {
        computerId: MAC_COMPUTER_ID,
        computerName: MAC_NAME,
        path: home ? MAC_HOME : path,
      },
    });
  }
  return { projectId, workspaceRoot, title: name };
}

function landImported(specs: ReadonlyArray<ImportedSpec>) {
  if (!ops) return;
  importedCount += specs.length;
  specs.forEach((spec, index) => {
    const id = `imp-${spec.tool}-${index}-${spec.title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
    importedHistory.set(id, spec);
    if (isFull()) {
      // A full computer: the chat goes on on the MacBook, in its project's folder.
      const folder = macFolderProject(
        spec.project === "Home folder" ? "~" : `${MAC_HOME}/projects/${spec.project}`,
      );
      ops!.addThread("work", {
        id,
        projectId: folder.projectId,
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
          computerName: MAC_NAME,
          tool: spec.tool,
          sessionId: id,
          path: `${MAC_HOME}/.claude/projects/${spec.project}/${id}.jsonl`,
          cwd: `${MAC_HOME}/projects/${spec.project}`,
          lastActiveAt: new Date(Date.now() - spec.minutesAgo * 60_000).toISOString(),
        },
      });
    }
  });
}

// ── Projects and keys (computers.workScan / bringWork) ──────────────────

const FOUND: ReadonlyArray<FoundProject> = [
  {
    name: "landing",
    path: `${MAC_HOME}/projects/landing`,
    displayPath: "~/projects/landing",
    git: true,
    keys: ["RESEND_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    fromChats: true,
    synced: false,
  },
  {
    name: "fishcode",
    path: `${MAC_HOME}/projects/fishcode`,
    displayPath: "~/projects/fishcode",
    git: true,
    keys: ["DATABASE_URL", "TELEGRAM_BOT_TOKEN"],
    fromChats: true,
    synced: false,
  },
  {
    name: "uno-work-app",
    path: `${MAC_HOME}/projects/uno-work-app`,
    displayPath: "~/projects/uno-work-app",
    git: true,
    keys: [],
    fromChats: true,
    synced: false,
  },
  {
    name: "uno-project",
    path: `${MAC_HOME}/projects/uno-project`,
    displayPath: "~/projects/uno-project",
    git: true,
    keys: [],
    fromChats: false,
    synced: false,
  },
];

const SCAN_MS = 1_200;
const BRING_MS = 1_800;
let scanStartedAt: number | null = null;
let bringing: { startedAt: number; paths: ReadonlyArray<string>; keys: number[] } | null = null;
const synced = new Set<string>();

function workStatus(): ComputerWorkStatus {
  const scanning = scanStartedAt !== null && Date.now() - scanStartedAt < SCAN_MS;
  const scanned = scanStartedAt !== null && !scanning;
  const running = bringing !== null && Date.now() - bringing.startedAt < BRING_MS;
  if (bringing !== null && !running) {
    for (const path of bringing.paths) {
      if (!synced.has(path)) {
        synced.add(path);
        workProject(path.split("/").pop() ?? path);
      }
    }
  }
  return {
    computerId: MAC_COMPUTER_ID,
    scan: {
      state: scanning ? "scanning" : scanned ? "ready" : "idle",
      message: null,
      scannedAt: scanned ? new Date(scanStartedAt! + SCAN_MS).toISOString() : null,
      home: MAC_HOME,
      projects: scanned
        ? FOUND.map((project) => ({ ...project, synced: synced.has(project.path) }))
        : [],
    },
    bring:
      bringing === null
        ? { state: "idle", done: 0, total: 0, message: null, results: [] }
        : {
            state: running ? "running" : "done",
            done: running ? 0 : bringing.paths.length,
            total: bringing.paths.length,
            message: null,
            results: running
              ? []
              : bringing.paths.map((path, index) => ({
                  path,
                  name: path.split("/").pop() ?? path,
                  ok: true,
                  keysSaved: bringing!.keys[index] ?? 0,
                  message: null,
                })),
          },
  };
}

// ── A chat on the MacBook waits for it ──────────────────────────────────

function macWait() {
  return { computerId: MAC_COMPUTER_ID, computerName: MAC_NAME, since: new Date().toISOString() };
}

/** A message in a MacBook chat: the agent works ~5 s; asleep by then, it waits for the wake. */
export function lcOnTurn(key: MachineKey, threadId: string, text: string): boolean {
  if (!LC_ON || key !== "work" || !ops) return false;
  const chat = ops.readThread(MACHINES.work.environmentId, threadId);
  if (chat?.computer?.computerId !== MAC_COMPUTER_ID) return false;
  const reply = /test/i.test(text)
    ? "Ran the tests on MacBook: 42 passed in 8 s."
    : "Done on MacBook — the files are in the project folder.";
  setTimeout(() => {
    if (isSleeping("mac")) {
      resumeOnWake.set(threadId, reply);
      ops?.patchThread("work", threadId, { computerWait: macWait() });
    } else ops?.finishTurn("work", threadId, reply);
  }, 5_000);
  return true;
}

export function lcSleepMac() {
  setSleeping("mac", true);
  // A turn already running on it waits too.
  for (const threadId of resumeOnWake.keys()) {
    ops?.patchThread("work", threadId, { computerWait: macWait() });
  }
}

export function lcWakeMac() {
  setSleeping("mac", false);
  setTimeout(() => {
    for (const [threadId, reply] of resumeOnWake) {
      ops?.patchThread("work", threadId, { computerWait: null });
      ops?.finishTurn("work", threadId, `MacBook is back. ${reply}`);
    }
    resumeOnWake.clear();
  }, 2_500);
}

// ── RPC ─────────────────────────────────────────────────────────────────

function computersState() {
  return {
    lifecycle: true,
    purposes: [...purposes].map(([computerId, purpose]) => ({ computerId, purpose })),
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function continueInCloud(threadId: string) {
  const from = ops?.readThread(MACHINES.work.environmentId, threadId);
  const spec = importedHistory.get(threadId);
  const title = from?.title ?? spec?.title ?? "Chat";
  const projectName = spec?.project ?? from?.projectTitle ?? "Home folder";
  const messages = from?.messages.length ? from.messages : (spec?.messages ?? []);
  await wait(900);
  const id = `${threadId}-cloud`;
  resumeOnWake.delete(threadId);
  ops?.patchThread("work", threadId, { computerWait: null });
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
  return { threadId: id };
}

/** The answer to a "Connect my computer" or `computers.*` RPC (undefined: not one, or off). */
export function answerLifecycleRpc(machine: DemoMachine, tag: string, body: unknown): unknown {
  if (!LC_ON) return undefined;
  // Only the cloud computers hold the person's own computers.
  if (machine.machineKind !== "uno_box" && tag.startsWith("myComputer.")) {
    return tag === WS_METHODS.myComputerStatus ? { enabled: false, computers: [] } : undefined;
  }
  const input = body as Record<string, unknown>;
  switch (tag) {
    case WS_METHODS.myComputerStatus:
      return { enabled: true, lifecycle: true, computers: macConnected ? [mac()] : [] };
    case WS_METHODS.myComputerPair:
      return undefined;
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
      purposes.delete(MAC_COMPUTER_ID);
      importPhase = { kind: "idle" };
      declined = false;
      scanStartedAt = null;
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
      const tools = ((input.tools as ImportedChatTool[] | undefined) ?? []).filter(
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
      const threadId = String(input.threadId ?? "");
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
    case WS_METHODS.computersState:
      return computersState();
    case WS_METHODS.computersSetPurpose:
      purposes.set(String(input.computerId), input.purpose === "full" ? "full" : "tool");
      return computersState();
    case WS_METHODS.computersWorkStatus:
      return workStatus();
    case WS_METHODS.computersWorkScan:
      if (scanStartedAt === null || Date.now() - scanStartedAt > 60_000) scanStartedAt = Date.now();
      return workStatus();
    case WS_METHODS.computersBringWork: {
      const projects = (input.projects as Array<{ path: string; keys: string[] }>) ?? [];
      bringing = {
        startedAt: Date.now(),
        paths: projects.map((project) => project.path),
        keys: projects.map((project) => project.keys.length),
      };
      setTimeout(() => workStatus(), BRING_MS + 50);
      return workStatus();
    }
    case WS_METHODS.computersOpenFolder:
      return macFolderProject(String(input.path ?? "~"));
    case WS_METHODS.computersContinueInCloud:
      return continueInCloud(String(input.threadId ?? ""));
    default:
      return undefined;
  }
}

// ── Hooks for the real components (computersLifecycle/backend.ts) ───────

const hooks: LifecycleDemoHooks = {
  installStarted: () => {
    installStartedAt ??= Date.now();
  },
  // The desktop app: a code from uno-work, the helper installed and paired here (~2 s).
  installHere: async () => {
    await wait(2_000);
    installStartedAt = Date.now() - 3_000;
    macConnected = true;
    return MAC_COMPUTER_ID;
  },
  thisMacHelper: (): DesktopConnectHelperState =>
    macConnected
      ? { installed: true, computerId: MAC_COMPUTER_ID, name: MAC_NAME }
      : { installed: false, computerId: null, name: null },
  deleteBox: async (boxId) => {
    await wait(600);
    deletedBoxes.add(boxId);
  },
  sleepBox: async () => {
    await wait(400);
  },
};

/** For the panel and Playwright. */
export const lcDemo = {
  sleep: lcSleepMac,
  wake: lcWakeMac,
  asleep: () => isSleeping("mac"),
  connected: () => macConnected,
  full: isFull,
};

export function startLifecycle(next: LifecycleOps) {
  if (!LC_ON) return;
  ops = next;
  demoHooks.lc = hooks;
  (window as unknown as { __lcDemo: typeof lcDemo }).__lcDemo = lcDemo;
}
