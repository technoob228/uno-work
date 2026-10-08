/**
 * Sidebar prototype (w0115, NOT FOR MERGE): the real web client with both
 * computers answered in the page by msw — HTTP through the service worker,
 * the daemon's WebSocket RPC by an in-page RPC server (the same harness the
 * browser tests use). Nothing leaves the browser.
 */
import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { HttpResponse, delay, http, ws } from "msw";
import { setupWorker } from "msw/browser";

import {
  BrowserWsRpcHarness,
  type NormalizedWsRpcRequestBody,
} from "./rpcHarness";
import {
  ENV_CLOUD,
  ENV_MAC,
  MACHINES,
  descriptorFor,
  inboxFor,
  readModelFor,
  serverConfigFor,
  threadForSubscription,
  toShellSnapshot,
  type ProtoMachine,
} from "./fixtures";

const SEED_VERSION = "w0115-sidebar-proto-4";

function seedLocalStorage() {
  if (localStorage.getItem("proto:seed") === SEED_VERSION) return;
  const keep = new Set(["proto:variant", "proto:mode"]);
  for (const key of Object.keys(localStorage)) {
    if (!keep.has(key)) localStorage.removeItem(key);
  }
  localStorage.setItem(
    "t3code:client-settings:v1",
    JSON.stringify({ ...DEFAULT_CLIENT_SETTINGS, onboardingCompleted: true }),
  );
  const mac = MACHINES[ENV_MAC]!;
  localStorage.setItem(
    "t3code:saved-environment-registry:v1",
    JSON.stringify({
      version: 1,
      records: [
        {
          environmentId: mac.environmentId,
          label: mac.label,
          httpBaseUrl: `https://${mac.host}/`,
          wsBaseUrl: `wss://${mac.host}/`,
          createdAt: new Date(Date.now() - 86_400_000 * 9).toISOString(),
          lastConnectedAt: new Date().toISOString(),
          bearerToken: "proto-bearer",
        },
      ],
    }),
  );
  localStorage.setItem("proto:seed", SEED_VERSION);
}

function machineForHost(host: string): ProtoMachine {
  const mac = MACHINES[ENV_MAC]!;
  return host === mac.host ? mac : MACHINES[ENV_CLOUD]!;
}

const models = new Map<string, ReturnType<typeof readModelFor>>();
function modelFor(machine: ProtoMachine) {
  let model = models.get(machine.environmentId);
  if (!model) {
    model = readModelFor(machine);
    models.set(machine.environmentId, model);
  }
  return model;
}

const unknownTags = new Set<string>();

function resolveUnary(machine: ProtoMachine, body: NormalizedWsRpcRequestBody): unknown {
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
      const projects = modelFor(machine).projects.filter((p) => p.title !== "Home folder");
      return {
        parentPath,
        entries:
          parentPath === `${machine.home}/`
            ? [
                { name: "projects", fullPath: `${machine.home}/projects`, kind: "directory" },
                { name: "Documents", fullPath: `${machine.home}/Documents`, kind: "directory" },
                { name: "Downloads", fullPath: `${machine.home}/Downloads`, kind: "directory" },
              ]
            : parentPath === `${machine.home}/projects/`
              ? projects.map((p) => ({ name: p.title, fullPath: p.workspaceRoot, kind: "directory" }))
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
        cpuPct: 7,
        cpuCount: machine.os === "darwin" ? 10 : 2,
        memUsedMb: 1900,
        memTotalMb: machine.os === "darwin" ? 16384 : 4096,
        diskUsedGb: 12,
        diskTotalGb: machine.os === "darwin" ? 512 : 60,
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
    case WS_METHODS.filesList:
      return filesListFor(machine, typeof body.path === "string" ? body.path : undefined);
    case ORCHESTRATION_WS_METHODS.dispatchCommand:
      return applyCommand(machine, body);
    default:
      if (!unknownTags.has(tag)) {
        unknownTags.add(tag);
        console.debug("[proto] unmocked rpc", tag);
      }
      return {};
  }
}

