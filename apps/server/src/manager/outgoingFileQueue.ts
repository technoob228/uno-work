/**
 * Files `send_file` asked to send with a conversation's current reply
 * (Telegram / Slack). The reply loop (`connectorReplies.ts`) takes them with
 * the turn's answer, after the `[[send-file: …]]` ones. In memory: a daemon
 * restart drops a file not sent yet (the person asks again). Entries older
 * than {@link QUEUED_FILE_TTL_MS} are dropped.
 *
 * @module manager/outgoingFileQueue
 */
export const QUEUED_FILE_TTL_MS = 30 * 60_000;
const MAX_FILES_PER_THREAD = 10;

interface QueuedFile {
  readonly path: string;
  readonly atMs: number;
}

const queued = new Map<string, Array<QueuedFile>>();

/** False: too many waiting already. */
export function queueOutgoingFile(threadId: string, path: string, nowMs = Date.now()): boolean {
  const live = (queued.get(threadId) ?? []).filter(
    (file) => nowMs - file.atMs < QUEUED_FILE_TTL_MS,
  );
  if (live.some((file) => file.path === path)) return true;
  if (live.length >= MAX_FILES_PER_THREAD) return false;
  queued.set(threadId, [...live, { path, atMs: nowMs }]);
  return true;
}

/** The thread's waiting files (fresh ones), removed from the queue. */
export function takeOutgoingFiles(threadId: string, nowMs = Date.now()): ReadonlyArray<string> {
  const files = queued.get(threadId);
  if (files === undefined) return [];
  queued.delete(threadId);
  return files.filter((file) => nowMs - file.atMs < QUEUED_FILE_TTL_MS).map((file) => file.path);
}
