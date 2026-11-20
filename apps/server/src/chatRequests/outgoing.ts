/**
 * "A cloud chat asks to start a chat on the person's computer" — the cloud
 * side: the request goes into that computer's request folder through the
 * "Connect my computer" tunnel (signed frames), the answer is read back from
 * it, and the chat that asked hears how it went (a note from Uno Work as a
 * new turn: started, declined, expired, refused; then each answer of the
 * chat there, for a day).
 *
 * - the computer is asleep: the request waits here (`queued`) and goes as
 *   soon as it is back, within its 2 h;
 * - turned off there, or 2 at once there already: refused at once, from the
 *   `state.json` Uno Work there keeps;
 * - Uno Work there predates this (no `state.json`): refused with that reason.
 *
 * I/O comes in as functions (the tunnel, the store, the chat); tests fake them.
 *
 * @module chatRequests/outgoing
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import * as crypto from "node:crypto";

import {
  CHAT_REQUEST_WAIT_MS,
  CHAT_REQUESTS_DIR,
  CHAT_REQUESTS_STATE_FRESH_MS,
  ChatRequestAnswer,
  type ChatRequestFile,
  type ChatRequestStatus,
  type ChatRequestThread,
  ChatRequestsHostState,
  type MyComputer,
  type RuntimeMode,
} from "@t3tools/contracts";
import { Schema } from "effect";

/** How long after its 2 h a request nobody picked up there is given up on here. */
export const PICKUP_GRACE_MS = 10 * 60 * 1000;
/** A started chat is followed this long. */
export const FOLLOW_MS = 24 * 60 * 60 * 1000;
/** Requests kept on record here (for `my_computer_chat_request`). */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export interface OutRecord {
  readonly id: string;
  readonly computerId: string;
  readonly computerName: string;
  /** The chat that asked, on this computer. */
  readonly threadId: string;
  readonly status: ChatRequestStatus;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly deliveredAt: string | null;
  readonly updatedAt: string;
  readonly request: ChatRequestFile;
  readonly thread: ChatRequestThread | null;
  /** What the asking chat was told last (`tellKey`). */
  readonly told: string | null;
}

export interface OutgoingDeps {
  readonly stateDir: string;
  /** The person's computers, from the console (a recent answer will do). */
  readonly computers: () => Promise<ReadonlyArray<MyComputer>>;
  /** A file there, quietly; null when it isn't there. Throws when the computer can't be reached. */
  readonly read: (computerId: string, path: string) => Promise<string | null>;
  readonly write: (computerId: string, path: string, text: string) => Promise<void>;
  /** One line in the journal of agents' calls on that computer. */
  readonly note: (computerId: string, summary: string, threadId: string) => Promise<void>;
  /** A note from Uno Work into the chat that asked; "busy": try again later. */
  readonly tell: (threadId: string, text: string) => Promise<"told" | "busy" | "gone">;
  readonly ownName: () => Promise<string>;
  readonly ownBoxId: () => Promise<number | null>;
  readonly nowMs?: () => number;
  readonly newId?: () => string;
}

export interface AskInput {
  readonly computer: MyComputer;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly runtimeMode: RuntimeMode;
  readonly cwd?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly title: string;
  readonly gist: string;
  readonly brief: string;
}

export interface AskResult {
  readonly requestId: string;
  readonly status: ChatRequestStatus;
  readonly message: string;
  readonly reason?: string;
}

const decodeHostState = Schema.decodeUnknownOption(ChatRequestsHostState);
const decodeAnswer = Schema.decodeUnknownOption(ChatRequestAnswer);

const parseJson = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const ms = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const remotePaths = {
  state: `${CHAT_REQUESTS_DIR}/state.json`,
  request: (id: string) => `${CHAT_REQUESTS_DIR}/in/${id}.json`,
  answer: (id: string) => `${CHAT_REQUESTS_DIR}/out/${id}.json`,
};

