/**
 * Demo mode (`?demo=heavy`, icp3 09.10): the real web client with three
 * computers answered inside the page by msw — HTTP through the service
 * worker, each daemon's WebSocket RPC by an in-page RPC server (the harness
 * the browser tests use). Nothing leaves the browser. Grown from the w0115
 * sidebar prototype (fix/w0115-sidebar-proto: protoBoot.ts).
 */
import { AGENT_SWITCH_ACTIVITY_KIND, agentSwitchLine } from "@t3tools/shared/handoff";
import {
  ASSISTANT_PROJECT_ID,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  isAssistantProjectId,
  type InboxItem,
  type RuntimeMode,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { assistantOwnRuntimeMode } from "@t3tools/shared/assistantPreset";
import { pendingPlanResume } from "@t3tools/shared/planLimitRules";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { HttpResponse, delay, http, ws } from "msw";
import { setupWorker } from "msw/browser";

import { BrowserWsRpcHarness, type NormalizedWsRpcRequestBody } from "./rpcHarness";
import { demoHooks } from "./demoFlag";
import { answerFileRpc, demoFolderEntries } from "./demoFiles";
import { demoTraceDiagnostics } from "./demoTraceDiagnostics";
import { addSecretRequest } from "../secretRequestStore";
import {
  demoBrowserLiveInitial,
  demoBrowserLiveUnary,
  demoMachineApps,
  demoSiteHandlers,
  demoWorkSites,
  loadAgentFrame,
} from "./demoBrowser";
import "./seedTabs";
import { DEMO_ASSIST, useDemoStore } from "./demoFlag";
import { isWoken, startLinks, trackClient } from "./assist/links";
import { demoMetrics } from "./assist/metrics";
import {
  type DemoInboxInput,
  type DemoQuestion,
  greet,
  onAnswer,
  onApproval,
  onTurn,
  restorePersona,
  setEngineSpeed,
  startEngine,
  stopPersona,
} from "./assist/engine";
import {
  accountHandlers,
  asksFirst,
  connectorState,
  daemonHandlers,
  machineAwake,
  onAssistantModeChanged,
  onAssistantRevoked,
  personaOf,
  presetOf,
  setMode,
  setPortraitsFail,
  setTelegram,
  startDaemons,
  telegramLinked,
} from "./assist/daemon";
import { installAssistFixtures } from "./assist/fixtures";
import { answerVaultRpc } from "./assist/vault";
import {
  addDemoAccount,
  applyDemoPlanSettings,
  DEMO_ACCOUNTS,
  PLAN_LIMIT_CHAT,
  planLimitsFor,
  planResumeActivity,
  planResumeEndedActivity,
  pollDemoAuth,
  removeDemoAccount,
  startDemoAuth,
} from "./assist/plans";
import { WORLD, worldStamp } from "./assist/world";
import "./assist/variant";
import {
  CHATS,
  DEMO_VERSION,
  INBOX,
  MACHINES,
  MACHINE_LIST,
  PRIMARY_MACHINE,
  SLEEPING_BOX,
  ago,
  buildInboxItem,
  buildThread,
  chatById,
  descriptorFor,
  machineByEnv,
  readModelFor,
  applyDemoMachineSettings,
  serverConfigFor,
  toShellSnapshot,
  toShellThread,
  type DemoMachine,
  type MachineKey,
  type WireThread,
} from "./heavyFixtures";
import {
  answerSetupChat,
  answerTeamRpc,
  assistantHandlers,
  isSetupChat,
  seedAssistantTeam,
} from "./assistantsFixtures";

const SEED_VERSION = DEMO_ASSIST ? `assist-1:${worldStamp(WORLD)}` : "w0138-1";

/** Computers the page has saved (besides its own): the 16.10 mock's two clouds, or the MacBook. */
function savedMachines(): DemoMachine[] {
  if (!DEMO_ASSIST) return [MACHINES.work, MACHINES.product];
  // The MacBook stays saved while it sleeps (it shows offline).
  return WORLD.account === "live" ? [MACHINES.mac] : [];
}

function seedLocalStorage() {
  if (localStorage.getItem("demo:seed") === SEED_VERSION) return;
  const keep = new Set(["demo:switches", "demo:assist-world"]);
  for (const key of Object.keys(localStorage)) {
    if (!keep.has(key)) localStorage.removeItem(key);
  }
  localStorage.setItem(
    "t3code:client-settings:v1",
    JSON.stringify({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompleted: true,
      // p5: every computer in one sidebar, one list (no grouping).
      sidebarEnvironmentScope: "all",
      sidebarGroupLevels: [],
      // Several computers: the spaces option as the world asks (Settings can change it live).
      ...(DEMO_ASSIST ? { computerSpaces: WORLD.spaces === "on" } : {}),
    }),
  );
  const records = savedMachines().map((machine) => ({
    environmentId: machine.environmentId,
    label: machine.label,
    httpBaseUrl: `https://${machine.host}/`,
    wsBaseUrl: `wss://${machine.host}/`,
    createdAt: new Date(Date.now() - 86_400_000 * 9).toISOString(),
    lastConnectedAt: new Date().toISOString(),
    bearerToken: "demo-bearer",
    ...(machine.boxId !== null ? { unoBoxId: machine.boxId } : {}),
  }));
  localStorage.setItem(
    "t3code:saved-environment-registry:v1",
    JSON.stringify({ version: 1, records }),
  );
  localStorage.setItem("demo:seed", SEED_VERSION);
}

function machineForHost(host: string): DemoMachine {
  return (
    MACHINE_LIST.find((machine) => machine.host !== "" && machine.host === host) ?? PRIMARY_MACHINE
  );
}

// ── State of each computer ──────────────────────────────────────────────

type Model = {
  snapshotSequence: number;
  projects: Array<Record<string, unknown>>;
  threads: Array<WireThread & { deletedAt: string | null; [key: string]: unknown }>;
  updatedAt: string;
};

/**
 * `&world=new` — a fresh account: only the home folder and Uno's folder, no
 * chats; `&world=one` — the same with one project of the person's own (the
 * sidebar's Add a project, 28.10). Anything else — the full fixtures.
 */
function demoWorld(): "new" | "one" | null {
  try {
    const world = new URLSearchParams(location.search).get("world");
    return world === "new" || world === "one" ? world : null;
  } catch {
    return null;
  }
}

function freshAccount(model: Model, keepOneProject: boolean): Model {
  let kept = 0;
  const projects = model.projects.filter((project) => {
    const id = String(project.id);
    if (isAssistantProjectId(id) || project.title === "Home folder") return true;
    kept += 1;
    return keepOneProject && kept === 1;
  });
  return { ...model, projects, threads: [] };
}

const models = new Map<string, Model>();
function modelFor(machine: DemoMachine): Model {
  let model = models.get(machine.environmentId);
  if (!model) {
    model = readModelFor(machine) as unknown as Model;
    const world = demoWorld();
    if (world !== null) model = freshAccount(model, world === "one");
    // The stopped chat is already waiting for the reset, as the daemon left it.
    if (DEMO_ACCOUNTS && machine.key === "work") {
      const stopped = model.threads.find((thread) => thread.id === PLAN_LIMIT_CHAT.id);
      if (stopped) (stopped.activities as unknown[]).push(planResumeActivity());
    }
    // An assistant's chats run in its own mode (Cautious → asks), as the daemon does.
    if (DEMO_ASSIST) {
      for (const thread of model.threads) {
        thread.runtimeMode = assistantRuntimeMode(machine.key, String(thread.projectId));
      }
    }
    models.set(machine.environmentId, model);
  }
  return model;
}

const inboxes = new Map<string, InboxItem[]>();
function inboxItemsFor(machine: DemoMachine): InboxItem[] {
  let items = inboxes.get(machine.environmentId);
  if (!items) {
    items = INBOX.filter((spec) => spec.machine === machine.key).map(buildInboxItem);
    inboxes.set(machine.environmentId, items);
  }
  return items;
}

function inboxSnapshotFor(machine: DemoMachine) {
  const nowMs = Date.now();
  const items = inboxItemsFor(machine).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    items,
    unread: items.filter(
      (item) =>
        item.readAt === null &&
        (item.snoozedUntil === null || Date.parse(item.snoozedUntil) <= nowMs),
    ).length,
  };
}