function initialStream(machine: ProtoMachine, request: NormalizedWsRpcRequestBody) {
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
      return [inboxFor(machine)];
    case ORCHESTRATION_WS_METHODS.subscribeShell:
      return [{ kind: "snapshot", snapshot: toShellSnapshot(model) }];
    case ORCHESTRATION_WS_METHODS.subscribeThread: {
      const thread = threadForSubscription(model, String(request.threadId));
      return thread
        ? [{ kind: "snapshot", snapshot: { snapshotSequence: model.snapshotSequence, thread } }]
        : [];
    }
    default:
      return [];
  }
}


function computerStateFor(machine: ProtoMachine) {
  const now = new Date().toISOString();
  return machine.machineKind === "uno_box"
    ? {
        linked: true,
        own: true,
        box: {
          id: 2401,
          name: machine.label,
          status: "running",
          os: "Ubuntu 24.04",
          ramMb: 4096,
          vcpu: 2,
          diskGb: 60,
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

function workspaceState() {
  const at = new Date(Date.now() - 86_400_000 * 9).toISOString();
  return {
    identity: {
      workspaceId: "ws-proto",
      name: "Anna's workspace",
      epoch: 1,
      registryEnvironmentId: ENV_CLOUD,
      unoAccountId: 85,
      createdAt: at,
      updatedAt: at,
    },
    machines: Object.values(MACHINES).map((machine, index) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      monogram: machine.label.slice(0, 1),
      colorSlot: index,
      kind: machine.machineKind === "uno_box" ? "uno_box" : "local",
      unoBoxId: machine.machineKind === "uno_box" ? 2401 : null,
      scope: "full",
      repositories: [],
      addedAt: at,
      lastSeenAt: new Date().toISOString(),
    })),
  };
}

function filesListFor(machine: ProtoMachine, path: string | undefined) {
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
  const file = (name: string, base: string, size: number) => ({
    ...folder(name, base),
    kind: "file",
    size,
  });
  const current = path && path !== "~" ? path.replace(/^~/, root) : root;
  const projects = modelFor(machine).projects.filter((p) => p.workspaceRoot !== root);
  const entries =
    current === root
      ? [
          folder("projects", root),
          folder("Documents", root),
          folder("Downloads", root),
          file(machine.os === "darwin" ? "invoice-maria.pdf" : "autumn-prices.pdf", root, 48_210),
        ]
      : current === `${root}/projects`
        ? projects.map((p) => folder(p.title, `${root}/projects`))
        : [];
  return {
    path: current,
    rootPath: root,
    parentPath: current === root ? null : current.replace(/\/[^/]+$/, ""),
    entries,
  };
}

let commandSequence = 100;

/** The daemon's side of a few commands, enough for clicking around: Done, Snooze, new project, new chat. */
function applyCommand(machine: ProtoMachine, command: NormalizedWsRpcRequestBody) {
  const model = modelFor(machine) as unknown as {
    snapshotSequence: number;
    projects: Array<Record<string, unknown>>;
    threads: Array<Record<string, unknown>>;
  };
  const now = new Date().toISOString();
  const thread = model.threads.find((t) => t.id === command.threadId);
  const touch = () => {
    model.snapshotSequence += 1;
    commandSequence += 1;
  };
  switch (command.type) {
    case "thread.settle":
      if (thread) Object.assign(thread, { settledOverride: "settled", settledAt: now });
      break;
    case "thread.unsettle":
      if (thread) Object.assign(thread, { settledOverride: "active", settledAt: null });
      break;
    case "thread.snooze":
      if (thread)
        Object.assign(thread, { snoozedUntil: command.snoozedUntil, snoozedAt: now, _state: "snoozed" });
      break;
    case "thread.unsnooze":
      if (thread) Object.assign(thread, { snoozedUntil: null, snoozedAt: null, _state: null });
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
        if (command.pinnedAt !== undefined) thread.pinnedAt = command.pinnedAt;
      }
      break;
    case "thread.delete":
      if (thread) Object.assign(thread, { deletedAt: now });
      break;
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
      touch();
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
          _machine: machine.environmentId,
          _state: null,
        };
        model.threads.unshift(target);
      }
      if (target && command.type === "thread.turn.start") {
        const message = command.message as { messageId: string; text: string };
        const turnId = `turn-${String(command.threadId)}-${commandSequence}`;
        (target.messages as unknown[]).push({
          id: message.messageId,
          role: "user",
          text: message.text,
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        });
        if (typeof command.titleSeed === "string" && target.title === "New chat")
          target.title = command.titleSeed;
        Object.assign(target, {
          updatedAt: now,
          settledOverride: null,
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
      break;
    }
    default:
      return { sequence: commandSequence };
  }
  touch();
  publishThread(machine, String(command.threadId));
  if (command.type === "thread.turn.start") {
    // A calm made-up answer, so a new chat doesn't think forever.
    setTimeout(() => finishTurn(machine, String(command.threadId)), 2200);
  }
  return { sequence: commandSequence };
}

