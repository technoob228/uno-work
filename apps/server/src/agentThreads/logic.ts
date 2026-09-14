/**
 * Pure helpers of the agent-threads bridge (`/api/threads*`): request
 * validation, status/author derivation, provider → model resolution.
 *
 * Kept free of services so the rules the harness agents rely on are
 * unit-testable in isolation; `service.ts` wires them to projections and the
 * orchestration engine.
 */
import {
  isProviderAvailable,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
  type ServerProvider,
  type ThreadController,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";

import { resolveModel } from "../provider/autoBootstrapModelSelection.ts";

export const AGENT_THREADS_PATH = "/api/threads";

export const AGENT_THREAD_MAX_TEXT_CHARS = 32_000;
export const AGENT_THREAD_MAX_TITLE_CHARS = 200;
export const AGENT_THREAD_DEFAULT_TITLE_CHARS = 60;
export const AGENT_THREAD_LAST_ASSISTANT_TEXT_CHARS = 500;
/** Per-message cap in `GET /api/threads/:id`; keeps 100 messages bounded. */
export const AGENT_THREAD_MESSAGE_TEXT_CHARS = 16_000;
export const AGENT_THREAD_DEFAULT_MESSAGE_LIMIT = 20;
export const AGENT_THREAD_MAX_MESSAGE_LIMIT = 100;
export const AGENT_THREAD_MAX_WAIT_MS = 600_000;

export const HUMAN_IN_CONTROL_MESSAGE =
  "Человек взял управление этим тредом. Не пиши в него, пока он не передаст управление обратно; читать можно.";

export type AgentThreadStatus = "idle" | "running" | "waiting" | "error";

export type AgentMessageAuthor = "you" | "human" | "assistant" | "system" | "user";

/** Result of a text-field check: the trimmed value or a user-facing error. */
export type TextCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string };

export function checkMessageText(raw: unknown): TextCheck {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, message: 'Поле "text" обязательно и не может быть пустым.' };
  }
  const value = raw.trim();
  if (value.length > AGENT_THREAD_MAX_TEXT_CHARS) {
    return {
      ok: false,
      message: `Поле "text" слишком длинное (${value.length} > ${AGENT_THREAD_MAX_TEXT_CHARS} символов).`,
    };
  }
  return { ok: true, value };
}

/** Optional non-empty string field; `undefined` when absent or blank. */
export function optionalString(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false } {
  const raw = body[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string" || raw.length > maxLength) return { ok: false };
  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : undefined };
}

/** First line of the text, collapsed and cut to ~60 chars. */
export function defaultTitleFromText(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= AGENT_THREAD_DEFAULT_TITLE_CHARS) {
    return singleLine.length > 0 ? singleLine : "Agent thread";
  }
  return `${singleLine.slice(0, AGENT_THREAD_DEFAULT_TITLE_CHARS - 1).trimEnd()}…`;
}

export function clampInteger(
  raw: string | null | undefined,
  input: { readonly fallback: number; readonly min: number; readonly max: number },
): number {
  if (raw === null || raw === undefined || raw.trim().length === 0) return input.fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return input.fallback;
  return Math.min(input.max, Math.max(input.min, Math.trunc(parsed)));
}

export function threadController(shell: Pick<OrchestrationThreadShell, "controller">) {
  return (shell.controller ?? "human") satisfies ThreadController;
}

/**
 * What the spawning agent needs to know about a child thread:
 * - `waiting` — a human (or the agent) must answer an approval / question;
 * - `running` — a turn is in flight, or a user message was sent and the
 *   session has not reacted yet (so a poll right after a send does not
 *   report `idle` before the harness even started);
 * - `error` — the session or the latest turn failed;
 * - `idle` — otherwise.
 *
 * Mirrors the sidebar pill order (approval → input → working) in the web app.
 */