function publishInbox(machine: DemoMachine) {
  const harness = harnesses.get(machine.environmentId);
  setTimeout(
    () => harness?.emitStreamValue(WS_METHODS.subscribeInbox, inboxSnapshotFor(machine)),
    20,
  );
}

function updateInboxOf(machine: DemoMachine, input: NormalizedWsRpcRequestBody) {
  const now = new Date().toISOString();
  const ids = new Set(Array.isArray(input.ids) ? (input.ids as string[]) : []);
  const matches = (item: InboxItem) =>
    ids.has(item.id) ||
    (typeof input.threadId === "string" &&
      item.open?.kind === "thread" &&
      item.open.threadId === input.threadId);
  let items = inboxItemsFor(machine);
  switch (input.action) {
    case "read":
      items = items.map((item) => (matches(item) ? { ...item, readAt: item.readAt ?? now } : item));
      break;
    case "unread":
      items = items.map((item) => (matches(item) ? { ...item, readAt: null } : item));
      break;
    case "readAll":
      items = items.map((item) => ({ ...item, readAt: item.readAt ?? now }));
      break;
    case "snooze":
      items = items.map((item) =>
        matches(item) ? { ...item, snoozedUntil: String(input.until ?? now) } : item,
      );
      break;
    case "unsnooze":
      items = items.map((item) => (matches(item) ? { ...item, snoozedUntil: null } : item));
      break;
    case "dismiss":
      items = items.filter((item) => !matches(item));
      break;
    case "clearRead":
      items = items.filter((item) => item.readAt === null);
      break;
  }
  inboxes.set(machine.environmentId, items);
  publishInbox(machine);
  return inboxSnapshotFor(machine);
}

// ── RPC ──────────────────────────────────────────────────────────────────

const unknownTags = new Set<string>();

function resolveUnary(machine: DemoMachine, body: NormalizedWsRpcRequestBody): unknown {
  const tag = body._tag;
  // p4/p8: reading files of seeded tabs, links and Cloud storage (demoFiles.ts).
  const fileAnswer = answerFileRpc(machine, body);
  if (fileAnswer !== undefined) return fileAnswer;
  // Assistants D: each computer's own vault — list + the account form's upsert.
  if (DEMO_ASSIST) {
    const vaultAnswer = answerVaultRpc(machine.environmentId, String(tag), body);
    if (vaultAnswer !== undefined) return vaultAnswer;
  }
  // p9: the vault's entries for the teammate's access (assistantsFixtures.ts).
  const teamAnswer = answerTeamRpc(String(body._tag));
  if (teamAnswer !== undefined) return teamAnswer;
  // p1/p2: the agent's browser on the cloud computers (demoBrowser.ts).
  const live = demoBrowserLiveUnary(machine, body, (method, value) =>
    harnesses.get(machine.environmentId)?.emitStreamValue(method, value),
  );
  if (live) return live.value;
  switch (tag) {
    case WS_METHODS.serverGetConfig:
      return serverConfigFor(machine);
    case WS_METHODS.serverGetSettings:
      return serverConfigFor(machine).settings;
    case WS_METHODS.filesystemBrowse: {
      const partial = typeof body.partialPath === "string" ? body.partialPath : "~";
      const base = partial.startsWith("~") ? machine.home + partial.slice(1) : partial;
      const parentPath = base.endsWith("/") ? base : `${base}/`;
      const projects = modelFor(machine).projects.filter(
        (p) => p.title !== "Home folder" && p.title !== "Uno",
      );
      return {
        parentPath,
        entries:
          parentPath === `${machine.home}/`
            ? [
                { name: "projects", fullPath: `${machine.home}/projects`, kind: "directory" },
                { name: "Documents", fullPath: `${machine.home}/Documents`, kind: "directory" },
              ]
            : parentPath === `${machine.home}/projects/`
              ? projects.map((p) => ({
                  name: String(p.title),
                  fullPath: String(p.workspaceRoot),
                  kind: "directory",
                }))
              : [],
      };
    }
    case WS_METHODS.projectsSearchEntries:
      return { entries: [], truncated: false };
    case WS_METHODS.projectsWriteFile:
      // Attached files: nothing is stored in the demo, the upload just succeeds.
      return { relativePath: body.relativePath };
    case WS_METHODS.vcsListRefs:
      return { isRepo: false, hasPrimaryRemote: false, nextCursor: null, totalCount: 0, refs: [] };
    case WS_METHODS.serverDiscoverSourceControl:
      return { versionControlSystems: [], sourceControlProviders: demoSourceControlHosts() };
    // A new project on GitHub or GitLab (`?hosts=github,gitlab`): nothing leaves the page.
    case WS_METHODS.projectSyncStartRepository:
      return null; // a void answer: this harness doesn't encode it, and JSON would drop undefined
    case WS_METHODS.projectSyncConnectHost:
      return {
        projectId: body.projectId,
        enabled: true,
        name: String(body.repository).split("/").pop(),
        mode: "git",
        state: "synced",
        message: "",
        lastSyncedAt: new Date().toISOString(),
        conflict: null,
        host: {
          provider: body.provider,
          repository: String(body.repository),
          url: `https://${String(body.provider)}.com/${String(body.repository)}`,
          remote: "origin",
        },
      };
    case WS_METHODS.serverGetTraceDiagnostics:
      return demoTraceDiagnostics();
    case WS_METHODS.unoComputerGetState:
      return computerStateFor(machine);
    case WS_METHODS.unoComputerLocalMetrics:
      // Multi-computer variants: each computer's own live load (assist/metrics.ts).
      if (DEMO_ASSIST) return demoMetrics(machine);
      return {
        hostname: machine.label,
        platform: machine.os,
        cpuPct: machine.key === "work" ? 64 : machine.key === "product" ? 38 : 22,
        cpuCount: machine.os === "darwin" ? 8 : 8,
        memUsedMb: machine.key === "mac" ? 14_100 : 9_800,
        memTotalMb: machine.os === "darwin" ? 16_384 : 16_384,
        diskUsedGb: 74,
        diskTotalGb: machine.os === "darwin" ? 512 : 160,
        uptimeS: 86_400 * 2,
      };
    case WS_METHODS.unoComputerPlanLimits:
      return planLimitsFor(machine.key);
    case WS_METHODS.serverUpdateSettings: {
      const patch = (body as { patch?: Record<string, unknown> }).patch ?? {};
      if (DEMO_ACCOUNTS) applyDemoPlanSettings(patch);
      applyDemoMachineSettings(machine, patch as ServerSettingsPatch);
      emitDemoConfig(machine);
      return serverConfigFor(machine).settings;
    }
    case WS_METHODS.unoComputerPlanResumeCancel: {
      const threadId = (body as { threadId?: string }).threadId ?? "";
      const thread = modelFor(machine).threads.find((entry) => entry.id === threadId);
      if (thread) {
        (thread.activities as Array<Record<string, unknown>>).push(planResumeEndedActivity());
        touch(modelFor(machine));
        publishThread(machine, threadId);
      }
      return { cancelled: thread !== undefined };
    }
    case WS_METHODS.unoComputerProviderAccountAdd: {
      const input = body as { driver?: "claudeAgent" | "codex"; name?: string };
      const added = addDemoAccount(input.driver ?? "claudeAgent", input.name ?? "Personal");
      emitDemoConfig(machine);
      return added;
    }
    case WS_METHODS.unoComputerProviderAccountRemove: {
      const removed = removeDemoAccount((body as { instanceId?: string }).instanceId ?? "");
      emitDemoConfig(machine);
      return removed;
    }
    case WS_METHODS.providerAuthStart:
      return {
        jobId: startDemoAuth(body as unknown as { driver: string; instanceId?: string }),
      };
    case WS_METHODS.providerAuthStatus: {
      const { status, done } = pollDemoAuth((body as { jobId?: string }).jobId ?? "");
      if (done) emitDemoConfig(machine);
      return status;
    }
    case WS_METHODS.unoComputerMachineApps:
      return demoMachineApps(machine);
    case WS_METHODS.workSites:
      return demoWorkSites();
    case WS_METHODS.unoEconomyPresence:
      return {
        enabled: false,
        state: "off",
        sleepAfter: null,
        idleTimeoutS: 900,
        busy: [],
        reportedAt: new Date().toISOString(),
      };
    case WS_METHODS.workspaceGetState:
      return workspaceState();
    case WS_METHODS.unoCloudGetState:
      return cloudState();
    case WS_METHODS.filesList:
      return filesListFor(machine, typeof body.path === "string" ? body.path : undefined);
    case WS_METHODS.inboxUpdate:
      return updateInboxOf(machine, body);
    case ORCHESTRATION_WS_METHODS.dispatchCommand:
      return applyCommand(machine, body);
    default:
      if (!unknownTags.has(tag)) {
        unknownTags.add(tag);
        console.debug("[demo] unmocked rpc", tag);
      }
      return {};
  }
}

