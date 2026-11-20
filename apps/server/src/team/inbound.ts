/**
 * T51 (a): a colleague wrote in a chat the person shared with "Can write":
 * their message goes into the chat here as outside text (T49) and starts a
 * turn, like the person's own would.
 *
 * - `GET chats/inbound?source=` long-polls (25 s) while nothing waits here;
 *   while something does, it asks every few seconds without waiting.
 * - A message is checked again here: the chat must be one this computer
 *   mirrors, shared with that colleague for writing.
 * - The chat is marked as holding outside text first, then the turn starts
 *   with the colleague's words fenced (teamNotes.logic.ts). A chat at work
 *   (a turn running, waiting for the person) gets it when it is free; after
 *   an hour of waiting, or when the chat is gone, the cloud hears "failed".
 * - Acked once: delivered or failed. What was delivered is remembered, so a
 *   restart never delivers twice.
 *
 * @module team/inbound
 */
import { outsideNonce } from "../automations/prompt.ts";
import type { TeamPorts } from "./ports.ts";
import type { ShareMirror } from "./shareMirror.ts";
import { LONG_POLL_WAIT_S, TeamCloudError } from "./teamCloud.ts";
import { personName, type InboundMessage } from "./teamCloud.logic.ts";
import { asRecord, readTeamFile, writeTeamFile } from "./teamFiles.ts";
import { colleagueMessageNote } from "./teamNotes.logic.ts";

const FILE = "inbound.json";
/** A busy chat gets a colleague's message within this long, or the cloud hears it failed. */
export const INBOUND_BUSY_MAX_MS = 60 * 60_000;
const DELIVERED_KEEP = 500;

interface Waiting {
  readonly message: InboundMessage;
  readonly firstSeenAt: number;
}

export function makeInbound(ports: TeamPorts, mirror: ShareMirror) {
  const waiting = new Map<number, Waiting>();
  let delivered: Array<number> | null = null;
  const load = async () =>
    (delivered ??= await readTeamFile(ports.stateDir, FILE, (raw) => {
      const list = asRecord(raw)["delivered"];
      return Array.isArray(list) ? list.filter((id): id is number => typeof id === "number") : [];
    }));
  const remember = async (id: number) => {
    const list = await load();
    list.push(id);
    if (list.length > DELIVERED_KEEP) list.splice(0, list.length - DELIVERED_KEEP);
    await writeTeamFile(ports.stateDir, FILE, { delivered: list });
  };

  const ack = async (id: number, status: "delivered" | "failed", reason?: string) => {
    await ports.cloud.ackInbound(id, status, reason);
    waiting.delete(id);
    await remember(id);
  };

  /** One message: delivered, failed, or still waiting for its chat. */
  const deliver = async (entry: Waiting) => {
    const message = entry.message;
    let shared = mirror.chat(message.chatId);
    if (shared === null) {
      await mirror.refresh();
      shared = mirror.chat(message.chatId);
    }
    const canWrite =
      shared !== null &&
      shared.threadId === message.threadId &&
      shared.shares.some(
        (share) => share.userId === message.from.userId && share.level === "write",
      );
    if (!canWrite) {
      await ack(
        message.id,
        "failed",
        "That chat isn't shared with them for writing on this computer.",
      );
      return;
    }
    const thread = await ports.thread(message.threadId);
    if (thread === null) {
      await ack(message.id, "failed", "The chat isn't on this computer any more.");
      return;
    }
    if (thread.busy) {
      if (ports.now() - entry.firstSeenAt > INBOUND_BUSY_MAX_MS) {
        await ack(message.id, "failed", "The chat was busy for an hour.");
      }
      return;
    }
    await ports.markOutside(message.threadId);
    const told = await ports.tell(
      message.threadId,
      colleagueMessageNote({
        fromName: personName(message.from),
        projectName: shared!.projectName,
        text: message.text,
        nonce: outsideNonce(),
      }),
    );
    if (told === "told") await ack(message.id, "delivered");
    else if (told === "gone")
      await ack(message.id, "failed", "The chat isn't on this computer any more.");
  };

  /** One round: what the cloud has for this computer's chats, then each waiting one. */
  const round = async (): Promise<void> => {
    const parts = await ports.parts.get();
    if (!parts.share) {
      waiting.clear();
      await ports.sleep(60_000);
      return;
    }
    const source = await ports.source();
    let messages: ReadonlyArray<InboundMessage>;
    try {
      messages = await ports.cloud.inbound(source, waiting.size > 0 ? 0 : LONG_POLL_WAIT_S);
    } catch (error) {
      if (error instanceof TeamCloudError && error.off) {
        ports.parts.markOff();
        return;
      }
      throw error;
    }
    const done = new Set(await load());
    for (const message of messages) {
      if (done.has(message.id)) {
        // Delivered before a restart, the ack lost: say it again.
        await ports.cloud.ackInbound(message.id, "delivered").catch(() => undefined);
        continue;
      }
      if (!waiting.has(message.id)) {
        waiting.set(message.id, { message, firstSeenAt: ports.now() });
      }
    }
    for (const entry of [...waiting.values()].toSorted((a, b) => a.message.id - b.message.id)) {
      try {
        await deliver(entry);
      } catch (error) {
        ports.error("inbound", error instanceof Error ? error.message : String(error));
      }
    }
    if (waiting.size > 0) await ports.sleep(3_000);
  };

  return { round, waitingCount: () => waiting.size };
}