export function deriveAgentThreadStatus(
  shell: Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "session" | "latestTurn" | "latestUserMessageAt"
  >,
): AgentThreadStatus {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return "waiting";
  const session = shell.session;
  if (session !== null && (session.status === "running" || session.status === "starting")) {
    return "running";
  }
  const sessionDead =
    session !== null && (session.status === "error" || session.status === "stopped");
  if (shell.latestTurn?.state === "running" && !sessionDead) return "running";
  const latestUserMessageAt = shell.latestUserMessageAt;
  if (
    latestUserMessageAt !== null &&
    (session === null || session.updatedAt < latestUserMessageAt)
  ) {
    return "running";
  }
  if (session?.status === "error" || shell.latestTurn?.state === "error") return "error";
  return "idle";
}

export function messageAuthor(
  message: Pick<OrchestrationMessage, "role" | "sentByThreadId">,
  callerThreadId: ThreadId,
): AgentMessageAuthor {
  if (message.role === "user") {
    const sentBy = message.sentByThreadId ?? null;
    if (sentBy === null) return "human";
    return sentBy === callerThreadId ? "you" : "user";
  }
  return message.role;
}

export function lastAssistantText(
  messages: ReadonlyArray<Pick<OrchestrationMessage, "role" | "text">>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === "assistant" && message.text.trim().length > 0) {
      return message.text.slice(0, AGENT_THREAD_LAST_ASSISTANT_TEXT_CHARS);
    }
  }
  return null;
}

export function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.length <= 1 ? trimmed : trimmed.replace(/[/\\]+$/g, "");
}

/** `cwd` points at the caller's own project (its root, worktree or a subfolder). */
export function isCwdInsideOwnProject(input: {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
}): boolean {
  const cwd = normalizeWorkspacePath(input.cwd);
  const roots = [input.workspaceRoot, input.worktreePath]
    .filter((root): root is string => root !== null && root.trim().length > 0)
    .map(normalizeWorkspacePath);
  return roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
}

// Friendly spellings an agent is likely to type for a driver.
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  claude: "claudeAgent",
  "claude-code": "claudeAgent",
  claudecode: "claudeAgent",
};

export type ProviderModelResolution =
  | { readonly ok: true; readonly selection: ModelSelection }
  | { readonly ok: false; readonly message: string };

function isRunnable(provider: ServerProvider): boolean {
  return provider.enabled && provider.installed && isProviderAvailable(provider);
}

/**
 * `provider` is a configured instance id (`codex_work`) or a driver kind
 * (`codex`, `claudeAgent`, …). An exact instance id wins (the default
 * instance of a driver has id === kind), then the first runnable instance of
 * that driver.
 * `model` goes through the driver's slug aliases; without it the driver's
 * canonical default (same pick as server-created projects) is used.
 */
export function resolveProviderModelSelection(input: {
  readonly provider: string;
  readonly model: string | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ProviderModelResolution {
  const candidates = [input.provider, PROVIDER_ALIASES[input.provider]].filter(
    (candidate): candidate is string => candidate !== undefined,
  );
  let instance: ServerProvider | undefined;
  for (const requested of candidates) {
    const byDriver = input.providers.filter((provider) => provider.driver === requested);
    instance =
      input.providers.find((provider) => provider.instanceId === requested) ??
      byDriver.find(isRunnable) ??
      byDriver[0];
    if (instance !== undefined) break;
  }
  if (instance === undefined) {
    const known = input.providers.filter(isRunnable).map((provider) => provider.instanceId);
    return {
      ok: false,
      message: `Неизвестный provider "${input.provider}". Доступны: ${
        known.length > 0 ? known.join(", ") : "нет ни одного установленного харнесса"
      }.`,
    };
  }
  if (!isRunnable(instance)) {
    return {
      ok: false,
      message: `Provider "${instance.instanceId}" не установлен или выключен на этой машине.`,
    };
  }
  const model =
    input.model !== undefined
      ? normalizeModelSlug(input.model, instance.driver)
      : resolveModel(instance);
  if (model === null) {
    return {
      ok: false,
      message: `У provider "${instance.instanceId}" нет модели по умолчанию — передай "model".`,
    };
  }
  return { ok: true, selection: { instanceId: instance.instanceId, model } };
}