/** What `?hosts=github,gitlab` says this computer is signed in to. */
function demoSourceControlHosts() {
  const hosts = new URLSearchParams(location.search).get("hosts")?.split(",") ?? [];
  return hosts.map((kind) => ({
    kind,
    label: kind === "github" ? "GitHub" : "GitLab",
    status: "available",
    version: { _tag: "None" },
    installHint: "Sign in on this computer.",
    detail: { _tag: "None" },
    auth: {
      status: "authenticated",
      account: { _tag: "Some", value: "demo-user" },
      host: { _tag: "None" },
      detail: { _tag: "None" },
    },
  }));
}

function initialStream(machine: DemoMachine, request: NormalizedWsRpcRequestBody) {
  const live = demoBrowserLiveInitial(machine, request, (method, value) =>
    harnesses.get(machine.environmentId)?.emitStreamValue(method, value),
  );
  if (live) return live;
  const model = modelFor(machine);
  switch (request._tag) {
    case WS_METHODS.subscribeServerLifecycle:
      return [
        {
          version: 1,
          sequence: 1,
          type: "welcome",
          payload: {
            environment: descriptorFor(machine),
            cwd: machine.home,
            projectName: "Home folder",
          },
        },
      ];
    case WS_METHODS.subscribeServerConfig:
      return [{ version: 1, type: "snapshot", config: serverConfigFor(machine) }];
    case WS_METHODS.subscribeInbox:
      return [inboxSnapshotFor(machine)];
    case ORCHESTRATION_WS_METHODS.subscribeShell:
      return [{ kind: "snapshot", snapshot: toShellSnapshot(model as never) }];
    case ORCHESTRATION_WS_METHODS.subscribeThread: {
      const thread = threadDetail(model, String(request.threadId));
      return thread
        ? [{ kind: "snapshot", snapshot: { snapshotSequence: model.snapshotSequence, thread } }]
        : [];
    }
    default:
      return [];
  }
}

function threadDetail(model: Model, threadId: string) {
  return model.threads.find((thread) => thread.id === threadId) ?? null;
}

function computerStateFor(machine: DemoMachine) {
  const now = new Date().toISOString();
  return machine.machineKind === "uno_box"
    ? {
        linked: true,
        own: true,
        box: {
          id: machine.boxId,
          name: machine.label,
          status: "running",
          os: "Ubuntu 24.04",
          ramMb: 16_384,
          vcpu: 8,
          diskGb: 160,
          startedAt: new Date(Date.now() - 86_400_000).toISOString(),
          // p8: a cloud computer has a public address — its share links work from anywhere.
          address: `${machine.label}-${machine.boxId}.app.uno4.dev`,
          ssh: null,
          ports: [],
        },
        candidates: [],
        error: null,
        fetchedAt: now,
      }
    : { linked: true, own: false, box: null, candidates: [], error: null, fetchedAt: now };
}

function box(id: number, name: string, status: string) {
  return {
    id,
    name,
    status,
    os: "Ubuntu 24.04",
    ramMb: 16_384,
    vcpu: 8,
    diskGb: 160,
    ssh: null,
    publicIp: null,
    internalIp: null,
    createdAt: new Date(Date.now() - 86_400_000 * 20).toISOString(),
    sleepDeadlineAt: null,
    hostname: `${name}.app.uno4.dev`,
    url: `https://${name}.app.uno4.dev`,
    workMachine: true,
  };
}

/** The account's computers as the console lists them (`GET /api/v1/boxes`). */
function accountBoxes() {
  if (DEMO_ASSIST) return [];
  const wire = (id: number, name: string, status: string) => ({
    id,
    name,
    status,
    os: "Ubuntu 24.04",
    ram_mb: 16_384,
    vcpu: 8,
    disk_gb: 160,
    created_at: new Date(Date.now() - 86_400_000 * 20).toISOString(),
    hostname: `${name}.app.uno4.dev`,
    url: `https://${name}.app.uno4.dev`,
    work_machine: true,
  });
  return [
    wire(MACHINES.work.boxId!, MACHINES.work.label, "running"),
    wire(MACHINES.product.boxId!, MACHINES.product.label, "running"),
    wire(SLEEPING_BOX.id, SLEEPING_BOX.name, "sleeping"),
  ];
}

function cloudState() {
  return {
    connected: true,
    account: {
      userId: 85,
      username: "misha",
      email: null,
      balance: 212.4,
      llmBalance: 0,
      oneWallet: true,
      role: "admin",
    },
    boxes: DEMO_ASSIST
      ? [
          box(MACHINES.work.boxId!, MACHINES.work.label, "running"),
          ...(WORLD.account === "live"
            ? [
                box(
                  MACHINES.product.boxId!,
                  MACHINES.product.label,
                  // Multi-computer variants: `__mcDemo.wake("product")` wakes it.
                  isWoken("product") ? "running" : "sleeping",
                ),
              ]
            : []),
        ]
      : [
          box(MACHINES.work.boxId!, MACHINES.work.label, "running"),
          box(MACHINES.product.boxId!, MACHINES.product.label, "running"),
          box(SLEEPING_BOX.id, SLEEPING_BOX.name, "sleeping"),
        ],
    fetchedAt: new Date().toISOString(),
    error: null,
  };
}

function workspaceState() {
  const at = new Date(Date.now() - 86_400_000 * 9).toISOString();
  return {
    identity: {
      workspaceId: "ws-demo",
      name: "Misha's workspace",
      epoch: 1,
      registryEnvironmentId: PRIMARY_MACHINE.environmentId,
      unoAccountId: 85,
      createdAt: at,
      updatedAt: at,
    },
    machines: (DEMO_ASSIST ? [PRIMARY_MACHINE, ...savedMachines()] : MACHINE_LIST).map(
      (machine, index) => ({
        environmentId: machine.environmentId,
        label: machine.label,
        monogram: machine.label.slice(0, 1).toUpperCase(),
        colorSlot: index,
        kind: machine.machineKind === "uno_box" ? "uno_box" : "local",
        unoBoxId: machine.boxId,
        scope: "full",
        repositories: [],
        addedAt: at,
        lastSeenAt: new Date().toISOString(),
      }),
    ),
  };
}

