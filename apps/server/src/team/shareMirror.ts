/**
 * T51 (a): the chats the person shared, sent to the Uno cloud as they go, so
 * a colleague reads them there with their own sign-in (chats are never
 * copied between computers).
 *
 * - Which chats: `GET projects/{id}/chats?source=` for the person's team
 *   projects, every 30 s and at once on `team.refresh` (the interface nudges
 *   it after Share). Only this computer's chats that are shared with someone.
 * - What: the feed of shareMirror.logic.ts — the last 200 messages the first
 *   time, then what changed; the chat's state (running, waiting, idle).
 *   Secrets are scrubbed first (this folder's key values and token
 *   patterns). A chat changes → it goes within 2 s; a finished message or a
 *   new state at once.
 * - `409 NOT_SHARED`: nobody has it any more; it stops until shared again.
 *   Other failures wait longer each time (2 s … 5 min) and keep what is due.
 *
 * @module team/shareMirror
 */
import type { TeamChatStatus, TeamMirroredChat } from "@t3tools/contracts";

import type { TeamPorts } from "./ports.ts";
import { scrubSecrets } from "./scrub.logic.ts";
import {
  backoffMs,
  batches,
  rememberSent,
  snapshotEvents,
  STREAM_EVERY_MS,
  unsent,
  type MirrorEvent,
} from "./shareMirror.logic.ts";
import { TeamCloudError } from "./teamCloud.ts";
import { asRecord, asStringMap, readTeamFile, writeTeamFile } from "./teamFiles.ts";

const FILE = "mirror.json";

export interface MirroredChat {
  readonly chatId: number;
  readonly threadId: string;
  readonly projectId: number;
  readonly projectName: string;
  readonly title: string;
  readonly shares: ReadonlyArray<{ readonly userId: number; readonly level: "read" | "write" }>;
}

interface Tracked {
  chat: MirroredChat;
  dirty: boolean;
  urgent: boolean;
  lastFlushAt: number;
  failures: number;
  nextAt: number;
  sentStatus: TeamChatStatus | null;
  sentTitle: string | null;
  status: TeamChatStatus;
  pending: number;
  lastSentAt: string | null;
  error: string | null;
}

type SentRecord = Record<string, Record<string, string>>;

const parseSent = (raw: unknown): SentRecord => {
  const out: SentRecord = {};
  for (const [chatId, sent] of Object.entries(asRecord(asRecord(raw)["sent"]))) {
    out[chatId] = asStringMap(sent);
  }
  return out;
};

