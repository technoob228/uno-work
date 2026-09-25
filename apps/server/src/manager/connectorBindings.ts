/**
 * Chat → target bindings: the pure decisions behind ADR 2026-09-11 ("a chat
 * connector is a transport, not a conversation partner").
 *
 * - {@link effectiveBindingTarget}: what a chat talks to when it has no
 *   binding row (the assistant of the connector that carries it).
 * - {@link decideThreadRouting}: which thread an inbound message lands in
 *   for each target kind, and with which runtime mode.
 * - {@link matchByTitleOrId}: the fuzzy lookup behind `/use` and `/thread`.
 * - {@link resolveNotifyChats}: which chats an outbound notification about a
 *   thread / project goes to.
 *
 * No I/O here; the Telegram connector and the notify service feed these
 * with what they read and act on the result.
 */
import {
  ASSISTANT_PROJECT_ID,
  isAssistantProjectId,
  type ManagerConnectorBinding,
  type ManagerConnectorBindingKind,
  type ManagerConnectorBindingTarget,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { readAssistantLlmProvider } from "@t3tools/shared/assistantLlm";

/**
 * Runtime mode of assistant chat threads. The assistant is the owner's own
 * agent running in its own workspace, so its Telegram threads run without
 * approval prompts (a chat has no approval UI). Targets other than the
 * assistant never get this: a project / thread keeps the mode the owner set
 * in the app.
 */
export const ASSISTANT_THREAD_RUNTIME_MODE: RuntimeMode = "full-access";

export const defaultBindingTarget = (
  connectorProjectId: ProjectId,
): ManagerConnectorBindingTarget => ({ kind: "assistant", projectId: connectorProjectId });

/** The target a chat talks to: its binding row, or the connector's assistant. */
export const effectiveBindingTarget = (
  binding: ManagerConnectorBinding | null | undefined,
  connectorProjectId: ProjectId,
): ManagerConnectorBindingTarget => binding?.target ?? defaultBindingTarget(connectorProjectId);

export const bindingTargetId = (target: ManagerConnectorBindingTarget): string =>
  target.kind === "thread" ? target.threadId : target.projectId;

export interface BindingTargetLabels {
  readonly projectTitleById: ReadonlyMap<string, string>;
  readonly threadTitleById: ReadonlyMap<string, string>;
}

/** Human title of a target, or null when it no longer exists. */
export const bindingTargetLabel = (
  target: ManagerConnectorBindingTarget,
  labels: BindingTargetLabels,
): string | null =>
  target.kind === "thread"
    ? (labels.threadTitleById.get(target.threadId) ?? null)
    : (labels.projectTitleById.get(target.projectId) ?? null);

// ---------------------------------------------------------------------------
// Personal Telegram chats talk to the main conversation
// ---------------------------------------------------------------------------

/**
 * Whether a Telegram chat id is a private (1:1) chat. Telegram gives private
 * chats the user's id (positive); groups, supergroups and channels have
 * negative ids. Used where only the id is known (the startup migration).
 */
export const isPrivateTelegramChatId = (chatId: string): boolean =>
  /^[1-9]\d*$/.test(chatId.trim());

/**
 * Whether an incoming Telegram chat is private: its `type` when Telegram sent
 * one, else the sign of its id.
 */
export const isPrivateTelegramChat = (
  chat: { readonly id?: number | string; readonly type?: string } | null | undefined,
): boolean => {
  if (chat === null || chat === undefined) return false;
  if (chat.type !== undefined) return chat.type === "private";
  return chat.id !== undefined && isPrivateTelegramChatId(String(chat.id));
};

/**
 * Whether a chat's messages go to the default assistant's main conversation
 * (the pinned "Uno" chat) instead of a thread of its own: a private chat of
 * the default assistant's bot that is not bound to anything else — no
 * binding, or a plain "the assistant" binding. A group keeps its own thread;
 * an explicit `/use <project>` or `/thread <id>` choice is kept.
 */
export const routesToMainConversation = (input: {
  readonly connectorProjectId: ProjectId;
  readonly binding: ManagerConnectorBinding | null | undefined;
  readonly isPrivateChat: boolean;
}): boolean => {
  if (!input.isPrivateChat || input.connectorProjectId !== ASSISTANT_PROJECT_ID) return false;
  const target = input.binding?.target;
  return (
    target === undefined ||
    (target.kind === "assistant" && target.projectId === ASSISTANT_PROJECT_ID)
  );
};

/**
 * What an inbound message talks to: {@link effectiveBindingTarget}, except
 * that a personal chat of the default assistant goes to its main
 * conversation (when there is one yet — else the assistant as before).
 */
export const resolveChatTarget = (input: {
  readonly connectorProjectId: ProjectId;
  readonly binding: ManagerConnectorBinding | null | undefined;
  readonly isPrivateChat: boolean;
  readonly mainThreadId: ThreadId | null;
}): ManagerConnectorBindingTarget =>
  input.mainThreadId !== null && routesToMainConversation(input)
    ? { kind: "thread", threadId: input.mainThreadId }
    : effectiveBindingTarget(input.binding, input.connectorProjectId);

export interface PrivateChatMigrationStep {
  readonly chatId: string;
  /** Where the chat pointed before; null = no binding (the assistant's own per-chat thread). */
  readonly previousTarget: ManagerConnectorBindingTarget | null;
  /** Carried over from the old binding row. */
  readonly notifyOnComplete: boolean;
}

/**
 * The one-time re-pointing of already linked personal chats (0.0.86): every
 * allowlisted private chat of the default assistant's bot that still talks to
 * a thread of its own is bound to the main conversation. Groups and chats the
 * owner bound elsewhere are left alone; the old threads keep their history,
 * only routing moves. Naturally idempotent — a chat already bound to the
 * main conversation is not in the plan.
 */
export const planPrivateChatMigration = (input: {
  readonly connectorProjectId: ProjectId;
  readonly allowedChatIds: ReadonlyArray<string>;
  readonly bindings: ReadonlyArray<ManagerConnectorBinding>;
  readonly mainThreadId: ThreadId;
}): ReadonlyArray<PrivateChatMigrationStep> => {
  if (input.connectorProjectId !== ASSISTANT_PROJECT_ID) return [];
  const byChat = new Map(
    input.bindings
      .filter((binding) => binding.kind === "telegram")
      .map((binding) => [binding.chatId, binding] as const),
  );
  const steps: Array<PrivateChatMigrationStep> = [];
  const seen = new Set<string>();
  for (const chatId of input.allowedChatIds) {
    if (seen.has(chatId)) continue;
    seen.add(chatId);
    const binding = byChat.get(chatId) ?? null;
    if (
      !routesToMainConversation({
        connectorProjectId: input.connectorProjectId,
        binding,
        isPrivateChat: isPrivateTelegramChatId(chatId),
      })
    ) {
      continue;
    }
    steps.push({
      chatId,
      previousTarget: binding?.target ?? null,
      notifyOnComplete: binding?.notifyOnComplete ?? false,
    });
  }
  return steps;
};

// ---------------------------------------------------------------------------
// Thread routing per target kind
// ---------------------------------------------------------------------------

export interface RoutingThreadShell {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly archivedAt: string | null;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface RoutingModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export type ThreadRouting =
  | {
      readonly kind: "reuse";
      readonly threadId: ThreadId;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    }
  | {
      readonly kind: "create";
      readonly projectId: ProjectId;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      /** Thread the chat used before (harness switch / archived): seeds the handoff. */
      readonly previousThreadId: ThreadId | null;
    }
  | { readonly kind: "reject"; readonly message: string };

export interface ThreadRoutingInput {
  readonly target: ManagerConnectorBindingTarget;
  /**
   * Thread the connector's (targetProject, chat) mapping currently points
   * at, when it still exists. Irrelevant for `thread` targets.
   */
  readonly mappedThread: RoutingThreadShell | null;
  /** The bound thread itself (`thread` targets), when it still exists. */
  readonly targetThread: RoutingThreadShell | null;
  /** Connector-level harness choice; honoured for the assistant target only. */
  readonly connectorModelSelection: ModelSelection | null;
  /**
   * What the Uno chat runs on (Hermes + its LLM provider and model, 0.0.84).
   * When set it decides the assistant target: its Telegram / Slack chats run
   * on the same engine as the pinned chat, ahead of the connector's own pick.
   */
  readonly assistantModelSelection?: ModelSelection | null;
  /** Default model of the target project. */
  readonly projectModelSelection: ModelSelection | null;
  /** Modes a fresh thread in the target project inherits (`project` targets). */
  readonly inheritedModes: RoutingModes | null;
}

const sameHarnessAndModel = (a: ModelSelection, b: ModelSelection): boolean =>
  a.instanceId === b.instanceId && a.model === b.model;

/** Harness + model, and the assistant's LLM provider (a switch = a fresh thread). */
export const sameAssistantEngine = (a: ModelSelection, b: ModelSelection): boolean =>
  sameHarnessAndModel(a, b) && readAssistantLlmProvider(a) === readAssistantLlmProvider(b);

/**
 * Decide where an inbound message goes.
 *
 * - `thread`: exactly that thread; a missing or archived one is an error
 *   the chat is told about, never a silently created replacement.
 * - `assistant`: today's flow — one thread per chat on the connector's
 *   harness (falling back to the assistant project's default), re-created
 *   when the selection changes or the thread is archived, always in
 *   {@link ASSISTANT_THREAD_RUNTIME_MODE}.
 * - `project`: one thread per chat in that project on the project's own
 *   default model; the connector's harness choice does not apply. A reused
 *   thread keeps its own mode, a fresh one inherits the project's.
 */
export const decideThreadRouting = (input: ThreadRoutingInput): ThreadRouting => {
  const { target } = input;
  if (target.kind === "thread") {
    const thread = input.targetThread;
    if (thread === null) {
      return {
        kind: "reject",
        message: `This chat is bound to thread ${target.threadId}, which no longer exists. Use /threads to pick another, /use <project> or /assistant.`,
      };
    }
    if (thread.archivedAt !== null) {
      return {
        kind: "reject",
        message: `This chat is bound to thread ${target.threadId}, which is archived. Unarchive it in the app, or rebind with /thread, /use or /assistant.`,
      };
    }
    return {
      kind: "reuse",
      threadId: thread.id,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
    };
  }

  const isAssistant = target.kind === "assistant";
  const modelSelection = isAssistant
    ? (input.assistantModelSelection ??
      input.connectorModelSelection ??
      input.projectModelSelection)
    : input.projectModelSelection;
  const same =
    isAssistant && input.assistantModelSelection ? sameAssistantEngine : sameHarnessAndModel;
  const mapped = input.mappedThread;
  if (
    mapped !== null &&
    mapped.archivedAt === null &&
    (modelSelection === null || same(mapped.modelSelection, modelSelection))
  ) {
    return {
      kind: "reuse",
      threadId: mapped.id,
      runtimeMode: isAssistant ? ASSISTANT_THREAD_RUNTIME_MODE : mapped.runtimeMode,
      interactionMode: isAssistant ? "default" : mapped.interactionMode,
    };
  }
  if (modelSelection === null) {
    return {
      kind: "reject",
      message: isAssistant
        ? "Assistant project has no model configured."
        : "The bound project has no default model configured; set one in the app first.",
    };
  }
  const modes: RoutingModes = isAssistant
    ? { runtimeMode: ASSISTANT_THREAD_RUNTIME_MODE, interactionMode: "default" }
    : (input.inheritedModes ?? { runtimeMode: "approval-required", interactionMode: "default" });
  return {
    kind: "create",
    projectId: target.projectId,
    modelSelection,
    runtimeMode: modes.runtimeMode,
    interactionMode: modes.interactionMode,
    previousThreadId: mapped?.id ?? null,
  };
};

// ---------------------------------------------------------------------------
// Fuzzy lookup for /use and /thread
// ---------------------------------------------------------------------------

export interface MatchCandidate {
  readonly id: string;
  readonly title: string;
}

export type MatchResult<T extends MatchCandidate> =
  | { readonly kind: "match"; readonly item: T }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<T> }
  | { readonly kind: "none" };

export const MATCH_CANDIDATE_LIMIT = 10;

const single = <T extends MatchCandidate>(items: ReadonlyArray<T>): MatchResult<T> | null =>
  items.length === 1
    ? { kind: "match", item: items[0]! }
    : items.length > 1
      ? { kind: "ambiguous", candidates: items.slice(0, MATCH_CANDIDATE_LIMIT) }
      : null;

/**
 * Resolve a user-typed query against titles / ids, most specific first:
 * exact id, exact title (case-insensitive), id prefix, title prefix, title
 * substring. A tier with several hits is ambiguous — the caller lists them
 * rather than guessing.
 */
export const matchByTitleOrId = <T extends MatchCandidate>(
  items: ReadonlyArray<T>,
  query: string,
): MatchResult<T> => {
  const raw = query.trim();
  if (raw.length === 0) {
    return { kind: "none" };
  }
  const needle = raw.toLowerCase();
  const tiers: ReadonlyArray<(item: T) => boolean> = [
    (item) => item.id === raw,
    (item) => item.title.trim().toLowerCase() === needle,
    (item) => item.id.startsWith(raw),
    (item) => item.title.trim().toLowerCase().startsWith(needle),
    (item) => item.title.toLowerCase().includes(needle),
  ];
  for (const tier of tiers) {
    const result = single(items.filter(tier));
    if (result !== null) {
      return result;
    }
  }
  return { kind: "none" };
};

// ---------------------------------------------------------------------------
// Outbound: which chats hear about a thread / project
// ---------------------------------------------------------------------------

export interface NotifyConnector {
  readonly kind: ManagerConnectorBindingKind;
  readonly projectId: ProjectId;
  readonly allowedChatIds: ReadonlyArray<string>;
}

export interface ResolvedNotifyChat {
  readonly kind: ManagerConnectorBindingKind;
  readonly connectorProjectId: ProjectId;
  readonly chatId: string;
  readonly notifyOnComplete: boolean;
  /** Which rule selected the chat. */
  readonly via: "thread" | "project" | "assistant";
}

export interface ResolveNotifyChatsInput {
  readonly bindings: ReadonlyArray<ManagerConnectorBinding>;
  /** Enabled connectors and the chats they are allowed to talk to. */
  readonly connectors: ReadonlyArray<NotifyConnector>;
  readonly threadId: ThreadId | null;
  /** The thread's project, or an explicit project. */
  readonly projectId: ProjectId | null;
  /**
   * When no thread / project binding matches, fall back to the chats that
   * talk to an assistant (explicitly bound or unbound allowed chats). For a
   * thread inside an assistant project only that assistant's chats; with no
   * project at all, every assistant's chats. The events forwarder leaves this
   * off — it only pushes to chats that asked for a target.
   */
  readonly includeAssistantFallback: boolean;
  /**
   * The default assistant's main conversation. A chat bound to it (a personal
   * chat, 0.0.86) is one of the human's own chats: it stays in the assistant
   * fallback like an unbound one.
   */
  readonly mainConversationThreadId?: ThreadId | null;
}

const chatKey = (kind: ManagerConnectorBindingKind, chatId: string): string => `${kind}:${chatId}`;

const chatFromBinding = (
  binding: ManagerConnectorBinding,
  via: ResolvedNotifyChat["via"],
): ResolvedNotifyChat => ({
  kind: binding.kind,
  connectorProjectId: binding.connectorProjectId,
  chatId: binding.chatId,
  notifyOnComplete: binding.notifyOnComplete,
  via,
});

export const resolveNotifyChats = (
  input: ResolveNotifyChatsInput,
): ReadonlyArray<ResolvedNotifyChat> => {
  const seen = new Set<string>();
  const result: Array<ResolvedNotifyChat> = [];
  const push = (chat: ResolvedNotifyChat) => {
    const key = chatKey(chat.kind, chat.chatId);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(chat);
  };

  if (input.threadId !== null) {
    for (const binding of input.bindings) {
      if (binding.target.kind === "thread" && binding.target.threadId === input.threadId) {
        push(chatFromBinding(binding, "thread"));
      }
    }
  }
  if (input.projectId !== null) {
    for (const binding of input.bindings) {
      if (binding.target.kind === "project" && binding.target.projectId === input.projectId) {
        push(chatFromBinding(binding, "project"));
      }
    }
  }
  if (result.length > 0 || !input.includeAssistantFallback) {
    return result;
  }

  // Fallback: the human's own chats — those whose effective target is an
  // assistant. Scoped to one assistant when the subject lives in it.
  const assistantScope =
    input.projectId !== null && isAssistantProjectId(input.projectId) ? input.projectId : null;
  const bound = new Set(input.bindings.map((binding) => chatKey(binding.kind, binding.chatId)));
  const mainThreadId = input.mainConversationThreadId ?? null;
  for (const binding of input.bindings) {
    const talksToAssistant =
      binding.target.kind === "assistant"
        ? assistantScope === null || binding.target.projectId === assistantScope
        : binding.target.kind === "thread" &&
          mainThreadId !== null &&
          binding.target.threadId === mainThreadId &&
          (assistantScope === null || assistantScope === ASSISTANT_PROJECT_ID);
    if (talksToAssistant) {
      push(chatFromBinding(binding, "assistant"));
    }
  }
  for (const connector of input.connectors) {
    if (assistantScope !== null && connector.projectId !== assistantScope) {
      continue;
    }
    for (const chatId of connector.allowedChatIds) {
      if (!bound.has(chatKey(connector.kind, chatId))) {
        push({
          kind: connector.kind,
          connectorProjectId: connector.projectId,
          chatId,
          notifyOnComplete: false,
          via: "assistant",
        });
      }
    }
  }
  return result;
};