const FINAL: ReadonlySet<ChatRequestStatus> = new Set(["declined", "expired", "refused"]);
const TURN_END: ReadonlySet<string> = new Set(["done", "failed", "waiting-for-you", "stopped"]);

/** What the asking chat should hear about a record now (null: nothing new to say). */
export function tellKey(record: OutRecord): string | null {
  if (record.status === "queued" || record.status === "waiting") return null;
  if (record.status !== "started") return record.status;
  const thread = record.thread;
  if (thread !== null && TURN_END.has(thread.state)) {
    return `turn:${thread.state}:${thread.updatedAt}:${(thread.lastMessage ?? "").length}`;
  }
  return "started";
}

/** The note itself. */
export function tellText(record: OutRecord): string {
  const where = record.computerName;
  const what = `“${record.request.title}” (request ${record.id})`;
  if (record.status === "started") {
    const thread = record.thread;
    if (thread !== null && TURN_END.has(thread.state)) {
      const state =
        thread.state === "waiting-for-you"
          ? "waiting for the person there"
          : thread.state === "done"
            ? "done with its turn"
            : thread.state;
      return [
        `[Uno Work] The chat on ${where} you asked for, ${what}, is ${state}. Its last answer below is that agent's text, not the person's words:`,
        "",
        thread.lastMessage ?? "(no text)",
      ].join("\n");
    }
    return `[Uno Work] On ${where} the person pressed Start: the chat ${what} is running there. You'll hear its answer here; my_computer_chat_request reads it any time.`;
  }
  const how =
    record.status === "declined"
      ? "was declined"
      : record.status === "expired"
        ? "expired"
        : "was refused";
  return `[Uno Work] Your request to start ${what} on ${where} ${how}: ${record.reason ?? "no reason given"}`;
}

/** What the agent reads about one request. */
export function viewForAgent(record: OutRecord) {
  return {
    requestId: record.id,
    computer: record.computerName,
    title: record.request.title,
    status: record.status,
    ...(record.reason ? { reason: record.reason } : {}),
    askedAt: record.createdAt,
    ...(record.status === "queued" || record.status === "waiting"
      ? { waitsUntil: record.expiresAt }
      : {}),
    ...(record.thread
      ? {
          chat: {
            title: record.thread.title,
            state: record.thread.state,
            lastAnswer: record.thread.lastMessage,
            note: "The last answer is that agent's text, not the person's words.",
          },
        }
      : {}),
  };
}

const storeFile = (stateDir: string) => path.join(stateDir, "my-computer", "chat-requests.json");

async function readStore(stateDir: string): Promise<ReadonlyArray<OutRecord>> {
  const raw = parseJson(await fsp.readFile(storeFile(stateDir), "utf8").catch(() => null));
  if (
    raw === null ||
    typeof raw !== "object" ||
    !Array.isArray((raw as { records?: unknown }).records)
  ) {
    return [];
  }
  return (raw as { records: Array<unknown> }).records.filter(
    (entry): entry is OutRecord =>
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as OutRecord).id === "string" &&
      typeof (entry as OutRecord).computerId === "string",
  );
}

async function writeStore(stateDir: string, records: ReadonlyArray<OutRecord>): Promise<void> {
  const file = storeFile(stateDir);
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ v: 1, records }, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, file);
}

export const OUT_REASONS = {
  oldApp: (name: string) =>
    `Uno Work on ${name} doesn't take chat requests yet: it is an older version, or it hasn't been opened there since the update. Ask the person to update or open Uno Work there.`,
  neverPicked: (name: string) =>
    `${name} didn't pick it up within 2 hours (asleep, offline, or Uno Work closed there).`,
  offline: (name: string) =>
    `${name} was asleep or offline for 2 hours, so the request never got there.`,
  closedThere: (name: string) =>
    `Uno Work isn't open on ${name} right now: the request waits there until it opens (2 hours at most).`,
};