export function makeShareMirror(ports: TeamPorts) {
  const tracked = new Map<number, Tracked>();
  let sent: SentRecord | null = null;
  const loadSent = async () => (sent ??= await readTeamFile(ports.stateDir, FILE, parseSent));
  const saveSent = () => writeTeamFile(ports.stateDir, FILE, { sent: sent ?? {} });

  const clear = () => tracked.clear();

  /** Which chats of this computer are shared now (every 30 s, and on a nudge). */
  const refresh = async (): Promise<void> => {
    const parts = await ports.parts.get();
    if (!parts.share) {
      clear();
      return;
    }
    const source = await ports.source();
    let projects;
    try {
      projects = await ports.cloud.projects();
    } catch (error) {
      if (error instanceof TeamCloudError && error.off) {
        ports.parts.markOff();
        clear();
        return;
      }
      throw error;
    }
    const seen = new Set<number>();
    for (const project of projects) {
      const chats = await ports.cloud.myChats(project.id, source).catch((error: unknown) => {
        ports.error("mirror", error instanceof Error ? error.message : String(error));
        return null;
      });
      if (chats === null) {
        // Unknown this round: keep what was mirrored for this project.
        for (const entry of tracked.values()) {
          if (entry.chat.projectId === project.id) seen.add(entry.chat.chatId);
        }
        continue;
      }
      for (const chat of chats) {
        if (chat.shares.length === 0 || (chat.source !== "" && chat.source !== source)) continue;
        seen.add(chat.id);
        const next: MirroredChat = {
          chatId: chat.id,
          threadId: chat.threadId,
          projectId: project.id,
          projectName: project.name,
          title: chat.title,
          shares: chat.shares,
        };
        const known = tracked.get(chat.id);
        if (known !== undefined) {
          known.chat = next;
          // A look every round too: an event missed is sent by the next one.
          known.dirty = true;
          continue;
        }
        tracked.set(chat.id, {
          chat: next,
          dirty: true,
          urgent: true,
          lastFlushAt: 0,
          failures: 0,
          nextAt: 0,
          sentStatus: null,
          sentTitle: null,
          status: chat.status,
          pending: 0,
          lastSentAt: null,
          error: null,
        });
      }
    }
    for (const chatId of tracked.keys()) if (!seen.has(chatId)) tracked.delete(chatId);
  };

  /** Something happened in a chat here: a finished message or a new state goes at once. */
  const touch = (threadId: string, urgent: boolean) => {
    for (const entry of tracked.values()) {
      if (entry.chat.threadId !== threadId) continue;
      entry.dirty = true;
      entry.urgent ||= urgent;
    }
  };

  const flushOne = async (entry: Tracked, source: string) => {
    const now = ports.now();
    entry.dirty = false;
    entry.urgent = false;
    entry.lastFlushAt = now;
    const thread = await ports.thread(entry.chat.threadId);
    if (thread === null) {
      entry.error = "The chat isn't on this computer any more.";
      return;
    }
    entry.status = thread.status;
    const detail = await ports.threadDetail(entry.chat.threadId);
    if (detail === null) return;
    const known = thread.folder === null ? [] : await ports.folderSecrets(thread.folder);
    const events: ReadonlyArray<MirrorEvent> = snapshotEvents(
      detail.messages,
      detail.toolsByTurn,
    ).map((event) => ({ ...event, text: scrubSecrets(event.text, known).text }));
    const all = await loadSent();
    const key = String(entry.chat.chatId);
    const todo = unsent(events, all[key] ?? {});
    entry.pending = todo.length;
    const title = scrubSecrets(thread.title, known).text;
    if (todo.length === 0 && entry.sentStatus === thread.status && entry.sentTitle === title) {
      return;
    }
    const groups = todo.length === 0 ? [[]] : batches(todo);
    try {
      for (const group of groups) {
        await ports.cloud.postEvents(entry.chat.chatId, {
          source,
          title,
          status: thread.status,
          events: group.map((event) => ({
            message_id: event.messageId,
            role: event.role,
            text: event.text,
            at: event.at,
          })),
        });
        all[key] = rememberSent(all[key] ?? {}, group);
        entry.pending = Math.max(0, entry.pending - group.length);
        if (group.length > 0) await saveSent();
      }
      entry.sentStatus = thread.status;
      entry.sentTitle = title;
      entry.failures = 0;
      entry.nextAt = 0;
      entry.error = null;
      entry.lastSentAt = new Date(ports.now()).toISOString();
    } catch (error) {
      if (
        error instanceof TeamCloudError &&
        !error.off &&
        (error.code === "NOT_SHARED" || error.code === "SOURCE_MISMATCH" || error.status === 404)
      ) {
        // Not shared any more, or mirrored from another computer: stop here.
        tracked.delete(entry.chat.chatId);
        return;
      }
      if (error instanceof TeamCloudError && error.off) {
        ports.parts.markOff();
        clear();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      entry.failures += 1;
      entry.nextAt = ports.now() + backoffMs(entry.failures);
      entry.dirty = true;
      entry.error = message;
      ports.error("mirror", message);
    }
  };

  /** Each chat that changed and is due: at most every 2 s, at once when urgent. */
  const flushDue = async (): Promise<void> => {
    if (tracked.size === 0) return;
    const source = await ports.source();
    const now = ports.now();
    for (const entry of tracked.values()) {
      if (!entry.dirty || now < entry.nextAt) continue;
      if (!entry.urgent && now - entry.lastFlushAt < STREAM_EVERY_MS) continue;
      await flushOne(entry, source);
    }
  };

  const chat = (chatId: number): MirroredChat | null => tracked.get(chatId)?.chat ?? null;

  const view = (): ReadonlyArray<TeamMirroredChat> =>
    [...tracked.values()].map((entry) => ({
      chatId: entry.chat.chatId,
      threadId: entry.chat.threadId,
      title: entry.chat.title,
      projectId: entry.chat.projectId,
      projectName: entry.chat.projectName,
      sharedWith: entry.chat.shares.length,
      status: entry.status,
      pending: entry.pending,
      lastSentAt: entry.lastSentAt,
      error: entry.error,
    }));

  return { refresh, touch, flushDue, chat, view, clear };
}

export type ShareMirror = ReturnType<typeof makeShareMirror>;
