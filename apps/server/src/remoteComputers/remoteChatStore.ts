/**
 * Two small ledgers of chats that cross computers (assistants D, 28.10),
 * JSON under the daemon's state dir like the started-chats ledger
 * (`assistants/localAssistantStore.ts`):
 *
 * - **incoming** (`remote-started-by.json`, on the computer the chat runs
 *   on): which assistant of which other computer started a chat here — for
 *   the sidebar's "started by <name>" (`GET /api/manager/started-by`);
 * - **outgoing** (`remote-chats-out.json`, on the assistant's computer): the
 *   chats its assistants started elsewhere and the last status seen — for
 *   `work_status` and the done push.
 *
 * @module remoteComputers/remoteChatStore
 */
import * as nodePath from "node:path";

import type { AssistantPreset } from "@t3tools/contracts";

import {
  assistantStoreDir,
  readStoreJson,
  updateStoreJson,
  type AppAccess,
} from "../assistants/localAssistantStore.ts";

/** Newest entries kept in each ledger. */
const LEDGER_LIMIT = 500;

export interface IncomingRemoteChat {
  readonly threadId: string;
  readonly assistantName: string;
  readonly assistantProjectId: string | null;
  readonly fromComputerName: string;
  readonly fromBoxId: number | null;
  readonly fromThreadId: string;
  readonly startedAt: string;
  /** The assistant's app levels there (absent: the person's chat, no limits). */
  readonly apps?: AppAccess | undefined;
  readonly preset?: AssistantPreset | undefined;
}

/**
 * The remote assistant a chat of this computer acts for: the chat itself
 * came from another computer, or one of its ancestors did (a chat it
 * started). Null: not a remote assistant's chat.
 */
export function remoteStarterOf(
  threadId: string,
  threadById: (
    id: string,
  ) => { readonly spawnedByThreadId?: string | null | undefined } | undefined,
  incoming: ReadonlyArray<IncomingRemoteChat>,
): IncomingRemoteChat | null {
  const byThread = new Map(incoming.map((entry) => [entry.threadId, entry]));
  let current: string | null = threadId;
  for (let depth = 0; current !== null && depth < 6; depth += 1) {
    const found = byThread.get(current);
    if (found !== undefined) return found;
    current = threadById(current)?.spawnedByThreadId ?? null;
  }
  return null;
}

export interface OutgoingRemoteChat {
  readonly threadId: string;
  readonly boxId: number;
  readonly computerName: string;
  readonly title: string;
  readonly assistantProjectId: string;
  /** The assistant's conversation that started it (the done push goes there). */
  readonly conversationThreadId: string;
  readonly startedAt: string;
  /** Last status seen on the other computer (`ManagerRemoteChatStatus.state`). */
  readonly state: string;
  readonly lastMessage: string | null;
  /** When the status was last read (null: never). */
  readonly checkedAt: string | null;
}

const incomingFile = (stateDir: string) =>
  nodePath.join(assistantStoreDir(stateDir), "remote-started-by.json");
const outgoingFile = (stateDir: string) =>
  nodePath.join(assistantStoreDir(stateDir), "remote-chats-out.json");

type Ledger<A> = Record<string, A>;

const keepNewest = <A extends { readonly startedAt: string }>(ledger: Ledger<A>): Ledger<A> => {
  const entries = Object.entries(ledger);
  if (entries.length <= LEDGER_LIMIT) return ledger;
  return Object.fromEntries(
    entries.toSorted((a, b) => b[1].startedAt.localeCompare(a[1].startedAt)).slice(0, LEDGER_LIMIT),
  );
};

export function recordIncomingRemoteChat(stateDir: string, entry: IncomingRemoteChat) {
  return updateStoreJson<Ledger<IncomingRemoteChat>>(incomingFile(stateDir), {}, (current) =>
    keepNewest({ ...current, [entry.threadId]: entry }),
  ).then(() => undefined);
}

export async function readIncomingRemoteChats(
  stateDir: string,
): Promise<ReadonlyArray<IncomingRemoteChat>> {
  const ledger = await readStoreJson<Ledger<IncomingRemoteChat>>(incomingFile(stateDir), {});
  return Object.values(ledger).filter(
    (entry) => typeof entry?.threadId === "string" && typeof entry.assistantName === "string",
  );
}

export function recordOutgoingRemoteChat(stateDir: string, entry: OutgoingRemoteChat) {
  return updateStoreJson<Ledger<OutgoingRemoteChat>>(outgoingFile(stateDir), {}, (current) =>
    keepNewest({ ...current, [entry.threadId]: entry }),
  ).then(() => undefined);
}

export function updateOutgoingRemoteChat(
  stateDir: string,
  threadId: string,
  patch: Partial<Pick<OutgoingRemoteChat, "state" | "lastMessage" | "checkedAt" | "title">>,
) {
  return updateStoreJson<Ledger<OutgoingRemoteChat>>(outgoingFile(stateDir), {}, (current) => {
    const existing = current[threadId];
    return existing === undefined ? current : { ...current, [threadId]: { ...existing, ...patch } };
  }).then(() => undefined);
}

export async function readOutgoingRemoteChats(
  stateDir: string,
): Promise<ReadonlyArray<OutgoingRemoteChat>> {
  const ledger = await readStoreJson<Ledger<OutgoingRemoteChat>>(outgoingFile(stateDir), {});
  return Object.values(ledger).filter(
    (entry) => typeof entry?.threadId === "string" && typeof entry.boxId === "number",
  );
}
