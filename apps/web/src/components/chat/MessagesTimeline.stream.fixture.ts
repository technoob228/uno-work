import { MessageId, TurnId } from "@t3tools/contracts";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import type { TimelineLatestTurn } from "./MessagesTimeline.logic";

/**
 * One agent turn as the chat receives it, frame by frame (T67, 24.11): a
 * thought, two reads, a long note streamed in chunks, two commands, a short
 * final answer, the end of the turn. Browser tests replay it against the real
 * list to see what moves under the reader.
 */

const T0 = Date.parse("2026-11-24T12:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

export const STREAM_TURN_ID = TurnId.make("turn-calm");
const PREVIOUS_TURN_ID = TurnId.make("turn-before");

export const NOTE_PARAGRAPHS = Array.from(
  { length: 9 },
  (_, index) =>
    `Paragraph ${index + 1}. The agent explains what it found in the project, step by step, ` +
    `so the person can read it while the rest is still being written. This sentence is long ` +
    `enough to wrap over a couple of lines on a phone and on a laptop alike.`,
);
const ANSWER_PARAGRAPHS = [
  "Done. The bot answers on /start and keeps the token in .env.",
  "Run it with npm start; the log says where it listens.",
];

export interface StreamFrame {
  readonly label: string;
  readonly timelineEntries: TimelineEntry[];
  readonly isWorking: boolean;
  readonly latestTurn: TimelineLatestTurn;
}

function work(id: string, seconds: number, entry: Partial<WorkLogEntry>): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt: at(seconds),
    entry: {
      id,
      createdAt: at(seconds),
      label: "Ran command",
      tone: "tool",
      turnId: STREAM_TURN_ID,
      ...entry,
    },
  };
}

function message(
  id: string,
  role: "user" | "assistant",
  seconds: number,
  text: string,
  options: { streaming?: boolean; completedAt?: number; turnId?: TurnId } = {},
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: at(seconds),
    message: {
      id: MessageId.make(id),
      role,
      text,
      createdAt: at(seconds),
      streaming: options.streaming ?? false,
      ...(options.completedAt !== undefined ? { completedAt: at(options.completedAt) } : {}),
      ...(role === "assistant" ? { turnId: options.turnId ?? STREAM_TURN_ID } : {}),
    },
  };
}

/** An earlier exchange, so the chat has history above the turn. */
const HISTORY: TimelineEntry[] = [
  message("u-0", "user", -120, "Hi! Can you look at my bot project?"),
  message(
    "a-0",
    "assistant",
    -100,
    "Sure. Tell me what you want it to do and I will look at the code.",
    { completedAt: -90, turnId: PREVIOUS_TURN_ID },
  ),
];

export const NEXT_TURN_ID = TurnId.make("turn-next");

export function buildStreamFrames(options: { nextTurn?: boolean } = {}): StreamFrame[] {
  const frames: StreamFrame[] = [];
  const running: TimelineLatestTurn = {
    turnId: STREAM_TURN_ID,
    state: "running",
    startedAt: at(0),
    completedAt: null,
  };
  const user = message("u-1", "user", 0, "Make the bot answer /start and explain what you did.");
  const thought = work("w-thought", 1, {
    label: "Thinking it through",
    detail: "…I should read the entry file first, then the config.",
    tone: "thinking",
  });
  const read1 = work("w-read-1", 2, {
    label: "Read file",
    detail: "src/index.ts",
    toolName: "Read",
    itemType: "dynamic_tool_call",
  });
  const read2 = work("w-read-2", 3, {
    label: "Read file",
    detail: "package.json",
    toolName: "Read",
    itemType: "dynamic_tool_call",
  });
  const push = (label: string, entries: TimelineEntry[], isWorking = true, turn = running) =>
    frames.push({ label, timelineEntries: [...HISTORY, ...entries], isWorking, latestTurn: turn });

  push("sent", [user]);
  push("thought", [user, thought]);
  push("read-1", [user, thought, read1]);
  push("read-2", [user, thought, read1, read2]);
  // The note streams paragraph by paragraph.
  for (let count = 1; count <= NOTE_PARAGRAPHS.length; count += 1) {
    push(`note-${count}`, [
      user,
      thought,
      read1,
      read2,
      message("a-note", "assistant", 4, NOTE_PARAGRAPHS.slice(0, count).join("\n\n"), {
        streaming: true,
      }),
    ]);
  }
  const note = message("a-note", "assistant", 4, NOTE_PARAGRAPHS.join("\n\n"), {
    completedAt: 9,
  });
  const run1 = work("w-run-1", 10, {
    label: "Ran command",
    command: "npm install",
    itemType: "command_execution",
  });
  const run2 = work("w-run-2", 11, {
    label: "Ran command",
    command: "npm test",
    itemType: "command_execution",
  });
  push("run-1", [user, thought, read1, read2, note, run1]);
  push("run-2", [user, thought, read1, read2, note, run1, run2]);
  for (let count = 1; count <= ANSWER_PARAGRAPHS.length; count += 1) {
    push(`answer-${count}`, [
      user,
      thought,
      read1,
      read2,
      note,
      run1,
      run2,
      message("a-answer", "assistant", 12, ANSWER_PARAGRAPHS.slice(0, count).join("\n\n"), {
        streaming: true,
      }),
    ]);
  }
  const answer = message("a-answer", "assistant", 12, ANSWER_PARAGRAPHS.join("\n\n"), {
    completedAt: 14,
  });
  const turnDone = [user, thought, read1, read2, note, run1, run2, answer];
  push("done", turnDone, false, { ...running, state: "completed", completedAt: at(14) });
  if (!options.nextTurn) return frames;
  // The person asks again; the new note pushes the finished turn up and away.
  const nextRunning: TimelineLatestTurn = {
    turnId: NEXT_TURN_ID,
    state: "running",
    startedAt: at(30),
    completedAt: null,
  };
  const user2 = message("u-2", "user", 30, "Now add /help too, please.");
  push("next-sent", [...turnDone, user2], true, nextRunning);
  for (let count = 1; count <= NOTE_PARAGRAPHS.length; count += 1) {
    push(
      `next-note-${count}`,
      [
        ...turnDone,
        user2,
        message("a-next", "assistant", 31, NOTE_PARAGRAPHS.slice(0, count).join("\n\n"), {
          streaming: true,
          turnId: NEXT_TURN_ID,
        }),
      ],
      true,
      nextRunning,
    );
  }
  return frames;
}