function publishThread(machine: ProtoMachine, threadId: string) {
  const model = modelFor(machine) as unknown as {
    snapshotSequence: number;
    threads: Array<Record<string, unknown>>;
  };
  const changed = model.threads.find((t) => t.id === threadId);
  if (!changed) return;
  const shell = toShellSnapshot(model as never).threads.find((t) => t.id === changed.id);
  if (changed.deletedAt) {
    emitShell(machine, { kind: "thread-removed", sequence: model.snapshotSequence, threadId });
    return;
  }
  if (shell) {
    emitShell(machine, { kind: "thread-upserted", sequence: model.snapshotSequence, thread: shell });
  }
  const detail = threadForSubscription(model as never, threadId);
  const harness = harnesses.get(machine.environmentId);
  // Every open chat view re-syncs the chat named in the snapshot — harmless for the others.
  setTimeout(
    () =>
      harness?.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
        kind: "snapshot",
        snapshot: { snapshotSequence: model.snapshotSequence, thread: detail },
      }),
    40,
  );
}

function finishTurn(machine: ProtoMachine, threadId: string) {
  const model = modelFor(machine) as unknown as {
    snapshotSequence: number;
    threads: Array<Record<string, unknown>>;
  };
  const thread = model.threads.find((t) => t.id === threadId);
  if (!thread) return;
  const now = new Date().toISOString();
  const turn = thread.latestTurn as { turnId: string } | null;
  const messageId = `${threadId}-reply-${Date.now()}`;
  (thread.messages as unknown[]).push({
    id: messageId,
    role: "assistant",
    text: "Got it — I'm on it. (This is a prototype with made-up data: nothing really runs here.)",
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
  model.snapshotSequence += 1;
  publishThread(machine, threadId);
}

function emitShell(machine: ProtoMachine, event: unknown) {
  const harness = harnesses.get(machine.environmentId);
  // After the answer to the command, like the daemon.
  setTimeout(() => harness?.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, event), 30);
}

const harnesses = new Map<string, BrowserWsRpcHarness>();
async function harnessFor(machine: ProtoMachine) {
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

const sessionJson = (machine: ProtoMachine) => ({
  authenticated: true,
  auth: serverConfigFor(machine).auth,
  role: "owner",
  sessionMethod: "browser-session-cookie",
  expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString(),
});

export async function startProto(): Promise<void> {
  seedLocalStorage();
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
      // "Use this computer" probes a desktop app on 127.0.0.1 — there is none here:
      // never answer, the probe gives up on its own timeout without a console error.
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
        token: "proto-ws-token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ),
    http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
    http.post("*/api/observability/v1/traces", () => new HttpResponse(null, { status: 204 })),
    http.get("*/api/self-update/status", () =>
      HttpResponse.json({ state: "idle", current: "0.0.114", available: null }),
    ),
    http.get("*/api/health", () => HttpResponse.json({ ok: true, version: "0.0.114" })),
  );
  await worker.start({
    onUnhandledRequest(request) {
      const url = new URL(request.url);
      if (url.origin === location.origin && !url.pathname.startsWith("/api")) return;
      console.debug("[proto] unmocked http", request.method, request.url);
    },
    quiet: true,
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
  });
}