function filesListFor(machine: DemoMachine, path: string | undefined) {
  const root = machine.home;
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const folder = (name: string, base: string) => ({
    name,
    path: `${base}/${name}`,
    kind: "directory",
    size: 0,
    modifiedAt: at,
    hidden: false,
    isSymlink: false,
  });
  const current = path && path !== "~" ? path.replace(/^~/, root) : root;
  const projects = modelFor(machine).projects.filter(
    (p) => p.workspaceRoot !== root && p.title !== "Uno",
  );
  const entries =
    demoFolderEntries(machine, current) ??
    (current === root
      ? [folder("projects", root), folder("Documents", root), folder("Downloads", root)]
      : current === `${root}/projects`
        ? projects.map((p) => folder(String(p.title), `${root}/projects`))
        : []);
  return {
    path: current,
    rootPath: root,
    parentPath: current === root ? null : current.replace(/\/[^/]+$/, ""),
    entries,
  };
}

// ── Commands ─────────────────────────────────────────────────────────────

let commandSequence = 100;

function touch(model: Model) {
  model.snapshotSequence += 1;
  commandSequence += 1;
}

/** The daemon's side of the commands a click sends: Done, Snooze, Archive, answers, new chats. */
function applyCommand(machine: DemoMachine, command: NormalizedWsRpcRequestBody) {
  const model = modelFor(machine);
  const now = new Date().toISOString();
  const thread = model.threads.find((t) => t.id === command.threadId) as
    | (WireThread & Record<string, unknown>)
    | undefined;
  switch (command.type) {
    case "thread.settle":
      if (thread) Object.assign(thread, { settledOverride: "settled", settledAt: now });
      break;
    case "thread.unsettle":
      if (thread) Object.assign(thread, { settledOverride: "active", settledAt: null });
      break;
    case "thread.snooze":
      if (thread) Object.assign(thread, { snoozedUntil: command.snoozedUntil, snoozedAt: now });
      break;
    case "thread.unsnooze":
      if (thread) Object.assign(thread, { snoozedUntil: null, snoozedAt: null });
      break;
    case "thread.archive":
      if (thread) Object.assign(thread, { archivedAt: now });
      break;
    case "thread.unarchive":
      if (thread) Object.assign(thread, { archivedAt: null });
      break;
    case "thread.meta.update":
      if (thread) {
        if (typeof command.title === "string") thread.title = command.title;
        if (command.pinnedAt !== undefined) thread.pinnedAt = command.pinnedAt as string | null;
        if (command.modelSelection) thread.modelSelection = command.modelSelection as never;
      }
      break;
    case "thread.delete":
      if (thread) Object.assign(thread, { deletedAt: now });
      break;
    case "thread.approval.respond": {
      const decision = String(command.decision ?? "accept");
      const allowed = !/decline|deny|reject|cancel/i.test(decision);
      // An assistant's Allow card: its script goes on (assist/engine.ts).
      if (DEMO_ASSIST && onApproval(machine.key, String(command.threadId), allowed)) {
        return { sequence: commandSequence };
      }
      answerChat(machine, String(command.threadId), allowed ? "Allow" : "Deny");
      return { sequence: commandSequence };
    }
    case "thread.user-input.respond": {
      const answers = (command.answers ?? {}) as Record<string, unknown>;
      const first = Object.values(answers)[0];
      const text = Array.isArray(first) ? first.join(", ") : String(first ?? "OK");
      // p7: an assistant setting itself up answers by its own script.
      const setup = isSetupChat(String(command.threadId));
      if (DEMO_ASSIST) {
        // Its answer shows as the person's line; the assistant's script goes on.
        answerChat(machine, String(command.threadId), text, false);
        if (!onAnswer(machine.key, String(command.threadId), text)) {
          setTimeout(() => finishTurn(machine, String(command.threadId)), 1500);
        }
        return { sequence: commandSequence };
      }
      answerChat(machine, String(command.threadId), text, !setup);
      if (setup) answerSetupChat(machine.environmentId, String(command.threadId), text);
      return { sequence: commandSequence };
    }
    case "project.create": {
      const project = {
        id: command.projectId,
        title: command.title,
        workspaceRoot: String(command.workspaceRoot).replace(/^~/, machine.home),
        repositoryIdentity: null,
        defaultModelSelection: command.defaultModelSelection ?? null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      model.projects.push(project);
      touch(model);
      emitShell(machine, { kind: "project-upserted", sequence: model.snapshotSequence, project });
      return { sequence: commandSequence };
    }
    case "thread.create":
    case "thread.turn.start": {
      const create =
        command.type === "thread.create"
          ? command
          : ((command.bootstrap as { createThread?: Record<string, unknown> } | undefined)
              ?.createThread ?? null);
      let target = thread;
      if (DEMO_ACCOUNTS && target && pendingPlanResume(target.activities as never)) {
        // The person went on themselves: the daemon drops the wait.
        (target.activities as unknown[]).push(planResumeEndedActivity());
      }
      if (DEMO_ACCOUNTS && target && command.modelSelection) {
        target.modelSelection = command.modelSelection as never;
      }
      if (!target && create) {
        target = {
          id: command.threadId,
          projectId: create.projectId,
          title: create.title,
          modelSelection: create.modelSelection,
          interactionMode: "default",
          runtimeMode: create.runtimeMode ?? "full-access",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          pinnedAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          settledOverride: null,
          settledAt: null,
          spawnedByThreadId: null,
          controller: "human",
          controlChangedAt: null,
          assistantRole: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        } as unknown as WireThread & Record<string, unknown>;
        model.threads.unshift(target as never);
      }
      if (target && command.type === "thread.turn.start") {
        const message = command.message as { messageId: string; text: string };
        recordAgentSwitch(target, command.modelSelection);
        if (typeof command.titleSeed === "string" && target.title === "New chat")
          target.title = command.titleSeed;
        startTurn(target, message.messageId, message.text);
        touch(model);
        publishThread(machine, String(command.threadId));
        // An assistant's chat answers by its script (assist/engine.ts).
        if (DEMO_ASSIST && onTurn(machine.key, String(command.threadId), message.text)) {
          return { sequence: commandSequence };
        }
        // A variant can answer some messages itself (Loom Work: a recording).
        const replyTo = demoHooks.replyTo as ((text: string) => string | null) | undefined;
        const reply = replyTo?.(message.text) ?? undefined;
        setTimeout(() => finishTurn(machine, String(command.threadId), reply), reply ? 3200 : 2200);
        return { sequence: commandSequence };
      }
      break;
    }
    default:
      return { sequence: commandSequence };
  }
  touch(model);
  publishThread(machine, String(command.threadId));
  return { sequence: commandSequence };
}

/** The chat moved to another agent: the daemon's line in the feed (orchestration/handoff.ts). */
function recordAgentSwitch(target: WireThread & Record<string, unknown>, selection: unknown) {
  const next = selection as { instanceId: string; model: string } | undefined;
  const session = target.session as { providerInstanceId?: string } | null;
  const previous = session?.providerInstanceId ?? String(target.modelSelection.instanceId);
  if (!next || next.instanceId === previous) return;
  const names: Record<string, string> = { claudeAgent: "Claude", codex: "Codex" };
  const total = (target.messages as unknown[]).length;
  const to = names[next.instanceId] ?? next.instanceId;
  const payload = {
    to,
    toInstanceId: next.instanceId,
    fromInstanceId: previous,
    carried: total,
    total,
    turnCount: 0,
  };
  const createdAt = new Date().toISOString();
  (target.activities as Array<Record<string, unknown>>).push({
    id: `activity-agent-switch-${commandSequence}`,
    tone: "info",
    kind: AGENT_SWITCH_ACTIVITY_KIND,
    summary: agentSwitchLine(payload),
    payload,
    turnId: null,
    createdAt,
  });
  target.modelSelection = next as never;
  if (session) session.providerInstanceId = next.instanceId;
}

function startTurn(target: WireThread & Record<string, unknown>, messageId: string, text: string) {
  const now = new Date().toISOString();
  const turnId = `turn-${String(target.id)}-${commandSequence}`;
  (target.messages as unknown[]).push({
    id: messageId,
    role: "user",
    text,
    turnId: null,
    streaming: false,
    createdAt: now,
    updatedAt: now,
  });
  Object.assign(target, {
    updatedAt: now,
    settledOverride: null,
    snoozedUntil: null,
    latestTurn: {
      turnId,
      state: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      assistantMessageId: null,
    },
    session: {
      threadId: target.id,
      status: "running",
      providerName: "uno",
      runtimeMode: "full-access",
      activeTurnId: turnId,
      lastError: null,
      updatedAt: now,
    },
  });
}

/** What the agent says after the person's answer (made up, calm). */
function replyAfter(threadId: string, answer: string): string {
  const chat = chatById(threadId);
  const ask = chat?.ask;
  if (/^(deny|not yet|remind me later|only in billing)/i.test(answer)) {
    return `OK — “${answer}”. I'll leave it as is and tell the coordinator.`;
  }
  switch (ask?.kind) {
    case "permission":
      return "Promoted: 0.0.118 is latest. Computers get Update now; rollback stays one command.";
    case "review":
      return `Merged ${ask.pr} into release/0.0.119. Stage rebuilds in ~3 min.`;
    case "payment":
      return `Paid ${ask.amount}. Receipt is in Files → Documents/receipts.`;
    default:
      return `Got it: “${answer}”. Continuing — I'll show you a preview on stage.`;
  }
}

/**
 * The person answered a chat that waits (from a card, the Inbox or the chat
 * itself): the question / approval resolves, their answer goes in the chat,
 * the agent works a moment and replies; the Inbox item of the chat is gone.
 */
export function answerChat(
  machine: DemoMachine,
  threadId: string,
  answer: string,
  /** false: whoever asked replies itself (an assistant's setup chat). */
  autoReply = true,
) {
  const model = modelFor(machine);
  const target = model.threads.find((t) => t.id === threadId) as
    | (WireThread & Record<string, unknown>)
    | undefined;
  if (!target) return;
  const now = new Date().toISOString();
  const activities = target.activities as Array<Record<string, unknown>>;
  for (const activity of [...activities]) {
    const kind = String(activity.kind);
    if (!kind.endsWith(".requested")) continue;
    activities.push({
      ...activity,
      id: `${String(activity.id)}-resolved`,
      kind: kind.replace(".requested", ".resolved"),
      summary: "Answered",
      createdAt: now,
    });
  }
  startTurn(target, `${threadId}-answer-${Date.now()}`, answer);
  touch(model);
  publishThread(machine, threadId);
  inboxes.set(
    machine.environmentId,
    inboxItemsFor(machine).filter(
      (item) => !(item.open?.kind === "thread" && item.open.threadId === threadId),
    ),
  );
  publishInbox(machine);
  if (autoReply)
    setTimeout(() => finishTurn(machine, threadId, replyAfter(threadId, answer)), 2400);
}

/** For the variants' cards: answer by environment id. */
export function answerChatIn(environmentId: string, threadId: string, answer: string) {
  const machine = machineByEnv(environmentId);
  if (machine) answerChat(machine, threadId, answer);
}

/** A failed chat restarted from a card ("Retry on uno-work"). */
export function retryChatIn(environmentId: string, threadId: string, text: string) {
  const machine = machineByEnv(environmentId);
  if (!machine) return;
  const model = modelFor(machine);
  const target = model.threads.find((t) => t.id === threadId) as
    | (WireThread & Record<string, unknown>)
    | undefined;
  if (!target) return;
  startTurn(target, `${threadId}-retry-${Date.now()}`, text);
  touch(model);
  publishThread(machine, threadId);
  inboxes.set(
    machine.environmentId,
    inboxItemsFor(machine).filter(
      (item) => !(item.open?.kind === "thread" && item.open.threadId === threadId),
    ),
  );
  publishInbox(machine);
}

/**
 * p3: the chat goes back to its fixture state, so "Показать" can be pressed
 * again without the agent's replies piling up.
 */
export function demoResetChatIn(environmentId: string, threadId: string) {
  const machine = machineByEnv(environmentId);
  const spec = chatById(threadId);
  if (!machine || !spec) return;
  const model = modelFor(machine);
  const index = model.threads.findIndex((t) => t.id === threadId);
  if (index === -1) return;
  model.threads[index] = { ...buildThread(spec), deletedAt: null } as Model["threads"][number];
  touch(model);
  publishThread(machine, threadId);
}

/** p3: the agent of a running chat finishes its turn with `text` (a reply arrives). */
export function demoAgentRepliesIn(environmentId: string, threadId: string, text: string) {
  const machine = machineByEnv(environmentId);
  if (machine) finishTurn(machine, threadId, text);
}

/**
 * p2b: the person asks (`userText`), the agent answers (`agentText`) and keeps
 * working — a running turn, as while it waits for the person in its browser.
 */
export function demoAgentWorksIn(
  environmentId: string,
  threadId: string,
  userText: string,
  agentText: string,
) {
  const machine = machineByEnv(environmentId);
  if (!machine) return;
  const target = modelFor(machine).threads.find((t) => t.id === threadId) as
    | (WireThread & Record<string, unknown>)
    | undefined;
  if (!target) return;
  const now = new Date().toISOString();
  const stamp = Date.now();
  const turnId = `turn-${threadId}-work-${stamp}`;
  const message = (role: "user" | "assistant", text: string, turn: string | null) => ({
    id: `${threadId}-${role}-${stamp}`,
    role,
    text,
    turnId: turn,
    streaming: false,
    createdAt: now,
    updatedAt: now,
  });
  (target.messages as unknown[]).push(
    message("user", userText, null),
    message("assistant", agentText, turnId),
  );
  Object.assign(target, {
    updatedAt: now,
    latestTurn: {
      turnId,
      state: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      assistantMessageId: null,
    },
    session: {
      threadId,
      status: "running",
      providerName: "uno",
      runtimeMode: "full-access",
      activeTurnId: turnId,
      lastError: null,
      updatedAt: now,
    },
  });
  touch(modelFor(machine));
  publishThread(machine, threadId);
}

/**
 * p3: the agent of a chat says why (`explanation`) and stops for an OK to run
 * `command` (an approval) — the same events a real agent sends.
 */
export function demoAgentAsksApprovalIn(
  environmentId: string,
  threadId: string,
  command: string,
  explanation?: string,
) {
  const machine = machineByEnv(environmentId);
  if (!machine) return;
  const model = modelFor(machine);
  const target = model.threads.find((t) => t.id === threadId) as
    | (WireThread & Record<string, unknown>)
    | undefined;
  if (!target) return;
  const now = new Date().toISOString();
  const stamp = Date.now();
  // The agent is mid-turn while it waits: a running turn that asks.
  const turnId = `turn-${threadId}-ask-${stamp}`;
  if (explanation) {
    (target.messages as unknown[]).push({
      id: `${threadId}-explain-${stamp}`,
      role: "assistant",
      text: explanation,
      turnId,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    });
  }
  (target.activities as Array<Record<string, unknown>>).push({
    id: `${threadId}-approval-${stamp}`,
    tone: "approval",
    kind: "approval.requested",
    summary: "Waiting for your OK",
    payload: { requestId: `${threadId}-req-${stamp}`, requestKind: "command", detail: command },
    turnId,
    createdAt: now,
  });
  Object.assign(target, {
    updatedAt: now,
    latestTurn: {
      turnId,
      state: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      assistantMessageId: null,
    },
    session: {
      threadId,
      status: "running",
      providerName: "uno",
      runtimeMode: "full-access",
      activeTurnId: turnId,
      lastError: null,
      updatedAt: now,
    },
  });
  touch(model);
  publishThread(machine, threadId);
}

/** p7: the assistant's setup chat — a new thread in its folder, the assistant speaks first. */
function createDemoThread(
  machine: DemoMachine,
  input: { threadId: string; projectId: string; title: string },
) {
  const model = modelFor(machine);
  const now = new Date().toISOString();
  model.threads.unshift({
    id: input.threadId,
    projectId: input.projectId,
    title: input.title,
    // The same as the chats around it (the schema wants one).
    modelSelection: (model.threads[0] as { modelSelection?: unknown } | undefined)?.modelSelection,
    interactionMode: "default",
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    settledOverride: null,
    settledAt: null,
    spawnedByThreadId: null,
    controller: "human",
    controlChangedAt: null,
    // A teammate's own chat — not Uno's main one.
    assistantRole: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  } as never);
  touch(model);
  publishThread(machine, input.threadId);
}

/** p7: the assistant says `text` and, with a question, waits for the answer (a quiz card). */
function assistantSays(
  machine: DemoMachine,
  threadId: string,
  text: string,
  question?: Record<string, unknown>,
) {
  finishTurn(machine, threadId, text);
  if (!question) return;
  const model = modelFor(machine);
  const thread = model.threads.find((t) => t.id === threadId) as
    | (WireThread & Record<string, unknown>)
    | undefined;
  if (!thread) return;
  const stamp = Date.now();
  const turn = thread.latestTurn as { turnId: string } | null;
  (thread.activities as Array<Record<string, unknown>>).push({
    id: `${threadId}-ask-${stamp}`,
    tone: "info",
    kind: "user-input.requested",
    summary: "Waiting for your answer",
    payload: { requestId: `${threadId}-req-${stamp}`, questions: [question] },
    turnId: turn?.turnId ?? null,
    createdAt: new Date().toISOString(),
  });
  touch(model);
  publishThread(machine, threadId);
}

/** What the daemon pushes after a settings or sign-in change. */
function emitDemoConfig(machine: DemoMachine) {
  const config = serverConfigFor(machine);
  const harness = harnesses.get(machine.environmentId);
  setTimeout(() => {
    harness?.emitStreamValue(WS_METHODS.subscribeServerConfig, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings: config.settings },
    });
    harness?.emitStreamValue(WS_METHODS.subscribeServerConfig, {
      version: 1,
      type: "providerStatuses",
      payload: { providers: config.providers },
    });
  }, 30);
}

