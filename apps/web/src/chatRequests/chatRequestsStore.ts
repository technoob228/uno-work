/**
 * Chat requests from the cloud (chatRequests.logic.ts) as this window holds
 * them: `chatRequests.state` of this computer's Uno Work, asked every 5 s
 * while the app is open (ChatRequestsListener.tsx).
 *
 * Only on the person's own computer: the host is the daemon serving this
 * page when it isn't an Uno cloud computer (`useChatRequestsHostId`). On a
 * cloud computer there is nothing to show — `hostId` stays null, nothing is
 * asked, every count is 0.
 */
import type { ChatRequestDecideInput, ChatRequestsState, EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

import { demoHooks } from "../demo/demoFlag";
import { usePrimaryEnvironmentDescriptor } from "../environments/primary";
import { readEnvironmentApi } from "../environmentApi";
import { useMachineRows } from "../hooks/useMachineRows";
import { deriveMachineKind } from "../machineKind";
import { useMinuteClock } from "../hooks/useMinuteClock";
import { failureMessage, waitingCount } from "./chatRequests.logic";

export const CHAT_REQUESTS_POLL_MS = 5_000;

interface ChatRequestsStoreState {
  /** The computer whose requests these are (this one); null — a cloud computer, or not known yet. */
  readonly hostId: EnvironmentId | null;
  /** null — not asked yet (or the server there doesn't know the method). */
  readonly state: ChatRequestsState | null;
  /** Request id (or "allow") being answered right now. */
  readonly busy: Readonly<Record<string, true>>;
  /** The request whose brief is open ("Read the brief"); one dialog for the whole window. */
  readonly briefId: string | null;
}

export const useChatRequestsStore = create<ChatRequestsStoreState>(() => ({
  hostId: null,
  state: null,
  busy: {},
  briefId: null,
}));

/** Waiting requests — added to every Needs you count (bell, rail, Dock, Home). */
export function useChatRequestsWaitingCount(): number {
  // Re-read each minute: a request past its 2 h stops counting before the server says so.
  useMinuteClock();
  return useChatRequestsStore((store) => waitingCount(store.state));
}

/**
 * The daemon serving this page, when it is the person's own computer (the
 * Mac in the desktop app). The demo names its MacBook (chatRequestsDemo.ts).
 */
export function useChatRequestsHostId(): EnvironmentId | null {
  const descriptor = usePrimaryEnvironmentDescriptor();
  const rows = useMachineRows();
  const demoHost = demoHooks.chatRequestsHost as EnvironmentId | undefined;
  if (demoHost) return demoHost;
  if (!descriptor) return null;
  const row = rows.find((candidate) => candidate.environmentId === descriptor.environmentId);
  const kind = row?.kind ?? deriveMachineKind({ descriptor });
  return kind === "uno_box" ? null : descriptor.environmentId;
}

/** The listener found (or lost) the host: a different computer forgets the old answer. */
export function setChatRequestsHost(hostId: EnvironmentId | null): void {
  const current = useChatRequestsStore.getState();
  if (current.hostId === hostId) return;
  useChatRequestsStore.setState({ hostId, state: null, busy: {}, briefId: null });
}

function hostApi() {
  const { hostId } = useChatRequestsStore.getState();
  return hostId ? (readEnvironmentApi(hostId) ?? null) : null;
}

let inFlight: Promise<ChatRequestsState | null> | null = null;

/** Ask now; on a passing error the previous answer stays. */
export function refreshChatRequests(): Promise<ChatRequestsState | null> {
  if (inFlight) return inFlight;
  const run = async (): Promise<ChatRequestsState | null> => {
    const hostId = useChatRequestsStore.getState().hostId;
    const api = hostApi();
    if (!api) return null;
    try {
      const state = await api.chatRequests.state();
      if (useChatRequestsStore.getState().hostId !== hostId) return null;
      useChatRequestsStore.setState({ state });
      return state;
    } catch {
      return null;
    }
  };
  inFlight = run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function setBusy(key: string, on: boolean): void {
  useChatRequestsStore.setState((store) => {
    if (on) return { busy: { ...store.busy, [key]: true } };
    const { [key]: _done, ...rest } = store.busy;
    return { busy: rest };
  });
}

export type DecideOutcome =
  | { readonly ok: true; readonly threadId: string | null; readonly hostId: EnvironmentId }
  | { readonly ok: false; readonly message: string };

/**
 * Start or Decline. Start: the server opens the chat here and says which;
 * the caller opens it. A failure carries the server's sentence (2 at once,
 * ran out, turned off).
 */
export async function decideChatRequest(
  id: string,
  decision: ChatRequestDecideInput["decision"],
): Promise<DecideOutcome> {
  const hostId = useChatRequestsStore.getState().hostId;
  const api = hostApi();
  if (!api || !hostId) return { ok: false, message: failureMessage(null) };
  setBusy(id, true);
  try {
    const result = await api.chatRequests.decide({ id, decision });
    useChatRequestsStore.setState((store) => ({
      state: result.state,
      briefId: store.briefId === id ? null : store.briefId,
    }));
    return { ok: true, threadId: result.threadId, hostId };
  } catch (cause) {
    // What the server says now (it may have run out or been answered elsewhere).
    void refreshChatRequests();
    return { ok: false, message: failureMessage(cause) };
  } finally {
    setBusy(id, false);
  }
}

/** Settings → Computer → "Allow cloud chats to ask to start chats here". */
export async function setChatRequestsAllowed(allow: boolean): Promise<string | null> {
  const api = hostApi();
  if (!api) return failureMessage(null);
  setBusy("allow", true);
  try {
    const state = await api.chatRequests.setAllowed({ allow });
    useChatRequestsStore.setState({ state });
    return null;
  } catch (cause) {
    return failureMessage(cause);
  } finally {
    setBusy("allow", false);
  }
}

export function openChatRequestBrief(id: string): void {
  useChatRequestsStore.setState({ briefId: id });
}

export function closeChatRequestBrief(): void {
  useChatRequestsStore.setState({ briefId: null });
}
