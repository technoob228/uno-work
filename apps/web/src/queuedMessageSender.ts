/**
 * "Up next" for chats that aren't on screen (T48, 13.11; upstream 295d7cba09
 * "queued messages send while their thread is not open").
 *
 * Before, only the open chat sent its queue (ChatView): a message written
 * into a working chat waited until the person came back to that very chat —
 * and if the computer had let the agent's session go meanwhile (15 min idle),
 * it waited for good. This sender runs once, from the app root, for every
 * chat with a queue that no open chat view sends (claimQueuedMessages): the
 * first waiting message goes as soon as the chat is free, with the chat's own
 * model and modes, one per finished turn.
 *
 * Once only: the message leaves the queue through `take` (shared by the tabs
 * through localStorage) and goes with ids made from its own id
 * (queuedTurnIds) — a second try anywhere is the same command, and the
 * computer's receipts take it once. After a send the next one waits until
 * the computer has seen the turn (hasServerAcknowledgedLocalDispatch), so two
 * messages never go into the gap before it starts.
 *
 * It still needs the app running and its computer reachable: closed on every
 * device, the queue goes when the app is opened again.
 */
import { parseScopedThreadKey } from "@t3tools/client-runtime";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationLatestTurn,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { isRestartCutOffError } from "@t3tools/shared/turnErrorRetry";

import {
  createLocalDispatchSnapshot,
  hasServerAcknowledgedLocalDispatch,
  type LocalDispatchSnapshot,
} from "./components/ChatView.logic";
import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { readEnvironmentApi } from "./environmentApi";
import { subscribeEnvironmentConnections } from "./environments/runtime/service";
import { isConnectionShapedSendError, isEnvironmentLinkUp } from "./outbox/outboxFlusher";
import { useOutboxStore, type OutboxTurnStartCommand } from "./outbox/outboxStore";
import {
  isQueueOwnedOnScreen,
  nextQueuedMessageToSend,
  QUEUE_AFTER_RESTART_DELAY_MS,
  queuedTurnIds,
  useQueuedMessageStore,
  type QueuedChatMessage,
} from "./queuedMessageStore";
import { derivePhase } from "./session-logic";
import { selectEnvironmentState, useStore } from "./store";
import type { ThreadSession } from "./types";

const POLL_INTERVAL_MS = 3_000;
/** The computer never showed the turn: the next message stops waiting for it. */
export const QUEUED_SEND_ACK_TIMEOUT_MS = 60_000;