function publishThread(machine: DemoMachine, threadId: string) {
  const model = modelFor(machine);
  const changed = model.threads.find((t) => t.id === threadId);
  if (!changed) return;
  if (changed.deletedAt) {
    emitShell(machine, { kind: "thread-removed", sequence: model.snapshotSequence, threadId });
    return;
  }
  emitShell(machine, {
    kind: "thread-upserted",
    sequence: model.snapshotSequence,
    thread: toShellThread(changed),
  });
  const harness = harnesses.get(machine.environmentId);
  // Every open chat view re-syncs the chat named in the snapshot — harmless for the others.
  setTimeout(
    () =>
      harness?.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "snapshot",
        snapshot: { snapshotSequence: model.snapshotSequence, thread: changed },
      }),
    40,
  );
}

function finishTurn(machine: DemoMachine, threadId: string, text?: string) {
  const model = modelFor(machine);
  const thread = model.threads.find((t) => t.id === threadId) as
    | (WireThread & Record<string, unknown>)
    | undefined;
  if (!thread) return;
  const now = new Date().toISOString();
  const turn = thread.latestTurn as { turnId: string } | null;
  const messageId = `${threadId}-reply-${Date.now()}`;
  (thread.messages as unknown[]).push({
    id: messageId,
    role: "assistant",
    text: text ?? "Got it — I'm on it. (A demo with made-up data: nothing really runs here.)",
    turnId: turn?.turnId ?? null,
    streaming: false,
    createdAt: now,
    updatedAt: now,
  });
  Object.assign(thread, {
    updatedAt: now,
    latestTurn: turn
      ? { ...turn, state: "completed", completedAt: now, assistantMessageId: messageId }
      : null,
    session: {
      threadId,
      status: "ready",
      providerName: "uno",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    },
  });
  touch(model);
  publishThread(machine, threadId);
}

