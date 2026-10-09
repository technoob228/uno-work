/**
 * Chats on ANOTHER computer of the same Uno account (icp3, 09.10).
 *
 * An agent on computer A (or an outside agent holding the account key) starts
 * a chat in Uno Work on computer B and keeps talking to it. Nothing new is
 * needed on B or in the console — the path is the one the person's browser
 * already takes when it adds a computer:
 *
 *   1. console `POST /api/v1/boxes/{B}/work/session` with A's account key →
 *      a one-time owner pairing link to B's daemon (the console wakes B and
 *      writes the session into B's Security journal);
 *   2. B `POST /oauth/token` — the link's credential → a bearer session,
 *      labelled "Agent on <A>" in B's list of signed-in devices;
 *   3. B `GET /api/orchestration/shell` — projects and chats;
 *      B `POST /api/orchestration/dispatch` — `thread.create`, then
 *      `thread.turn.start`: what the composer does for a new chat;
 *      B `GET /api/orchestration/threads/:id` — the messages.
 *
 * Every request goes to B's public address over HTTPS; the account key only
 * ever goes to the console. A chat started this way says who started it in
 * its first message (B's contract has no other place for it).
 *
 * Plain promises with injected `fetch`/`sleep`/`now`, so the same code runs
 * inside the daemon (agent bridge) and in the `t3 chat` CLI, and the rules
 * are unit-tested without a network.
 *
 * @module crossComputer/remoteWork
 */
import type {
  ModelSelection,
  OrchestrationMessage,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  RuntimeMode,
  UnoBox,
} from "@t3tools/contracts";
import { parseUnoBoxConnection, retryWhileWorkMachineStarts } from "@t3tools/shared/unoCloud";

import {
  AGENTS_CLOSED_MESSAGE,
  AGENT_THREAD_DEFAULT_TITLE_CHARS,
  HUMAN_ACTIVE_MESSAGE,
  TARGET_BUSY_MESSAGE,
  deriveAgentThreadStatus,
  isClosedToAgents,
  type AgentThreadStatus,
} from "../agentThreads/logic.ts";
import { isRuntimeModeWider } from "../orchestration/projectThreadModes.ts";

/** Project id of the assistant's own workspace on every computer. */
const ASSISTANT_PROJECT_ID = "assistant-home";

/** A failure with an HTTP status and a machine-readable code for the bridge reply. */
export class RemoteWorkError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RemoteWorkError";
    this.status = status;
    this.code = code;
  }
}