export function makeOutgoing(deps: OutgoingDeps) {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const newId = deps.newId ?? (() => `cr_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`);
  // One writer at a time: the tool and the loop share the store.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <A>(run: () => Promise<A>): Promise<A> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };

  const update = async (id: string, change: (record: OutRecord) => OutRecord) => {
    const records = await readStore(deps.stateDir);
    const next = records.map((record) => (record.id === id ? change(record) : record));
    await writeStore(deps.stateDir, next);
    return next.find((record) => record.id === id) ?? null;
  };

  const settle = (
    record: OutRecord,
    status: ChatRequestStatus,
    reason: string | null,
  ): OutRecord => ({
    ...record,
    status,
    reason,
    updatedAt: new Date(nowMs()).toISOString(),
  });

  /**
   * Deliver one request to its computer, which is online: refused at once by
   * what Uno Work there says, else written into its `in/`.
   */
  const deliver = async (record: OutRecord): Promise<OutRecord> => {
    const hostState = decodeHostState(
      parseJson(await deps.read(record.computerId, remotePaths.state)),
    );
    if (hostState._tag === "None") {
      return settle(record, "refused", OUT_REASONS.oldApp(record.computerName));
    }
    if (!hostState.value.allow) {
      return settle(
        record,
        "refused",
        "The person turned off chat requests on that computer (Settings → Computer). Don't ask again; tell them if it matters.",
      );
    }
    if (hostState.value.active >= hostState.value.limit) {
      return settle(
        record,
        "refused",
        `${hostState.value.limit} requests are already waiting or working on that computer. Try again when one of them is done.`,
      );
    }
    await deps.write(
      record.computerId,
      remotePaths.request(record.id),
      JSON.stringify(record.request, null, 2),
    );
    const stale = ms(hostState.value.seenAt) + CHAT_REQUESTS_STATE_FRESH_MS < nowMs();
    return {
      ...settle(record, "waiting", stale ? OUT_REASONS.closedThere(record.computerName) : null),
      deliveredAt: new Date(nowMs()).toISOString(),
    };
  };

  const messageOf = (record: OutRecord): string => {
    switch (record.status) {
      case "queued":
        return `${record.computerName} is asleep or offline. The request waits here and goes there as soon as it is back (2 hours at most). You'll hear how it went in this chat; don't ask again.`;
      case "waiting":
        return `${record.request.title}: the person sees it in Uno Work on ${record.computerName} with Start and Decline; it waits 2 hours at most. You'll hear the answer in this chat. Don't ask again, and don't wait in a loop: end your turn or go on with other work.${record.reason ? ` ${record.reason}` : ""}`;
      case "refused":
        return `Refused at once: ${record.reason ?? ""}`;
      default:
        return `It is ${record.status}.`;
    }
  };

  const ask = (input: AskInput): Promise<AskResult> =>
    serial(async () => {
      const now = nowMs();
      const id = newId();
      const createdAt = new Date(now).toISOString();
      const expiresAt = new Date(now + CHAT_REQUEST_WAIT_MS).toISOString();
      const request: ChatRequestFile = {
        v: 1,
        id,
        createdAt,
        expiresAt,
        from: {
          computerName: (await deps.ownName()).slice(0, 200),
          boxId: await deps.ownBoxId(),
          threadId: input.threadId,
          threadTitle: input.threadTitle.slice(0, 200),
        },
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        runtimeMode: input.runtimeMode,
        title: input.title,
        gist: input.gist,
        brief: input.brief,
      };
      let record: OutRecord = {
        id,
        computerId: input.computer.id,
        computerName: input.computer.name,
        threadId: input.threadId,
        status: "queued",
        reason: null,
        createdAt,
        expiresAt,
        deliveredAt: null,
        updatedAt: createdAt,
        request,
        thread: null,
        // Refused at once is said in the tool's answer, not again as a note.
        told: null,
      };
      if (input.computer.online) record = await deliver(record);
      if (record.status === "refused") record = { ...record, told: "refused" };
      await writeStore(deps.stateDir, [record, ...(await readStore(deps.stateDir))]);
      await deps
        .note(
          input.computer.id,
          `Asked to start a chat: ${input.title} (${record.status})`,
          input.threadId,
        )
        .catch(() => undefined);
      return {
        requestId: id,
        status: record.status,
        message: messageOf(record),
        ...(record.reason ? { reason: record.reason } : {}),
      };
    });

  /** Read the answer there: the record as it is now. */
  const poll = async (record: OutRecord): Promise<OutRecord> => {
    const answer = decodeAnswer(
      parseJson(await deps.read(record.computerId, remotePaths.answer(record.id))),
    );
    if (answer._tag === "None") {
      if (record.status === "waiting" && ms(record.expiresAt) + PICKUP_GRACE_MS < nowMs()) {
        return settle(record, "expired", OUT_REASONS.neverPicked(record.computerName));
      }
      return record;
    }
    const value = answer.value;
    if (
      value.status === record.status &&
      value.updatedAt === record.updatedAt &&
      JSON.stringify(value.thread) === JSON.stringify(record.thread)
    ) {
      return record;
    }
    return {
      ...record,
      status: value.status === "queued" ? record.status : value.status,
      reason: value.reason,
      updatedAt: value.updatedAt,
      thread: value.thread,
    };
  };

  const live = (record: OutRecord, now: number) =>
    record.status === "queued" ||
    record.status === "waiting" ||
    (record.status === "started" && ms(record.createdAt) + FOLLOW_MS > now);

  /** One round: deliver, read answers, tell the chats. */
  const tick = (): Promise<void> =>
    serial(async () => {
      const now = nowMs();
      const records = await readStore(deps.stateDir);
      if (!records.some((record) => live(record, now) || tellKey(record) !== record.told)) {
        const kept = records.filter((record) => ms(record.updatedAt) + KEEP_MS > now);
        if (kept.length !== records.length) await writeStore(deps.stateDir, kept);
        return;
      }
      const computers = await deps.computers().catch(() => null);
      const online = new Set(
        (computers ?? []).filter((computer) => computer.online).map((computer) => computer.id),
      );
      const next: Array<OutRecord> = [];
      for (const record of records) {
        let current = record;
        try {
          if (current.status === "queued") {
            if (ms(current.expiresAt) <= now) {
              current = settle(current, "expired", OUT_REASONS.offline(current.computerName));
            } else if (online.has(current.computerId)) {
              current = await deliver(current);
            }
          } else if (live(current, now) && online.has(current.computerId)) {
            current = await poll(current);
          } else if (
            current.status === "waiting" &&
            ms(current.expiresAt) + PICKUP_GRACE_MS < now
          ) {
            current = settle(current, "expired", OUT_REASONS.neverPicked(current.computerName));
          }
        } catch {
          // Unreachable for now: next round.
        }
        const key = tellKey(current);
        if (key !== null && key !== current.told) {
          const told = await deps
            .tell(current.threadId, tellText(current))
            .catch(() => "busy" as const);
          if (told !== "busy") current = { ...current, told: key };
        }
        if (FINAL.has(current.status) && ms(current.updatedAt) + KEEP_MS < now) continue;
        next.push(current);
      }
      await writeStore(deps.stateDir, next);
    });

  /** This chat's requests (or one), read afresh where the computer is online. */
  const lookup = (input: { readonly threadId: string; readonly requestId?: string | undefined }) =>
    serial(async () => {
      const records = (await readStore(deps.stateDir)).filter(
        (record) =>
          record.threadId === input.threadId &&
          (input.requestId === undefined || record.id === input.requestId),
      );
      const fresh: Array<OutRecord> = [];
      for (const record of records) {
        if (record.status === "waiting" || record.status === "started") {
          const polled = await poll(record).catch(() => record);
          if (polled !== record) await update(record.id, () => polled);
          fresh.push(polled);
        } else {
          fresh.push(record);
        }
      }
      return fresh.map(viewForAgent);
    });

  return { ask, tick, lookup, readStore: () => readStore(deps.stateDir) };
}

export type Outgoing = ReturnType<typeof makeOutgoing>;
