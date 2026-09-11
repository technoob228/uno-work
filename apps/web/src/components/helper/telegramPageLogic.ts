/**
 * Pure mapping logic behind the Telegram page: status text from connector
 * health, allowed-chat rows joined with their bindings, the three-way
 * "what each chat talks to" select, and the local chat-label store. No React,
 * no I/O — everything here is unit tested.
 */
import type {
  ManagerAssistantSummary,
  ManagerConnectorBindingTarget,
  ManagerConnectorAddressingConfig,
  ManagerConnectorBindingView,
  ManagerConnectorHealthStatus,
  ManagerTelegramConnectorStatus,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";

import { helperCopy } from "./helperCopy";

// ---------------------------------------------------------------------------
// Harness / model picker
// ---------------------------------------------------------------------------

export const HARNESS_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "claudeAgent", label: "Claude" },
  { value: "uno", label: "Uno" },
  { value: "opencode", label: "OpenCode" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
  { value: "hermes", label: "Hermes" },
];

// ---------------------------------------------------------------------------
// Connector health → status
// ---------------------------------------------------------------------------

export const CONNECTOR_HEALTH_CHIP: Record<
  ManagerConnectorHealthStatus,
  { readonly label: string; readonly variant: "success" | "warning" | "error" }
> = {
  connected: { label: "Connected", variant: "success" },
  reconnecting: { label: "Reconnecting", variant: "warning" },
  auth_expired: { label: "Auth expired", variant: "error" },
  delivery_failed: { label: "Delivery failed", variant: "error" },
  provider_unavailable: { label: "Provider unavailable", variant: "warning" },
};

export type TelegramStatusTone = "muted" | "success" | "warning" | "error";

export interface TelegramStatus {
  readonly tone: TelegramStatusTone;
  readonly text: string;
}

/**
 * One line the owner reads at the top of the page. Health is what the daemon
 * last observed; `lastError` is the poller's in-memory error for problems
 * that are not provider health (invalid config, storage).
 */
export function describeTelegramStatus(
  telegram: ManagerTelegramConnectorStatus | null,
): TelegramStatus {
  if (telegram === null || !telegram.configured) {
    return { tone: "muted", text: helperCopy.status.notConnected };
  }
  if (!telegram.enabled) {
    return { tone: "muted", text: helperCopy.status.paused };
  }
  if (telegram.lastError !== null && telegram.health === null) {
    return { tone: "error", text: helperCopy.status.needsAttention(telegram.lastError) };
  }
  if (telegram.health === null) {
    return { tone: "warning", text: helperCopy.status.connecting };
  }
  if (telegram.health.status === "connected") {
    return { tone: "success", text: helperCopy.status.connectedAs(telegram.botUsername) };
  }
  const chip = CONNECTOR_HEALTH_CHIP[telegram.health.status];
  const detail =
    telegram.health.lastError !== null
      ? `${chip.label} — ${telegram.health.lastError}`
      : chip.label;
  return { tone: chip.variant, text: helperCopy.status.needsAttention(detail) };
}

// ---------------------------------------------------------------------------
// Which assistant is "the Helper"
// ---------------------------------------------------------------------------

/**
 * The Helper is one per account: the default assistant when it exists,
 * otherwise whichever one is listed first. Null means none exists yet and
 * the caller should create one silently.
 */
export function pickHelper(
  assistants: ReadonlyArray<ManagerAssistantSummary>,
): ManagerAssistantSummary | null {
  return (
    assistants.find((assistant) => assistant.projectId === ASSISTANT_PROJECT_ID) ??
    assistants[0] ??
    null
  );
}

// ---------------------------------------------------------------------------
// Chat ids
// ---------------------------------------------------------------------------

const TELEGRAM_CHAT_ID_PATTERN = /^-?\d+$/;