export interface RemoteWorkDeps {
  readonly fetch: typeof fetch;
  /** A console call with the account key (`fetchControlPlaneJson`). */
  readonly controlPlane: (path: string, init?: RequestInit) => Promise<unknown>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export interface RemoteWorkSession {
  readonly boxId: number;
  /** `https://<box host>` of B's Uno Work. */
  readonly baseUrl: string;
  readonly token: string;
  readonly expiresAtMs: number;
}

// ── Which computer ───────────────────────────────────────────────────────

/**
 * `computerId` / `--computer` as given: a box id (`2575`, `"box-2575"`) or a
 * computer name as the console shows it (case-insensitive). Only computers of
 * the account behind the key are candidates — the console returns no others.
 */
export function resolveComputer(
  boxes: ReadonlyArray<Pick<UnoBox, "id" | "name" | "status">>,
  raw: string | number,
): UnoBoxRef {
  const value = typeof raw === "number" ? String(raw) : raw.trim();
  const id = /^(?:box-)?(\d+)$/i.exec(value)?.[1];
  if (id !== undefined) {
    const box = boxes.find((candidate) => candidate.id === Number(id));
    if (box) return box;
  }
  const named = boxes.filter((box) => box.name.trim().toLowerCase() === value.toLowerCase());
  if (named.length === 1) return named[0]!;
  const names = boxes.map((box) => `${box.name} (${box.id})`).join(", ");
  if (named.length > 1) {
    throw new RemoteWorkError(
      409,
      "computer_ambiguous",
      `Several computers are called "${value}": ${names}. Pass the number instead.`,
    );
  }
  throw new RemoteWorkError(
    404,
    "computer_not_found",
    names.length > 0
      ? `No computer "${value}" in this Uno account. Its computers: ${names}.`
      : `No computer "${value}": this Uno account has no computers.`,
  );
}

export type UnoBoxRef = Pick<UnoBox, "id" | "name" | "status">;

// ── Session ──────────────────────────────────────────────────────────────

/** How long to keep retrying while B's address does not answer yet (fresh/woken box). */
const UNREACHABLE_BUDGET_MS = 90_000;
const UNREACHABLE_RETRY_MS = 3_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Drop a cached session this long before it expires. */
const SESSION_EXPIRY_MARGIN_MS = 60_000;

const isTransientStatus = (status: number) => status === 502 || status === 503 || status === 504;

function pairingTarget(url: string): { readonly origin: string; readonly credential: string } {
  const parsed = new URL(url);
  const credential =
    new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token")?.trim() ||
    parsed.searchParams.get("token")?.trim() ||
    "";
  if (credential.length === 0) {
    throw new RemoteWorkError(502, "pairing_failed", "The console's link has no pairing token.");
  }
  return { origin: parsed.origin, credential };
}

/**
 * A fresh owner session on B's Uno Work. Wakes B (the console does), waits
 * while it starts, and labels the session so the person sees it in B's
 * signed-in devices.
 */
export async function openRemoteSession(
  deps: RemoteWorkDeps,
  input: { readonly boxId: number; readonly clientLabel: string },
): Promise<RemoteWorkSession> {
  const deadline = deps.now() + UNREACHABLE_BUDGET_MS;
  let lastProblem = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let raw: unknown;
    try {
      raw = await retryWhileWorkMachineStarts(
        () =>
          deps.controlPlane(`/api/v1/boxes/${input.boxId}/work/session`, {
            method: "POST",
            body: "{}",
          }),
        { sleep: deps.sleep, now: deps.now },
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/ACCOUNT_SCOPE_REQUIRED/.test(message)) {
        throw new RemoteWorkError(
          403,
          "account_key_required",
          "This is a connected agent key: opening Uno Work on a computer needs the account api_key, or an agent in Uno Work on one of the account's computers. Tell the person; don't try other ways.",
        );
      }
      if (/\b403\b/.test(message)) {
        throw new RemoteWorkError(
          403,
          "computer_not_allowed",
          `Uno did not let this key open computer ${input.boxId} (${message}). On a cloud computer the person allows it in Settings → Computer access → "Add new computers" (it also covers connecting to their other computers).`,
        );
      }
      throw new RemoteWorkError(502, "computer_unreachable", message);
    }
    const connection = parseUnoBoxConnection(raw, input.boxId);
    if (!connection) {
      throw new RemoteWorkError(502, "pairing_failed", "The console returned no pairing link.");
    }
    const target = pairingTarget(connection.url);
    // The credential is single-use: a network error before the daemon saw it
    // leaves it valid, so the same one is retried while B's address warms up.
    for (;;) {
      let response: Response | null = null;
      try {
        response = await deps.fetch(`${target.origin}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            subject_token: target.credential,
            client_label: input.clientLabel.slice(0, 120),
          }).toString(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        lastProblem = cause instanceof Error ? cause.message : String(cause);
      }
      if (response !== null && response.ok) {
        const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
        if (typeof body.access_token !== "string" || body.access_token.length === 0) {
          throw new RemoteWorkError(502, "pairing_failed", "The computer returned no session.");
        }
        const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
        return {
          boxId: input.boxId,
          baseUrl: target.origin,
          token: body.access_token,
          expiresAtMs: deps.now() + expiresIn * 1000,
        };
      }
      if (response !== null && !isTransientStatus(response.status)) {
        lastProblem = `HTTP ${response.status}`;
        break; // used up or expired: mint a fresh link
      }
      if (response !== null) lastProblem = `HTTP ${response.status}`;
      if (deps.now() + UNREACHABLE_RETRY_MS > deadline) {
        throw new RemoteWorkError(
          504,
          "computer_starting",
          `Computer ${input.boxId} is still starting (${lastProblem}). Try again in a minute.`,
        );
      }
      await deps.sleep(UNREACHABLE_RETRY_MS);
    }
  }
  throw new RemoteWorkError(
    502,
    "pairing_failed",
    `Could not sign in to computer ${input.boxId} (${lastProblem}).`,
  );
}

/**
 * Sessions by (key owner, box): one sign-in per computer instead of one per
 * request — each sign-in is a new device on B and a line in its journal.
 */
export class RemoteSessionCache {
  private readonly sessions = new Map<string, RemoteWorkSession>();
  private readonly options: {
    readonly load?: (key: string) => RemoteWorkSession | null;
    readonly save?: (key: string, session: RemoteWorkSession | null) => void;
  };

  constructor(
    options: {
      readonly load?: (key: string) => RemoteWorkSession | null;
      readonly save?: (key: string, session: RemoteWorkSession | null) => void;
    } = {},
  ) {
    this.options = options;
  }

  async get(
    key: string,
    now: number,
    open: () => Promise<RemoteWorkSession>,
  ): Promise<RemoteWorkSession> {
    const cached = this.sessions.get(key) ?? this.options.load?.(key) ?? null;
    if (cached !== null && cached.expiresAtMs - SESSION_EXPIRY_MARGIN_MS > now) {
      this.sessions.set(key, cached);
      return cached;
    }
    const fresh = await open();
    this.sessions.set(key, fresh);
    this.options.save?.(key, fresh);
    return fresh;
  }

  drop(key: string): void {
    this.sessions.delete(key);
    this.options.save?.(key, null);
  }
}

/** One JSON request to B with the session. 401 → `session_expired` (the caller re-signs in). */
export async function remoteRequest<T>(
  deps: Pick<RemoteWorkDeps, "fetch">,
  session: RemoteWorkSession,
  input: { readonly method: "GET" | "POST"; readonly path: string; readonly body?: unknown },
): Promise<T> {
  let response: Response;
  try {
    response = await deps.fetch(`${session.baseUrl}${input.path}`, {
      method: input.method,
      headers: {
        authorization: `Bearer ${session.token}`,
        accept: "application/json",
        ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new RemoteWorkError(
      504,
      "computer_unreachable",
      `Computer ${session.boxId} did not answer (${cause instanceof Error ? cause.message : String(cause)}).`,
    );
  }
  if (response.status === 401) {
    throw new RemoteWorkError(401, "session_expired", "The session on that computer expired.");
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new RemoteWorkError(
      response.status === 404 ? 404 : 502,
      response.status === 404 ? "thread_not_found" : "remote_error",
      `Computer ${session.boxId} answered ${response.status}${detail ? `: ${detail}` : ""}.`,
    );
  }
  return (await response.json()) as T;
}

// ── Thread ids ───────────────────────────────────────────────────────────

/**
 * A chat on another computer is addressed as `box-<id>:<threadId>`: the agent
 * passes it back to `chat_status` / `chat_message` as is, and the bridge
 * knows where to go without remembering anything.
 */
export function formatRemoteThreadId(boxId: number, threadId: string): string {
  return `box-${boxId}:${threadId}`;
}

export function parseRemoteThreadId(
  raw: string | null | undefined,
): { readonly boxId: number; readonly threadId: string } | null {
  let value = (raw ?? "").trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  const match = /^box-(\d+):([A-Za-z0-9_-]{1,200})$/.exec(value);
  return match ? { boxId: Number(match[1]), threadId: match[2]! } : null;
}

// ── What goes where on B ─────────────────────────────────────────────────

/** `~/x` and `/home/<u>/x` name the same folder; B's home is not known here. */
function sameFolder(workspaceRoot: string, folder: string): boolean {
  const root = workspaceRoot.replace(/\/+$/, "");
  const wanted = folder.trim().replace(/\/+$/, "");
  if (wanted.startsWith("~/")) {
    const tail = wanted.slice(1);
    return /^\/(?:home\/[^/]+|root|Users\/[^/]+)$/.test(root.slice(0, root.length - tail.length))
      ? root.endsWith(tail)
      : false;
  }
  if (wanted === "~") return /^\/(?:home\/[^/]+|root|Users\/[^/]+)$/.test(root);
  return root === wanted;
}

const isAssistantProject = (project: Pick<OrchestrationProjectShell, "id">) =>
  project.id === ASSISTANT_PROJECT_ID;

/**
 * The project the chat goes into: the one at `folder`, else (no folder) the
 * project the person used last on B, else `~/projects` — created when absent.
 */
export function chooseRemoteProject(
  shell: Pick<OrchestrationShellSnapshot, "projects" | "threads">,
  folder: string | undefined,
): { readonly project: OrchestrationProjectShell } | { readonly create: string } {
  const projects = shell.projects.filter((project) => !isAssistantProject(project));
  if (folder !== undefined && folder.trim().length > 0) {
    const found = projects.find((project) => sameFolder(project.workspaceRoot, folder));
    return found ? { project: found } : { create: folder.trim() };
  }
  const lastUsed = shell.threads
    .filter((thread) => thread.archivedAt === null)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((thread) => projects.find((project) => project.id === thread.projectId))
    .find((project) => project !== undefined);
  if (lastUsed) return { project: lastUsed };
  const newest = projects.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return newest[0] ? { project: newest[0] } : { create: "~/projects" };
}

/**
 * The AI the chat runs with on B, as B would pick it without asking: the
 * project's own default, else what the person used last on B, else the AI of
 * B's Uno chat (the machine's built-in Uno AI). A `model` from the caller
 * keeps that harness and only changes the model.
 */
export function chooseRemoteModel(
  shell: Pick<OrchestrationShellSnapshot, "threads">,
  project: Pick<OrchestrationProjectShell, "defaultModelSelection"> | null,
  model: string | undefined,
): ModelSelection {
  const threads = shell.threads
    .filter((thread) => thread.archivedAt === null)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const base =
    project?.defaultModelSelection ??
    threads.find((thread) => (thread.assistantRole ?? null) === null)?.modelSelection ??
    threads.find((thread) => thread.assistantRole === "chat")?.modelSelection ??
    null;
  if (base === null) {
    throw new RemoteWorkError(
      400,
      "model_required",
      "That computer has no AI set up yet. Open Uno Work there once, or pass a model.",
    );
  }
  return model !== undefined && model.trim().length > 0
    ? { instanceId: base.instanceId, model: model.trim() }
    : base;
}

// ── Labels in the chat on B ──────────────────────────────────────────────

/**
 * First line of every message an agent sends to another computer, e.g.
 * `[Started by the agent on uno-work · chat “Coordinator”]`. `from` names the
 * sender as a whole ("the agent on uno-work", "Claude Code on Misha's Mac").
 */
export function remoteMessageHeader(input: {
  readonly from: string;
  readonly chatTitle?: string | null;
  readonly first: boolean;
}): string {
  const chat = input.chatTitle ? ` · chat “${input.chatTitle.slice(0, 80)}”` : "";
  return `[${input.first ? "Started" : "Sent"} by ${input.from}${chat}]`;
}

const HEADER_PATTERN = /^\[(?:Started|Sent) by (.+?)(?: · chat “.*”)?\]\n/;

function titleFromText(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= AGENT_THREAD_DEFAULT_TITLE_CHARS
    ? line || "Agent chat"
    : `${line.slice(0, AGENT_THREAD_DEFAULT_TITLE_CHARS - 1).trimEnd()}…`;
}

// ── Start, read, send ────────────────────────────────────────────────────

export interface RemoteStartInput {
  readonly text: string;
  readonly title?: string | undefined;
  readonly folder?: string | undefined;
  readonly model?: string | undefined;
  /** Who it is from, as a whole: "the agent on uno-work", "Claude Code on Misha's Mac". */
  readonly from: string;
  readonly fromChatTitle?: string | null;
  /** The chat never gets more rights than this (the calling agent's own mode). */
  readonly runtimeMode: RuntimeMode;
}

export interface RemoteStartResult {
  readonly threadId: string;
  readonly projectId: string;
  readonly folder: string;
  readonly title: string;
  readonly environmentId: string | null;
}

const newId = () => crypto.randomUUID();

export async function startRemoteChat(
  deps: Pick<RemoteWorkDeps, "fetch" | "now">,
  session: RemoteWorkSession,
  input: RemoteStartInput,
): Promise<RemoteStartResult> {
  const shell = await remoteRequest<OrchestrationShellSnapshot>(deps, session, {
    method: "GET",
    path: "/api/orchestration/shell",
  });
  const choice = chooseRemoteProject(shell, input.folder);
  let project: Pick<
    OrchestrationProjectShell,
    "id" | "workspaceRoot" | "defaultModelSelection"
  > | null = "project" in choice ? choice.project : null;
  const modelSelection = chooseRemoteModel(shell, project, input.model);
  const createdAt = new Date(deps.now()).toISOString();

  if (project === null && "create" in choice) {
    const projectId = newId();
    const folderName = choice.create.replace(/\/+$/, "").split("/").pop() || "project";
    await remoteRequest(deps, session, {
      method: "POST",
      path: "/api/orchestration/dispatch",
      body: {
        type: "project.create",
        commandId: newId(),
        projectId,
        title: folderName === "~" ? "Home" : folderName,
        workspaceRoot: choice.create,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: modelSelection,
        createdAt,
      },
    });
    const after = await remoteRequest<OrchestrationShellSnapshot>(deps, session, {
      method: "GET",
      path: "/api/orchestration/shell",
    });
    project = after.projects.find((candidate) => candidate.id === projectId) ?? null;
    if (project === null) {
      throw new RemoteWorkError(
        502,
        "project_not_created",
        `Could not add ${choice.create} as a project on computer ${session.boxId}.`,
      );
    }
  }
  if (project === null) {
    throw new RemoteWorkError(502, "project_not_created", "No project to start the chat in.");
  }

  const threadId = newId();
  const title = (input.title?.trim() || titleFromText(input.text)).slice(0, 200);
  const text = `${remoteMessageHeader({ from: input.from, chatTitle: input.fromChatTitle ?? null, first: true })}\n${input.text}`;
  // Two plain commands, not `bootstrap.createThread`: the bootstrap is
  // handled by B's WebSocket RPC only, `POST /api/orchestration/dispatch`
  // rejects it.
  await remoteRequest(deps, session, {
    method: "POST",
    path: "/api/orchestration/dispatch",
    body: {
      type: "thread.create",
      commandId: newId(),
      threadId,
      projectId: project.id,
      title,
      modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    },
  });
  await remoteRequest(deps, session, {
    method: "POST",
    path: "/api/orchestration/dispatch",
    body: {
      type: "thread.turn.start",
      commandId: newId(),
      threadId,
      message: { messageId: newId(), role: "user", text, attachments: [] },
      modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: "default",
      createdAt,
    },
  });
  const environment = await deps
    .fetch(`${session.baseUrl}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  const environmentId =
    typeof (environment as { environmentId?: unknown } | null)?.environmentId === "string"
      ? (environment as { environmentId: string }).environmentId
      : null;
  return { threadId, projectId: project.id, folder: project.workspaceRoot, title, environmentId };
}

export interface RemoteChatView {
  readonly title: string;
  readonly folder: string | null;
  readonly status: AgentThreadStatus;
  readonly agentsClosed: boolean;
  readonly pendingApproval: boolean;
  readonly pendingUserInput: boolean;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly author: "agent" | "human" | "assistant" | "system";
    readonly from?: string;
    readonly text: string;
    readonly createdAt: string;
    readonly truncated?: true;
  }>;
}

const MESSAGE_TEXT_CHARS = 16_000;

async function loadThreadShell(
  deps: Pick<RemoteWorkDeps, "fetch">,
  session: RemoteWorkSession,
  threadId: string,
): Promise<{ thread: OrchestrationThreadShell; project: OrchestrationProjectShell | null }> {
  const shell = await remoteRequest<OrchestrationShellSnapshot>(deps, session, {
    method: "GET",
    path: "/api/orchestration/shell",
  });
  const thread = shell.threads.find((candidate) => candidate.id === threadId);
  if (!thread || thread.archivedAt !== null) {
    throw new RemoteWorkError(404, "thread_not_found", "No such chat on that computer.");
  }
  return {
    thread,
    project: shell.projects.find((project) => project.id === thread.projectId) ?? null,
  };
}

/** Status and last messages; `waitMs` holds the call while the chat is running. */
export async function readRemoteChat(
  deps: Pick<RemoteWorkDeps, "fetch" | "sleep" | "now">,
  session: RemoteWorkSession,
  threadId: string,
  input: { readonly limit: number; readonly waitMs: number; readonly pollMs?: number },
): Promise<RemoteChatView> {
  const deadline = deps.now() + input.waitMs;
  let { thread, project } = await loadThreadShell(deps, session, threadId);
  while (deriveAgentThreadStatus(thread) === "running" && deps.now() < deadline) {
    await deps.sleep(Math.max(1, Math.min(input.pollMs ?? 2_000, deadline - deps.now())));
    ({ thread, project } = await loadThreadShell(deps, session, threadId));
  }
  const detail = await remoteRequest<{
    thread?: { messages?: ReadonlyArray<OrchestrationMessage> };
  }>(deps, session, { method: "GET", path: `/api/orchestration/threads/${threadId}` });
  const messages = (detail.thread?.messages ?? []).slice(-input.limit);
  return {
    title: thread.title,
    folder: project?.workspaceRoot ?? null,
    status: deriveAgentThreadStatus(thread),
    agentsClosed: isClosedToAgents(thread),
    pendingApproval: thread.hasPendingApprovals,
    pendingUserInput: thread.hasPendingUserInput,
    messages: messages.map((message) => {
      const header = message.role === "user" ? HEADER_PATTERN.exec(message.text) : null;
      const body = header ? message.text.slice(header[0].length) : message.text;
      return {
        role: message.role,
        author: message.role === "user" ? (header ? "agent" : "human") : message.role,
        ...(header ? { from: header[1]! } : {}),
        text: body.slice(0, MESSAGE_TEXT_CHARS),
        createdAt: message.createdAt,
        ...(body.length > MESSAGE_TEXT_CHARS ? { truncated: true as const } : {}),
      };
    }),
  };
}

/**
 * The next message into a chat on B — the same rules as between chats on one
 * computer: never into a chat the person closed to agents or where they are
 * being asked something; a busy chat is waited out up to `waitMs`; never a
 * turn with more rights than the sender has.
 */
export async function sendRemoteMessage(
  deps: Pick<RemoteWorkDeps, "fetch" | "sleep" | "now">,
  session: RemoteWorkSession,
  threadId: string,
  input: {
    readonly text: string;
    readonly waitMs: number;
    readonly from: string;
    readonly fromChatTitle?: string | null;
    readonly runtimeMode: RuntimeMode;
    readonly pollMs?: number;
  },
): Promise<void> {
  const deadline = deps.now() + input.waitMs;
  let { thread } = await loadThreadShell(deps, session, threadId);
  for (;;) {
    if (isClosedToAgents(thread))
      throw new RemoteWorkError(409, "agents_closed", AGENTS_CLOSED_MESSAGE);
    const status = deriveAgentThreadStatus(thread);
    if (status === "waiting") throw new RemoteWorkError(409, "human_active", HUMAN_ACTIVE_MESSAGE);
    if (status !== "running") break;
    if (deps.now() >= deadline) throw new RemoteWorkError(409, "target_busy", TARGET_BUSY_MESSAGE);
    await deps.sleep(Math.max(1, Math.min(input.pollMs ?? 2_000, deadline - deps.now())));
    ({ thread } = await loadThreadShell(deps, session, threadId));
  }
  if (isRuntimeModeWider(thread.runtimeMode, input.runtimeMode)) {
    throw new RemoteWorkError(
      403,
      "runtime_mode_escalation",
      `That chat runs in "${thread.runtimeMode}", wider than yours ("${input.runtimeMode}"). Only the person can write there.`,
    );
  }
  const header = remoteMessageHeader({
    from: input.from,
    chatTitle: input.fromChatTitle ?? null,
    first: false,
  });
  await remoteRequest(deps, session, {
    method: "POST",
    path: "/api/orchestration/dispatch",
    body: {
      type: "thread.turn.start",
      commandId: newId(),
      threadId,
      message: {
        messageId: newId(),
        role: "user",
        text: `${header}\n${input.text}`,
        attachments: [],
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: new Date(deps.now()).toISOString(),
    },
  });
}

/** Runs `call` with a cached session; on `session_expired` signs in again once. */
export async function withRemoteSession<T>(
  cache: RemoteSessionCache,
  key: string,
  deps: Pick<RemoteWorkDeps, "now">,
  open: () => Promise<RemoteWorkSession>,
  call: (session: RemoteWorkSession) => Promise<T>,
): Promise<T> {
  const session = await cache.get(key, deps.now(), open);
  try {
    return await call(session);
  } catch (error) {
    if (!(error instanceof RemoteWorkError) || error.code !== "session_expired") throw error;
    cache.drop(key);
    return call(await cache.get(key, deps.now(), open));
  }
}

/** Where the person opens that chat: B's own Uno Work address. */
export function remoteChatUrl(
  session: RemoteWorkSession,
  environmentId: string | null,
  threadId: string,
) {
  return environmentId ? `${session.baseUrl}/${environmentId}/${threadId}` : session.baseUrl;
}
