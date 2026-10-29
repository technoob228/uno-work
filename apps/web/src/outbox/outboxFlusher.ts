/**
 * Delivers outbox messages (outboxStore.ts) once their chat's computer is
 * reachable again: on every connection change and on a short poll, per chat
 * one message at a time and in order, with the stored commandId.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { readEnvironmentApi } from "../environmentApi";
import { readPrimaryEnvironmentDescriptor } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime/catalog";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime/service";
import {
  TransportConnectionLostError,
  isTransportConnectionErrorMessage,
  isTransportInterruptErrorMessage,
} from "../rpc/transportError";
import { getWsConnectionStatus } from "../rpc/wsConnectionState";
import {
  nextOutboxDeliveries,
  useOutboxStore,
  type OutboxEntry,
  type OutboxTurnStartCommand,
} from "./outboxStore";

const OUTBOX_POLL_INTERVAL_MS = 3_000;
const OUTBOX_RETRY_COOLDOWN_MS = 2_500;

/** Same signal the chat's "<computer> is reconnecting" banner uses, plus the socket's own health. */
export function isEnvironmentLinkUp(environmentId: EnvironmentId): boolean {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection || !connection.isConnectionHealthy()) return false;
  if (environmentId === readPrimaryEnvironmentDescriptor()?.environmentId) {
    return getWsConnectionStatus().phase === "connected";
  }
  const saved = useSavedEnvironmentRuntimeStore.getState().byId[environmentId];
  return saved?.connectionState === "connected";
}

/**
 * For the composer: only a computer we hold a connection to and know is down
 * (no connection at all is handled by the caller, which then has no API).
 */
export function isEnvironmentLinkKnownDown(environmentId: EnvironmentId): boolean {
  return readEnvironmentConnection(environmentId) !== null && !isEnvironmentLinkUp(environmentId);
}

/** The link died (or the session was replaced) under the request: try again later, not an error. */
export function isConnectionShapedSendError(error: unknown): boolean {
  if (error instanceof TransportConnectionLostError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return isTransportConnectionErrorMessage(message) || isTransportInterruptErrorMessage(message);
}

export interface OutboxFlushDeps {
  readonly isLinkUp: (environmentId: EnvironmentId) => boolean;
  /** Undefined when there is no API for the computer right now. */
  readonly dispatch: (
    environmentId: EnvironmentId,
    command: OutboxTurnStartCommand,
  ) => Promise<unknown> | undefined;
}

const inFlight = new Set<string>();
/** After the link failed under a send, wait one poll before the next try (no hot loop). */
const retryNotBefore = new Map<EnvironmentId, number>();

export function resetOutboxFlusherForTests(): void {
  inFlight.clear();
  retryNotBefore.clear();
}

async function deliver(entry: OutboxEntry, deps: OutboxFlushDeps): Promise<void> {
  inFlight.add(entry.id);
  let pending: Promise<unknown> | undefined;
  try {
    pending = deps.dispatch(entry.environmentId, entry.command);
  } catch (error) {
    pending = Promise.reject(error);
  }
  if (!pending) {
    inFlight.delete(entry.id);
    return;
  }
  useOutboxStore.getState().markSending(entry.id);
  try {
    await pending;
    retryNotBefore.delete(entry.environmentId);
    useOutboxStore.getState().remove(entry.id);
  } catch (error) {
    if (isConnectionShapedSendError(error)) {
      retryNotBefore.set(entry.environmentId, Date.now() + OUTBOX_RETRY_COOLDOWN_MS);
      useOutboxStore.getState().markWaiting(entry.id);
    } else {
      useOutboxStore
        .getState()
        .markFailed(entry.id, error instanceof Error ? error.message : "Failed to send message.");
    }
  } finally {
    inFlight.delete(entry.id);
  }
}

/**
 * One pass: starts every delivery that may go now (a chat with a message in
 * flight waits for it); resolves when the started deliveries settle.
 */
export function flushOutboxOnce(deps: OutboxFlushDeps): Promise<void> {
  const store = useOutboxStore.getState();
  // A "sending" entry nobody is sending (e.g. after a hot reload) goes back in line.
  for (const entry of store.entries) {
    if (entry.status === "sending" && !inFlight.has(entry.id)) store.markWaiting(entry.id);
  }
  const now = Date.now();
  const ready = nextOutboxDeliveries(
    useOutboxStore.getState().entries,
    (environmentId) =>
      (retryNotBefore.get(environmentId) ?? 0) <= now && deps.isLinkUp(environmentId),
  );
  return Promise.all(ready.map((entry) => deliver(entry, deps))).then(() => undefined);
}

const defaultDeps: OutboxFlushDeps = {
  isLinkUp: isEnvironmentLinkUp,
  dispatch: (environmentId, command) =>
    readEnvironmentApi(environmentId)?.orchestration.dispatchCommand(command),
};

/** Started once from the app root; returns the stop function. */
export function startOutboxFlusher(deps: OutboxFlushDeps = defaultDeps): () => void {
  let stopped = false;
  const kick = () => {
    if (stopped || useOutboxStore.getState().entries.length === 0) return;
    void flushOutboxOnce(deps).catch(() => undefined);
  };
  const unsubscribeConnections = subscribeEnvironmentConnections(kick);
  const unsubscribeSaved = useSavedEnvironmentRuntimeStore.subscribe(kick);
  // A new message, a Retry, or the previous message of a chat delivered.
  const unsubscribeOutbox = useOutboxStore.subscribe((state, previous) => {
    if (state.entries !== previous.entries) kick();
  });
  const timer = setInterval(kick, OUTBOX_POLL_INTERVAL_MS);
  kick();
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribeConnections();
    unsubscribeSaved();
    unsubscribeOutbox();
  };
}