/** What the sender needs to know about a chat; from the chat list (shell stream). */
export interface QueuedChatState {
  readonly title: string;
  readonly session: ThreadSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly waitingForPerson: boolean;
  readonly error: string | null;
  readonly archived: boolean;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface QueuedSenderDeps {
  readonly now: () => number;
  /** Null: the chat isn't known here (yet): nothing goes. */
  readonly readChat: (ref: ScopedThreadRef) => QueuedChatState | null;
  readonly isLinkUp: (environmentId: EnvironmentId) => boolean;
  readonly ownedOnScreen: (threadKey: string) => boolean;
  /** Undefined when there is no API for the computer right now. */
  readonly dispatch: (
    environmentId: EnvironmentId,
    command: OutboxTurnStartCommand,
  ) => Promise<unknown> | undefined;
  /** The computer refused it: it is back first in "Up next", held. */
  readonly onRefused: (chat: QueuedChatState, error: unknown) => void;
}

/**
 * A turn cut off by a restart blocks the queue only for a moment: the daemon
 * continues it itself, and if it doesn't, the queue goes on from there (as the
 * open chat does with its timer).
 */
export function queueBlockedByError(chat: QueuedChatState, now: number): boolean {
  if (!chat.error) return false;
  if (!isRestartCutOffError(chat.error)) return true;
  const since = Date.parse(chat.session?.updatedAt ?? "");
  return !Number.isFinite(since) || now - since < QUEUE_AFTER_RESTART_DELAY_MS;
}

interface SentTurn {
  readonly snapshot: LocalDispatchSnapshot;
  readonly at: number;
}

const inFlight = new Set<string>();
/** Per chat: the turn this sender started, until the computer shows it. */
const awaitingAck = new Map<string, SentTurn>();

export function resetQueuedMessageSenderForTests(): void {
  inFlight.clear();
  awaitingAck.clear();
}

function stillAwaitingAck(threadKey: string, chat: QueuedChatState, now: number): boolean {
  const sent = awaitingAck.get(threadKey);
  if (!sent) return false;
  const acknowledged =
    now - sent.at >= QUEUED_SEND_ACK_TIMEOUT_MS ||
    hasServerAcknowledgedLocalDispatch({
      localDispatch: sent.snapshot,
      phase: derivePhase(chat.session),
      latestTurn: chat.latestTurn,
      session: chat.session,
      hasPendingApproval: chat.waitingForPerson,
      hasPendingUserInput: false,
      threadError: chat.error,
    });
  if (acknowledged) awaitingAck.delete(threadKey);
  return !acknowledged;
}

/** What goes now: per chat with a queue, its first message if the chat is free. */
export function dueQueuedMessages(
  queues: Readonly<Record<string, ReadonlyArray<QueuedChatMessage>>>,
  deps: Pick<QueuedSenderDeps, "now" | "readChat" | "isLinkUp" | "ownedOnScreen">,
): ReadonlyArray<{
  readonly threadKey: string;
  readonly ref: ScopedThreadRef;
  readonly chat: QueuedChatState;
  readonly message: QueuedChatMessage;
}> {
  const now = deps.now();
  const due = [];
  for (const [threadKey, queue] of Object.entries(queues)) {
    if (inFlight.has(threadKey) || deps.ownedOnScreen(threadKey)) continue;
    const ref = parseScopedThreadKey(threadKey);
    if (!ref || !deps.isLinkUp(ref.environmentId)) continue;
    const chat = deps.readChat(ref);
    if (!chat || chat.archived) continue;
    if (stillAwaitingAck(threadKey, chat, now)) continue;
    const message = nextQueuedMessageToSend({
      queue,
      phase: derivePhase(chat.session),
      busy: false,
      waitingForPerson: chat.waitingForPerson,
      hasError: queueBlockedByError(chat, now),
    });
    if (message) due.push({ threadKey, ref, chat, message });
  }
  return due;
}

async function send(
  entry: ReturnType<typeof dueQueuedMessages>[number],
  deps: QueuedSenderDeps,
): Promise<void> {
  const { threadKey, ref, chat } = entry;
  const message = useQueuedMessageStore.getState().take(threadKey, entry.message.id);
  // Another tab, or the open chat, took it a moment ago.
  if (!message) return;
  const ids = queuedTurnIds(message);
  const command: OutboxTurnStartCommand = {
    type: "thread.turn.start",
    commandId: ids.commandId,
    threadId: ref.threadId,
    message: { messageId: ids.messageId, role: "user", text: message.text, attachments: [] },
    modelSelection: chat.modelSelection,
    runtimeMode: chat.runtimeMode,
    interactionMode: chat.interactionMode,
    createdAt: new Date(deps.now()).toISOString(),
  };
  inFlight.add(threadKey);
  const snapshot = createLocalDispatchSnapshot(chat);
  try {
    const pending = deps.dispatch(ref.environmentId, command);
    if (!pending) {
      // No API right now: it was never sent — back first, as it was.
      useQueuedMessageStore.getState().putBackFirst(threadKey, message);
      return;
    }
    await pending;
    awaitingAck.set(threadKey, { snapshot, at: deps.now() });
  } catch (error) {
    if (isConnectionShapedSendError(error)) {
      // The link dropped under it: the outbox delivers this same command
      // (same commandId) once the computer is back, as for a typed message.
      useOutboxStore.getState().enqueue({ environmentId: ref.environmentId, command });
      return;
    }
    useQueuedMessageStore.getState().holdAtFront(threadKey, message, { retry: true });
    deps.onRefused(chat, error);
  } finally {
    inFlight.delete(threadKey);
  }
}

/** One pass: sends what is due; resolves when those sends settle. */
export function sendDueQueuedMessagesOnce(deps: QueuedSenderDeps): Promise<void> {
  const due = dueQueuedMessages(useQueuedMessageStore.getState().queuesByThreadKey, deps);
  return Promise.all(due.map((entry) => send(entry, deps))).then(() => undefined);
}

function readChatFromStore(ref: ScopedThreadRef): QueuedChatState | null {
  const environment = selectEnvironmentState(useStore.getState(), ref.environmentId);
  const summary = environment.sidebarThreadSummaryById[ref.threadId];
  const shell = environment.threadShellById[ref.threadId];
  if (!summary || !shell) return null;
  return {
    title: shell.title,
    session: summary.session,
    latestTurn: summary.latestTurn,
    waitingForPerson: summary.hasPendingApprovals || summary.hasPendingUserInput,
    error: shell.error,
    archived: shell.archivedAt !== null,
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
  };
}

const defaultDeps: QueuedSenderDeps = {
  now: Date.now,
  readChat: readChatFromStore,
  isLinkUp: isEnvironmentLinkUp,
  ownedOnScreen: isQueueOwnedOnScreen,
  dispatch: (environmentId, command) =>
    readEnvironmentApi(environmentId)?.orchestration.dispatchCommand(command),
  onRefused: (chat, error) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `A message from Up next didn't go in "${chat.title}"`,
        description: `${error instanceof Error ? error.message : "The computer refused it."} It waits there for Send now.`,
      }),
    );
  },
};

/** Started once from the app root; returns the stop function. */
export function startQueuedMessageSender(deps: QueuedSenderDeps = defaultDeps): () => void {
  let stopped = false;
  const kick = () => {
    if (stopped) return;
    if (Object.keys(useQueuedMessageStore.getState().queuesByThreadKey).length === 0) return;
    void sendDueQueuedMessagesOnce(deps).catch(() => undefined);
  };
  // A turn ends, a session goes, an approval is answered: the chat list changes.
  const unsubscribeChats = useStore.subscribe(kick);
  const unsubscribeQueues = useQueuedMessageStore.subscribe((state, previous) => {
    if (state.queuesByThreadKey !== previous.queuesByThreadKey) kick();
  });
  const unsubscribeConnections = subscribeEnvironmentConnections(kick);
  // The restart wait and the ack timeout end without an event.
  const timer = setInterval(kick, POLL_INTERVAL_MS);
  kick();
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribeChats();
    unsubscribeQueues();
    unsubscribeConnections();
  };
}
