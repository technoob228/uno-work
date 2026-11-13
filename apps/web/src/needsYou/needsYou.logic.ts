// Needs you (Misha 13.11, the Pult redo): one screen that answers "am I
// needed?" from what Work already knows — chats that wait on the person
// (an approval, a question, an agent called them in), results to accept and
// questions the agents filed in the tracker — and says in one line how much
// of the person's time it is. Everything else (chats working, chats waiting
// on their own tasks, agents talking among themselves) is one quiet line.
// Pure, so the screen, the sidebar's count and the tests say the same thing.
import { isAssistantProjectId } from "@t3tools/contracts";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { isPersonCallPending, isWaitingOnAgents } from "../components/Sidebar.owner";
import { yourTurnKind } from "../components/Sidebar.yourTurn";
import { threadKey } from "../inbox/inboxActions.logic";
import type { SidebarThreadSummary } from "../types";
import type { AskAnswer, ExternalAsk, QuestionAsk, ReviewAsk } from "./externalAsks";

type Thread = SidebarThreadSummary;

/**
 * - `decide` — an approval or a question with answers: one tap;
 * - `accept` — a finished result to look at: before / after, Accept or not;
 * - `look`   — an agent called the person into a chat (sign in, look, say);
 * - `ready`  — a chat finished what the person asked: read when you like.
 */
export type NeedsYouSection = "decide" | "accept" | "look" | "ready";

export const SECTION_ORDER: ReadonlyArray<NeedsYouSection> = ["decide", "accept", "look", "ready"];

export const SECTION_TITLE: Readonly<Record<NeedsYouSection, string>> = {
  decide: "Decide",
  accept: "Accept the result",
  look: "Asked you into a chat",
  ready: "Finished what you asked",
};

/** About how long each takes the person, in minutes — what the verdict adds up. */
export const MINUTES: Readonly<Record<NeedsYouRow["type"], number>> = {
  approval: 1,
  question: 1,
  "ask-question": 1,
  review: 3,
  call: 2,
  ready: 1,
};

interface RowBase {
  readonly key: string;
  readonly section: NeedsYouSection;
  /** When it started waiting (ISO). */
  readonly at: string;
  /** Where it is, in people's words: "Checkout · task of Pricing page". */
  readonly where: string;
}

export type NeedsYouRow =
  | (RowBase & { readonly type: "approval" | "question" | "ready"; readonly thread: Thread })
  | (RowBase & { readonly type: "call"; readonly thread: Thread; readonly reason: string })
  | (RowBase & { readonly type: "ask-question"; readonly ask: QuestionAsk })
  | (RowBase & { readonly type: "review"; readonly ask: ReviewAsk });

export interface NeedsYouBoard {
  readonly sections: ReadonlyArray<{
    readonly section: NeedsYouSection;
    readonly rows: ReadonlyArray<NeedsYouRow>;
  }>;
  /** Things that need the person (Ready is not counted: nothing is stuck on them). */
  readonly count: number;
  /** About how many minutes those take. */
  readonly minutes: number;
  /** Chats working right now. */
  readonly working: ReadonlyArray<Thread>;
  /** The person's chats waiting on their agents' tasks. */
  readonly waitingOnAgents: ReadonlyArray<Thread>;
  /** Answered here in this session ("Sent"), so the row doesn't just vanish. */
  readonly answered: number;
}

export interface NeedsYouInput {
  readonly threads: ReadonlyArray<Thread>;
  readonly asks: ReadonlyArray<ExternalAsk>;
  readonly answered: Readonly<Record<string, AskAnswer>>;
  /** Questions skipped for now (their Inbox item is snoozed): `environmentId:threadId`. */
  readonly skippedQuestions: ReadonlySet<string>;
  readonly now: string;
}

function isListed(thread: Thread): boolean {
  // An import of a hundred chats is not a hundred things waiting on the person.
  return thread.archivedAt === null && thread.source == null;
}

/** "Checkout: Stripe test mode · task of Pricing page" — a task names its chat. */
export function whereOf(thread: Thread, byId: ReadonlyMap<string, Thread>): string {
  const parentId = thread.spawnedByThreadId;
  const parent = parentId ? byId.get(`${thread.environmentId}:${parentId}`) : undefined;
  if (parent && parent.archivedAt === null && !isAssistantProjectId(parent.projectId)) {
    return `task of “${parent.title}”`;
  }
  if (isAssistantProjectId(thread.projectId)) return "Uno";
  return "";
}