/** Telegram chat ids are integers (negative for groups). Null when the input is not one. */
export function parseTelegramChatId(raw: string): string | null {
  const trimmed = raw.trim();
  return TELEGRAM_CHAT_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** Comma/space/newline separated ids as typed into the advanced text fields. */
export function splitIdList(raw: string): ReadonlyArray<string> {
  return raw
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Comma/semicolon/newline separated names (names may contain spaces). */
export function splitNameList(raw: string): ReadonlyArray<string> {
  return raw
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function addChatId(
  allowedChatIds: ReadonlyArray<string>,
  chatId: string,
): ReadonlyArray<string> {
  return allowedChatIds.includes(chatId) ? allowedChatIds : [...allowedChatIds, chatId];
}

export function removeChatId(
  allowedChatIds: ReadonlyArray<string>,
  chatId: string,
): ReadonlyArray<string> {
  return allowedChatIds.filter((item) => item !== chatId);
}

// ---------------------------------------------------------------------------
// Allowed chat ↔ binding rows
// ---------------------------------------------------------------------------

export interface ChatRow {
  readonly chatId: string;
  /** Null = unbound, i.e. the chat talks to the Helper. */
  readonly binding: ManagerConnectorBindingView | null;
}

/** One row per allowed Telegram chat, in allowlist order, joined with its binding. */
export function buildChatRows(
  allowedChatIds: ReadonlyArray<string>,
  bindings: ReadonlyArray<ManagerConnectorBindingView>,
): ReadonlyArray<ChatRow> {
  const byChatId = new Map(
    bindings
      .filter((binding) => binding.kind === "telegram")
      .map((binding) => [binding.chatId, binding] as const),
  );
  return allowedChatIds.map((chatId) => ({ chatId, binding: byChatId.get(chatId) ?? null }));
}

// ---------------------------------------------------------------------------
// The "what each chat talks to" select
// ---------------------------------------------------------------------------

export type ChatRouteKind = "helper" | "project" | "thread";

export interface ChatRoute {
  readonly kind: ChatRouteKind;
  /** Chosen project (also the parent project when `kind` is "thread"). */
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
}

export const HELPER_ROUTE: ChatRoute = { kind: "helper", projectId: null, threadId: null };

export const CHAT_ROUTE_OPTIONS: ReadonlyArray<{
  readonly value: ChatRouteKind;
  readonly label: string;
}> = [
  { value: "helper", label: helperCopy.routing.optionHelper },
  { value: "project", label: helperCopy.routing.optionProject },
  { value: "thread", label: helperCopy.routing.optionThread },
];

/**
 * Binding → select state. A thread binding only carries the thread id, so
 * the parent project is looked up in the thread list the page already holds.
 */
export function routeFromBinding(
  binding: ManagerConnectorBindingView | null,
  projectOfThread: (threadId: ThreadId) => ProjectId | null,
): ChatRoute {
  if (binding === null) return HELPER_ROUTE;
  switch (binding.target.kind) {
    case "assistant":
      return HELPER_ROUTE;
    case "project":
      return { kind: "project", projectId: binding.target.projectId, threadId: null };
    case "thread":
      return {
        kind: "thread",
        projectId: projectOfThread(binding.target.threadId),
        threadId: binding.target.threadId,
      };
  }
}

/** Switching the select keeps whatever was already chosen that still applies. */
export function changeRouteKind(route: ChatRoute, kind: ChatRouteKind): ChatRoute {
  switch (kind) {
    case "helper":
      return HELPER_ROUTE;
    case "project":
      return { kind, projectId: route.projectId, threadId: null };
    case "thread":
      return { kind, projectId: route.projectId, threadId: null };
  }
}

export type BindingWrite =
  | { readonly action: "none" }
  | { readonly action: "remove" }
  | { readonly action: "upsert"; readonly target: ManagerConnectorBindingTarget };

/**
 * What to persist for a route. "Helper" is the absence of a binding, or an
 * explicit `assistant` binding kept only to carry `notifyOnComplete`; an
 * incomplete project/thread choice writes nothing until the picker is filled
 * in.
 */
export function planBindingWrite(route: ChatRoute, current: ChatRow["binding"]): BindingWrite {
  switch (route.kind) {
    case "helper":
      return current === null || current.target.kind === "assistant"
        ? { action: "none" }
        : { action: "remove" };
    case "project":
      if (route.projectId === null) return { action: "none" };
      if (current?.target.kind === "project" && current.target.projectId === route.projectId) {
        return { action: "none" };
      }
      return { action: "upsert", target: { kind: "project", projectId: route.projectId } };
    case "thread":
      if (route.threadId === null) return { action: "none" };
      if (current?.target.kind === "thread" && current.target.threadId === route.threadId) {
        return { action: "none" };
      }
      return { action: "upsert", target: { kind: "thread", threadId: route.threadId } };
  }
}

/**
 * Target to write when only "tell me when work finishes" changes: whatever
 * binding already exists, else an explicit Helper binding (the only way to
 * store the flag for an otherwise unbound chat). Null = nothing to attach to
 * yet (a project/thread picker still open).
 */
export function notifyBindingTarget(
  route: ChatRoute,
  current: ChatRow["binding"],
  helperProjectId: ProjectId,
): ManagerConnectorBindingTarget | null {
  if (current !== null) return current.target;
  return route.kind === "helper" ? { kind: "assistant", projectId: helperProjectId } : null;
}

// ---------------------------------------------------------------------------
// Chat labels (device-local; the daemon stores chat ids only)
// ---------------------------------------------------------------------------

export type ChatLabels = Readonly<Record<string, string>>;

export interface ChatLabelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const chatLabelsStorageKey = (environmentId: string): string =>
  `uno.helper.chatLabels.${environmentId}`;

export function readChatLabels(storage: ChatLabelStorage | null, key: string): ChatLabels {
  if (storage === null) return {};
  try {
    const raw = storage.getItem(key);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const labels: Record<string, string> = {};
    for (const [chatId, label] of Object.entries(parsed)) {
      if (typeof label === "string" && label.trim().length > 0) labels[chatId] = label.trim();
    }
    return labels;
  } catch {
    return {};
  }
}

export function withChatLabel(labels: ChatLabels, chatId: string, label: string): ChatLabels {
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    const { [chatId]: _removed, ...rest } = labels;
    return rest;
  }
  return { ...labels, [chatId]: trimmed };
}

export function writeChatLabels(
  storage: ChatLabelStorage | null,
  key: string,
  labels: ChatLabels,
): void {
  if (storage === null) return;
  try {
    storage.setItem(key, JSON.stringify(labels));
  } catch {
    // Quota or privacy mode: labels are a convenience, never a failure.
  }
}

/** "Me · 128841517" when labelled, otherwise the bare id. */
export function formatChatTitle(chatId: string, labels: ChatLabels): string {
  const label = labels[chatId];
  return label ? `${label} · ${chatId}` : chatId;
}

// ---------------------------------------------------------------------------
// Addressing form ↔ contract
// ---------------------------------------------------------------------------

export interface AddressingForm {
  readonly names: string;
  readonly requireMention: boolean;
  readonly smartWake: boolean;
  readonly hotWindowSec: string;
}

export function addressingFormFromConfig(config: ManagerConnectorAddressingConfig): AddressingForm {
  return {
    names: config.names.join(", "),
    requireMention: config.requireMentionInGroups,
    smartWake: config.smartWake,
    hotWindowSec: String(config.hotWindowSec),
  };
}

export function addressingConfigFromForm(form: AddressingForm): ManagerConnectorAddressingConfig {
  return {
    names: splitNameList(form.names),
    requireMentionInGroups: form.requireMention,
    smartWake: form.smartWake,
    hotWindowSec: Math.max(0, Math.trunc(Number(form.hotWindowSec) || 0)),
  };
}