function emitShell(machine: DemoMachine, event: unknown) {
  const harness = harnesses.get(machine.environmentId);
  // After the answer to the command, like the daemon.
  setTimeout(() => harness?.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, event), 30);
}

const harnesses = new Map<string, BrowserWsRpcHarness>();
async function harnessFor(machine: DemoMachine) {
  let harness = harnesses.get(machine.environmentId);
  if (!harness) {
    harness = new BrowserWsRpcHarness();
    await harness.reset({
      resolveUnary: (body) => resolveUnary(machine, body),
      getInitialStreamValues: (request) => initialStream(machine, request),
    });
    harnesses.set(machine.environmentId, harness);
  }
  return harness;
}

const sessionJson = (machine: DemoMachine) => ({
  authenticated: true,
  auth: serverConfigFor(machine).auth,
  role: "owner",
  sessionMethod: "browser-session-cookie",
  expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString(),
});

/** p7: "New assistant" makes its folder on that computer (like project.create). */
function addDemoProject(
  machine: DemoMachine,
  input: { id: string; title: string; workspaceRoot: string },
) {
  const model = modelFor(machine);
  if (model.projects.some((project) => project.id === input.id)) return;
  const now = new Date().toISOString();
  const project = {
    ...input,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  model.projects.push(project);
  touch(model);
  emitShell(machine, { kind: "project-upserted", sequence: model.snapshotSequence, project });
}

/** A card arriving in a computer's Inbox right now (the team's notices). */
function addDemoInbox(spec: (typeof INBOX)[number]) {
  const machine = MACHINES[spec.machine];
  inboxes.set(machine.environmentId, [buildInboxItem(spec), ...inboxItemsFor(machine)]);
  publishInbox(machine);
}

// ── The assistants base (VITE_DEMO=assist): chats the engine drives ──────

type MutableThread = WireThread & Record<string, unknown>;

/** An assistant's chats run in its own mode, as its daemon makes them (assistantOwnRuntimeMode). */
function assistantRuntimeMode(key: MachineKey, projectId: string): RuntimeMode {
  const preset = presetOf(key, projectId);
  return preset ? assistantOwnRuntimeMode(preset) : "full-access";
}

function threadIn(key: MachineKey, threadId: string): MutableThread | null {
  return (
    (modelFor(MACHINES[key]).threads.find((t) => t.id === threadId) as MutableThread | undefined) ??
    null
  );
}

function newThread(
  machine: DemoMachine,
  input: {
    threadId: string;
    projectId: string;
    title: string;
    assistantRole?: "chat" | "spawned" | null;
    spawnedBy?: string | null;
  },
) {
  const model = modelFor(machine);
  const now = new Date().toISOString();
  model.threads.unshift({
    id: input.threadId,
    projectId: input.projectId,
    title: input.title,
    modelSelection: (model.threads[0] as { modelSelection?: unknown } | undefined)
      ?.modelSelection ?? { instanceId: "uno", model: "uno/smart" },
    interactionMode: "default",
    runtimeMode: assistantRuntimeMode(machine.key, input.projectId),
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    settledOverride: null,
    settledAt: null,
    // Only on its own computer: a chat on another one is linked by its first line.
    spawnedByThreadId:
      input.spawnedBy && model.threads.some((t) => t.id === input.spawnedBy)
        ? input.spawnedBy
        : null,
    controller: input.assistantRole === "spawned" ? "agent" : "human",
    controlChangedAt: null,
    assistantRole: input.assistantRole ?? null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  } as never);
  touch(model);
  publishThread(machine, input.threadId);
}

/** A running turn (no person's line), unless one runs already. */
function ensureRunning(machine: DemoMachine, thread: MutableThread): string {
  const turn = thread.latestTurn as { turnId: string; state: string } | null;
  if (turn && turn.state === "running") return turn.turnId;
  const now = new Date().toISOString();
  const turnId = `turn-${String(thread.id)}-${Date.now().toString(36)}`;
  Object.assign(thread, {
    updatedAt: now,
    latestTurn: {
      turnId,
      state: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      assistantMessageId: null,
    },
    session: {
      threadId: thread.id,
      status: "running",
      providerName: "uno",
      runtimeMode: "full-access",
      activeTurnId: turnId,
      lastError: null,
      updatedAt: now,
    },
  });
  void machine;
  return turnId;
}

function inboxOfDemo(input: DemoInboxInput): InboxItem {
  const now = new Date().toISOString();
  const thread = input.chat ? threadIn(input.machine, input.chat) : null;
  return {
    id: input.id,
    kind: input.kind,
    source: thread
      ? { kind: "agent", id: String(thread.id), name: String(thread.title), icon: null }
      : { kind: "system", id: "uno", name: "Uno", icon: null },
    title: input.title,
    body: input.body,
    open: thread ? { kind: "thread", threadId: String(thread.id) } : null,
    createdAt: now,
    updatedAt: now,
    count: 1,
    readAt: null,
    snoozedUntil: null,
  } as InboxItem;
}

const assistOps = {
  createThread: (key: MachineKey, input: Parameters<typeof newThread>[1]) =>
    newThread(MACHINES[key], input),
  userSays: (key: MachineKey, threadId: string, text: string) => {
    const thread = threadIn(key, threadId);
    if (!thread) return;
    const now = new Date().toISOString();
    (thread.messages as unknown[]).push({
      id: `${threadId}-u-${Date.now().toString(36)}`,
      role: "user",
      text,
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    });
    Object.assign(thread, { updatedAt: now, settledOverride: null });
    touch(modelFor(MACHINES[key]));
    publishThread(MACHINES[key], threadId);
  },
  working: (key: MachineKey, threadId: string, text?: string) => {
    const machine = MACHINES[key];
    const thread = threadIn(key, threadId);
    if (!thread) return;
    const turnId = ensureRunning(machine, thread);
    if (text) {
      const now = new Date().toISOString();
      (thread.messages as unknown[]).push({
        id: `${threadId}-w-${Date.now().toString(36)}`,
        role: "assistant",
        text,
        turnId,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      });
    }
    touch(modelFor(machine));
    publishThread(machine, threadId);
  },
  say: (key: MachineKey, threadId: string, text: string) =>
    finishTurn(MACHINES[key], threadId, text),
  ask: (key: MachineKey, threadId: string, text: string, question: DemoQuestion) =>
    assistantSays(MACHINES[key], threadId, text, question as unknown as Record<string, unknown>),
  askApproval: (key: MachineKey, threadId: string, command: string, explanation: string) =>
    demoAgentAsksApprovalIn(MACHINES[key].environmentId, threadId, command, explanation),
  resolve: (key: MachineKey, threadId: string) => {
    const machine = MACHINES[key];
    const thread = threadIn(key, threadId);
    if (!thread) return;
    const now = new Date().toISOString();
    const activities = thread.activities as Array<Record<string, unknown>>;
    const resolved = new Set(
      activities
        .filter((activity) => String(activity.kind).endsWith(".resolved"))
        .map((activity) => (activity.payload as { requestId?: string } | null)?.requestId),
    );
    for (const activity of [...activities]) {
      const kind = String(activity.kind);
      const requestId = (activity.payload as { requestId?: string } | null)?.requestId;
      if (!kind.endsWith(".requested") || resolved.has(requestId)) continue;
      activities.push({
        ...activity,
        id: `${String(activity.id)}-resolved`,
        kind: kind.replace(".requested", ".resolved"),
        summary: "Answered",
        createdAt: now,
      });
    }
    touch(modelFor(machine));
    publishThread(machine, threadId);
    inboxes.set(
      machine.environmentId,
      inboxItemsFor(machine).filter(
        (item) =>
          !(
            item.open?.kind === "thread" &&
            item.open.threadId === threadId &&
            item.kind === "agent.approval"
          ),
      ),
    );
    publishInbox(machine);
  },
  fail: (key: MachineKey, threadId: string, error: string) => {
    const machine = MACHINES[key];
    const thread = threadIn(key, threadId);
    if (!thread) return;
    const now = new Date().toISOString();
    const turn = thread.latestTurn as Record<string, unknown> | null;
    Object.assign(thread, {
      updatedAt: now,
      latestTurn: turn ? { ...turn, state: "error", completedAt: now } : null,
      session: {
        threadId,
        status: "error",
        providerName: "uno",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: error,
        lastErrorClass: "provider_error",
        updatedAt: now,
      },
    });
    touch(modelFor(machine));
    publishThread(machine, threadId);
  },
  addInbox: (input: DemoInboxInput) => {
    const machine = MACHINES[input.machine];
    inboxes.set(machine.environmentId, [inboxOfDemo(input), ...inboxItemsFor(machine)]);
    publishInbox(machine);
  },
  projectOf: (key: MachineKey, threadId: string) => {
    const thread = threadIn(key, threadId);
    return thread ? String(thread.projectId) : null;
  },
  setTelegram,
  connectorState,
  asksFirst,
  telegramLinked,
  setMode: (key: MachineKey, projectId: string, mode: "itself" | "asks-first") => {
    setMode(key, projectId, mode);
    followMode(key, projectId);
  },
  mainChatOf: (key: MachineKey, projectId: string) =>
    assistDaemonHooks.ensureChat(MACHINES[key], projectId).threadId,
  toolCall: (
    key: MachineKey,
    threadId: string,
    call: { server: string; tool: string; input: Record<string, unknown>; output: unknown },
  ) => {
    const machine = MACHINES[key];
    const thread = threadIn(key, threadId);
    if (!thread) return;
    const turnId = ensureRunning(machine, thread);
    const name = `mcp__${call.server}__${call.tool}`;
    (thread.activities as Array<Record<string, unknown>>).push({
      id: `${threadId}-tool-${Date.now().toString(36)}`,
      tone: "tool",
      kind: "tool.completed",
      summary: name,
      // The shape a harness reports an MCP call in (toolResultPresentation.ts reads it).
      payload: {
        status: "completed",
        data: { toolName: name, input: call.input, rawOutput: call.output },
      },
      turnId,
      createdAt: new Date().toISOString(),
    });
    touch(modelFor(machine));
    publishThread(machine, threadId);
  },
};

/** Its chats run in its new mode from the next turn, as the daemon does. */
function followMode(key: MachineKey, projectId: string) {
  const model = modelFor(MACHINES[key]);
  for (const thread of model.threads) {
    if (String(thread.projectId) === projectId) {
      (thread as MutableThread).runtimeMode = assistantRuntimeMode(key, projectId);
      publishThread(MACHINES[key], String(thread.id));
    }
  }
  touch(model);
}

/** The assistant's main chat on that computer (the daemon makes it on a fresh one). */
function mainChatOf(machine: DemoMachine, projectId: string) {
  return modelFor(machine).threads.find(
    (thread) =>
      thread.projectId === projectId &&
      (thread as MutableThread).deletedAt === null &&
      ((thread as MutableThread).assistantRole === "chat" || projectId !== ASSISTANT_PROJECT_ID),
  );
}

const assistDaemonHooks = {
  machineForHost,
  addProject: addDemoProject,
  ensureChat: (machine: DemoMachine, projectId: string) => {
    const found = mainChatOf(machine, projectId);
    if (found) return { threadId: String(found.id), created: false };
    const threadId = `${projectId}-main-${Date.now().toString(36)}`;
    const name = personaOf(machine.key, projectId)?.name ?? "Uno";
    newThread(machine, { threadId, projectId, title: name, assistantRole: "chat" });
    // A new assistant made with a job gets its first message from the page
    // right away: then it answers that instead of greeting.
    setTimeout(() => {
      const thread = modelFor(machine).threads.find((item) => String(item.id) === threadId);
      const written = ((thread?.messages ?? []) as ReadonlyArray<{ role?: string }>).some(
        (message) => message.role === "user",
      );
      if (!written) void greet(machine.key, threadId);
    }, 1200);
    return { threadId, created: true };
  },
  newConversation: (machine: DemoMachine, projectId: string, title: string) => {
    const threadId = `${projectId}-c-${Date.now().toString(36)}`;
    newThread(machine, { threadId, projectId, title });
    return threadId;
  },
  setupChat: (machine: DemoMachine, projectId: string) => {
    const threadId = `${projectId}-setup-${Date.now().toString(36)}`;
    const name = personaOf(machine.key, projectId)?.name ?? "assistant";
    newThread(machine, { threadId, projectId, title: `Meet ${name}` });
    setTimeout(() => void greet(machine.key, threadId), 500);
    return threadId;
  },
};

/** For the panel and Playwright: the base's scenes, and the main chat to play them in. */
export const assistDemo = {
  ops: assistOps,
  mainChat: (key: MachineKey = "work", projectId: string = ASSISTANT_PROJECT_ID) => {
    const machine = MACHINES[key];
    return assistDaemonHooks.ensureChat(machine, projectId).threadId;
  },
  environmentOf: (key: MachineKey) => MACHINES[key].environmentId,
};

function startAssist() {
  startLinks();
  installAssistFixtures(WORLD);
  startDaemons({ world: WORLD });
  startEngine({ ops: assistOps, personaOf });
  // Variant D: a removed persona stops what it was doing (its chats stay).
  onAssistantModeChanged(followMode);
  onAssistantRevoked((key, projectId, revoked) =>
    revoked ? stopPersona(key, projectId) : restorePersona(key, projectId),
  );
  setPortraitsFail(/[?&]facegen=fail\b/.test(location.search));
  const speed = Number(new URLSearchParams(location.search).get("speed") ?? "1");
  if (Number.isFinite(speed) && speed > 0) setEngineSpeed(speed);
  // Work in the browser on uno-work, or the desktop app (the 16.10 switch).
  useDemoStore.getState().setSwitch("platform", WORLD.platform);
}

export async function startDemo(): Promise<void> {
  // For scripted walks of the demo (Playwright): the same module instance the
  // app uses — an `import()` from the page may get a second copy of it.
  (window as unknown as { __unoDemo?: unknown }).__unoDemo = {
    demoAgentRepliesIn,
    demoAgentWorksIn,
    demoAgentAsksApprovalIn,
    demoResetChatIn,
    addSecretRequest,
  };
  if (DEMO_ASSIST) startAssist();
  seedLocalStorage();
  if (!DEMO_ASSIST) seedAssistantTeam({ addInbox: addDemoInbox });
  void loadAgentFrame();
  // Touch every fixture once so a typo in them fails loudly at start.
  void CHATS.length;
  void ago(0);
  const wsLink = ws.link(/^wss?:\/\/.*/);
  const worker = setupWorker(
    wsLink.addEventListener("connection", ({ client }) => {
      const machine = machineForHost(client.url.host);
      // An asleep computer: the socket closes, the page keeps trying (offline).
      if (DEMO_ASSIST && !machineAwake(machine.key)) {
        client.close(4000, "asleep");
        return;
      }
      // Multi-computer variants: a flaky link closes this socket on its next drop.
      if (DEMO_ASSIST) trackClient(machine.key, client);
      void harnessFor(machine).then((harness) => {
        harness.connect(client);
        client.addEventListener("message", (event) => {
          if (typeof event.data === "string") void harness.onMessage(event.data);
        });
      });
    }),
    http.get("*/.well-known/t3/environment", async ({ request }) => {
      const url = new URL(request.url);
      // "Use this computer" probes a desktop app on 127.0.0.1 — there is none here.
      if (
        url.hostname === "127.0.0.1" ||
        (url.hostname === "localhost" && url.port !== location.port)
      ) {
        await delay("infinite");
      }
      return HttpResponse.json(descriptorFor(machineForHost(url.host)));
    }),
    http.get("*/api/auth/session", ({ request }) =>
      HttpResponse.json(sessionJson(machineForHost(new URL(request.url).host))),
    ),
    http.post("*/api/auth/bootstrap", () =>
      HttpResponse.json({
        authenticated: true,
        sessionMethod: "browser-session-cookie",
        expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString(),
      }),
    ),
    http.post("*/api/auth/ws-token", () =>
      HttpResponse.json({
        token: "demo-ws-token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ),
    // The assistants base: its daemons and account answer first (assist/daemon.ts).
    ...(DEMO_ASSIST ? [...daemonHandlers(assistDaemonHooks), ...accountHandlers()] : []),
    http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
    http.post("*/api/observability/v1/traces", () => new HttpResponse(null, { status: 204 })),
    http.get("*/api/self-update/status", () =>
      HttpResponse.json({ state: "idle", current: DEMO_VERSION, available: null }),
    ),
    http.get("*/api/health", () => HttpResponse.json({ ok: true, version: DEMO_VERSION })),
    ...assistantHandlers({
      machineForHost,
      addProject: addDemoProject,
      chat: { create: createDemoThread, says: assistantSays },
    }),
    // The Uno account (accountTransport() is "work-proxy" in the demo): the
    // person signed in, the computers on the account (two clouds + one asleep).
    http.get("*/_account/auth/me", () =>
      HttpResponse.json({
        id: 85,
        username: "misha",
        email: "misha@example.com",
        balance: 212.4,
        llm_balance: 0,
        one_wallet: true,
        role: "admin",
      }),
    ),
    http.get("*/_account/api/v1/boxes", () => HttpResponse.json({ boxes: accountBoxes() })),
    http.get("*/_account/api/v1/boxes/:id", ({ params }) => {
      const found = accountBoxes().find((item) => String(item.id) === String(params.id));
      return found ? HttpResponse.json(found) : HttpResponse.json({}, { status: 404 });
    }),
    http.all("*/_account/*", () => HttpResponse.json({}, { status: 404 })),
    // p2: the test site's backend (/api/order → 500, a missing image).
    ...demoSiteHandlers,
    // Anything else of a daemon: an empty answer, never the network.
    http.all("*/api/*", () => HttpResponse.json({}, { status: 404 })),
  );
  await worker.start({
    onUnhandledRequest(request) {
      const url = new URL(request.url);
      if (url.origin === location.origin && !url.pathname.startsWith("/api")) return;
      console.debug("[demo] unmocked http", request.method, request.url);
    },
    quiet: true,
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
  });
}