const waitingSince = (thread: Thread) =>
  thread.updatedAt ?? thread.latestTurn?.completedAt ?? thread.createdAt;

export function buildNeedsYouBoard(input: NeedsYouInput): NeedsYouBoard {
  const byId = new Map(
    input.threads.map((thread) => [threadKey(thread.environmentId, thread.id), thread]),
  );
  const rows: NeedsYouRow[] = [];
  const working: Thread[] = [];
  const waitingOnAgents: Thread[] = [];

  for (const thread of input.threads) {
    if (!isListed(thread)) continue;
    const key = threadKey(thread.environmentId, thread.id);
    const where = whereOf(thread, byId);
    if (thread.hasPendingApprovals) {
      rows.push({
        key,
        section: "decide",
        type: "approval",
        thread,
        at: waitingSince(thread),
        where,
      });
      continue;
    }
    if (thread.hasPendingUserInput) {
      if (!input.skippedQuestions.has(key)) {
        rows.push({
          key,
          section: "decide",
          type: "question",
          thread,
          at: waitingSince(thread),
          where,
        });
      }
      continue;
    }
    const turn = yourTurnKind(thread, input.now);
    if (turn === "called" && isPersonCallPending(thread)) {
      rows.push({
        key,
        section: "look",
        type: "call",
        thread,
        reason: thread.personCallReason?.trim() || "An agent asked you to look at this chat.",
        at: thread.personCalledAt ?? waitingSince(thread),
        where,
      });
      continue;
    }
    if (turn === "ready") {
      rows.push({
        key,
        section: "ready",
        type: "ready",
        thread,
        at: thread.latestTurn?.completedAt ?? waitingSince(thread),
        where,
      });
      continue;
    }
    if (resolveSidebarThreadStatus(thread) === "working") working.push(thread);
    else if (isWaitingOnAgents(thread)) waitingOnAgents.push(thread);
  }

  let answered = 0;
  for (const ask of input.asks) {
    if (input.answered[ask.id]) {
      answered += 1;
      continue;
    }
    if (ask.kind === "question") {
      rows.push({
        key: `ask:${ask.id}`,
        section: "decide",
        type: "ask-question",
        ask,
        at: ask.createdAt,
        where: ask.from,
      });
    } else {
      rows.push({
        key: `ask:${ask.id}`,
        section: "accept",
        type: "review",
        ask,
        at: ask.createdAt,
        where: ask.from,
      });
    }
  }

  const sections = SECTION_ORDER.map((section) => ({
    section,
    // Oldest first: what waited longest is the one to clear.
    rows: rows
      .filter((row) => row.section === section)
      .toSorted((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key)),
  })).filter((group) => group.rows.length > 0);

  const needed = rows.filter((row) => row.section !== "ready");
  return {
    sections,
    count: needed.length,
    minutes: needed.reduce((sum, row) => sum + MINUTES[row.type], 0),
    working,
    waitingOnAgents,
    answered,
  };
}

/** The verdict on top: "You're needed in 3 places · about 5 min" / "You're not needed right now". */
export function needsYouVerdict(board: Pick<NeedsYouBoard, "count" | "minutes">): string {
  if (board.count === 0) return "You're not needed right now";
  const places = board.count === 1 ? "1 place" : `${board.count} places`;
  return `You're needed in ${places} · about ${board.minutes} min`;
}

/** "4 chats working · 1 waiting on its tasks" — what goes on without the person. */
export function quietLine(board: Pick<NeedsYouBoard, "working" | "waitingOnAgents">): string {
  const parts: string[] = [];
  const w = board.working.length;
  const a = board.waitingOnAgents.length;
  if (w > 0) parts.push(`${w} ${w === 1 ? "chat" : "chats"} working`);
  if (a > 0) parts.push(`${a} waiting on ${a === 1 ? "its" : "their"} tasks`);
  return parts.length === 0 ? "Nothing is running" : `${parts.join(" · ")} — without you`;
}
