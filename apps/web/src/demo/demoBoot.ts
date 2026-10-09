/**
 * Demo mode (`?demo=heavy`, icp3 09.10): the real web client with three
 * computers answered inside the page by msw — HTTP through the service
 * worker, each daemon's WebSocket RPC by an in-page RPC server (the harness
 * the browser tests use). Nothing leaves the browser. Grown from the w0115
 * sidebar prototype (fix/w0115-sidebar-proto: protoBoot.ts).
 */
import { ORCHESTRATION_WS_METHODS, WS_METHODS, type InboxItem } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { HttpResponse, delay, http, ws } from "msw";
import { setupWorker } from "msw/browser";

import { BrowserWsRpcHarness, type NormalizedWsRpcRequestBody } from "./rpcHarness";
import {
  CHATS,
  DEMO_VERSION,
  INBOX,
  MACHINES,
  MACHINE_LIST,
  SLEEPING_BOX,
  ago,
  buildInboxItem,
  chatById,
  descriptorFor,
  machineByEnv,
  readModelFor,
  serverConfigFor,
  toShellSnapshot,
  toShellThread,
  type DemoMachine,
  type WireThread,
} from "./heavyFixtures";

const SEED_VERSION = "icp3-heavy-1";

function seedLocalStorage() {
  if (localStorage.getItem("demo:seed") === SEED_VERSION) return;
  const keep = new Set(["demo:variant"]);
  for (const key of Object.keys(localStorage)) {
    if (!keep.has(key)) localStorage.removeItem(key);
  }
  localStorage.setItem(
    "t3code:client-settings:v1",
    JSON.stringify({ ...DEFAULT_CLIENT_SETTINGS, onboardingCompleted: true }),
  );
  const records = [MACHINES.product, MACHINES.mac].map((machine) => ({
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
    MACHINE_LIST.find((machine) => machine.host !== "" && machine.host === host) ?? MACHINES.work
  );
}

// ── State of each computer ──────────────────────────────────────────────

type Model = {
  snapshotSequence: number;
  projects: Array<Record<string, unknown>>;
  threads: Array<WireThread & { deletedAt: string | null; [key: string]: unknown }>;
  updatedAt: string;
};

const models = new Map<string, Model>();
function modelFor(machine: DemoMachine): Model {
  let model = models.get(machine.environmentId);
  if (!model) {
    model = readModelFor(machine) as unknown as Model;
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
    case WS_METHODS.vcsListRefs:
      return { isRepo: false, hasPrimaryRemote: false, nextCursor: null, totalCount: 0, refs: [] };
    case WS_METHODS.serverDiscoverSourceControl:
      return { versionControlSystems: [], sourceControlProviders: [] };
    case WS_METHODS.unoComputerGetState:
      return computerStateFor(machine);
    case WS_METHODS.unoComputerLocalMetrics:
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
    case WS_METHODS.unoComputerMachineApps:
      return {
        apps: [],
        manifestDir: "~/.uno/apps",
        scannedAt: new Date().toISOString(),
        publishBlockedReason: null,
        warnings: [],
      };
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

function initialStream(machine: DemoMachine, request: NormalizedWsRpcRequestBody) {
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
          address: null,
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
    boxes: [
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
      registryEnvironmentId: MACHINES.work.environmentId,
      unoAccountId: 85,
      createdAt: at,
      updatedAt: at,
    },
    machines: MACHINE_LIST.map((machine, index) => ({
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
    })),
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
    current === root
      ? [folder("projects", root), folder("Documents", root), folder("Downloads", root)]
      : current === `${root}/projects`
        ? projects.map((p) => folder(String(p.title), `${root}/projects`))
        : [];
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
      }
      break;
    case "thread.delete":
      if (thread) Object.assign(thread, { deletedAt: now });
      break;
    case "thread.approval.respond": {
      const decision = String(command.decision ?? "accept");
      const allowed = !/decline|deny|reject|cancel/i.test(decision);
      answerChat(machine, String(command.threadId), allowed ? "Allow" : "Deny");
      return { sequence: commandSequence };
    }
    case "thread.user-input.respond": {
      const answers = (command.answers ?? {}) as Record<string, unknown>;
      const first = Object.values(answers)[0];
      const text = Array.isArray(first) ? first.join(", ") : String(first ?? "OK");
      answerChat(machine, String(command.threadId), text);
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
        if (typeof command.titleSeed === "string" && target.title === "New chat")
          target.title = command.titleSeed;
        startTurn(target, message.messageId, message.text);
        touch(model);
        publishThread(machine, String(command.threadId));
        setTimeout(() => finishTurn(machine, String(command.threadId)), 2200);
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
export function answerChat(machine: DemoMachine, threadId: string, answer: string) {
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

export async function startDemo(): Promise<void> {
  seedLocalStorage();
  // Touch every fixture once so a typo in them fails loudly at start.
  void CHATS.length;
  void ago(0);
  const wsLink = ws.link(/^wss?:\/\/.*/);
  const worker = setupWorker(
    wsLink.addEventListener("connection", ({ client }) => {
      const machine = machineForHost(client.url.host);
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
    http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
    http.post("*/api/observability/v1/traces", () => new HttpResponse(null, { status: 204 })),
    http.get("*/api/self-update/status", () =>
      HttpResponse.json({ state: "idle", current: DEMO_VERSION, available: null }),
    ),
    http.get("*/api/health", () => HttpResponse.json({ ok: true, version: DEMO_VERSION })),
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
