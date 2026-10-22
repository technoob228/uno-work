/**
 * What an assistant sent from its own address (`assistantMail.ts`): how many
 * letters today — its own daily limit, under the console's per-mailbox one —
 * and the ids of its letters, so it sees what it sent and nobody else's.
 *
 * `<stateDir>/assistants/<id>/mail.json`, next to `team.json`: the daemon's,
 * not in the folder the assistant writes. Plain async I/O, one write at a
 * time per file; the pure parts are tested directly.
 *
 * @module assistants/mailLedger
 */
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";

import { mailDay } from "@t3tools/shared/assistantMail";

/** How many of its newest letters' ids are kept. */
export const MAIL_LEDGER_IDS_LIMIT = 500;

export interface MailLedger {
  /** The UTC day `sentToday` counts. */
  readonly day: string;
  readonly sentToday: number;
  /** Ids (the console's) of letters it sent, newest last. */
  readonly sentIds: ReadonlyArray<string>;
  /** Their Message-IDs, for replies (`in_reply_to`). */
  readonly messageIds: ReadonlyArray<string>;
}

const EMPTY: MailLedger = { day: "", sentToday: 0, sentIds: [], messageIds: [] };

const ledgerFile = (stateDir: string, projectId: string) =>
  nodePath.join(stateDir, "assistants", encodeURIComponent(projectId), "mail.json");

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.length <= 300)
        .slice(-MAIL_LEDGER_IDS_LIMIT)
    : [];

export function normalizeLedger(raw: unknown): MailLedger {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return EMPTY;
  const record = raw as Record<string, unknown>;
  return {
    day: typeof record.day === "string" ? record.day.slice(0, 10) : "",
    sentToday:
      typeof record.sentToday === "number" && Number.isFinite(record.sentToday)
        ? Math.max(0, Math.floor(record.sentToday))
        : 0,
    sentIds: strings(record.sentIds),
    messageIds: strings(record.messageIds),
  };
}

/** Letters sent on `now`'s UTC day (yesterday's count is 0 today). */
export function sentOn(ledger: MailLedger, now: Date): number {
  return ledger.day === mailDay(now) ? ledger.sentToday : 0;
}

/** The ledger with one more letter. */
export function withSent(
  ledger: MailLedger,
  letter: { readonly id: string | null; readonly messageId: string | null },
  now: Date,
): MailLedger {
  const day = mailDay(now);
  return {
    day,
    sentToday: (ledger.day === day ? ledger.sentToday : 0) + 1,
    sentIds: (letter.id ? [...ledger.sentIds, letter.id] : ledger.sentIds).slice(
      -MAIL_LEDGER_IDS_LIMIT,
    ),
    messageIds: (letter.messageId
      ? [...ledger.messageIds, letter.messageId]
      : ledger.messageIds
    ).slice(-MAIL_LEDGER_IDS_LIMIT),
  };
}

export async function readMailLedger(stateDir: string, projectId: string): Promise<MailLedger> {
  try {
    return normalizeLedger(JSON.parse(await fsp.readFile(ledgerFile(stateDir, projectId), "utf8")));
  } catch {
    return EMPTY;
  }
}

const queues = new Map<string, Promise<unknown>>();

export function recordMailSent(
  stateDir: string,
  projectId: string,
  letter: { readonly id: string | null; readonly messageId: string | null },
  now: Date,
): Promise<MailLedger> {
  const file = ledgerFile(stateDir, projectId);
  const previous = queues.get(file) ?? Promise.resolve();
  const task = async () => {
    const next = withSent(await readMailLedger(stateDir, projectId), letter, now);
    await fsp.mkdir(nodePath.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(next)}\n`, "utf8");
    await fsp.rename(temporary, file);
    return next;
  };
  const next = previous.then(task, task);
  queues.set(
    file,
    next.catch(() => undefined),
  );
  return next;
}
