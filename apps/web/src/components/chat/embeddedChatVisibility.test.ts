import type { MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import {
  filterTimelineEntriesForVisibility,
  isEmbeddedChatVisibility,
  showsTimeline,
} from "./embeddedChatVisibility";

const message = (id: string, overrides: Partial<ChatMessage>): ChatMessage =>
  ({
    role: "assistant",
    text: "ok",
    createdAt: "2026-08-24T09:00:00.000Z",
    streaming: false,
    turnId: "turn-1" as TurnId,
    ...overrides,
    id: id as MessageId,
  }) as ChatMessage;

const messageEntry = (id: string, overrides: Partial<ChatMessage> = {}): TimelineEntry =>
  ({
    id,
    kind: "message",
    createdAt: "2026-08-24T09:00:00.000Z",
    message: message(id, overrides),
  }) as TimelineEntry;

const workEntry = (id: string): TimelineEntry =>
  ({
    id,
    kind: "work",
    createdAt: "2026-08-24T09:00:00.000Z",
    entry: { id, kind: "command", label: "npm test" },
  }) as unknown as TimelineEntry;

const planEntry = (id: string): TimelineEntry =>
  ({
    id,
    kind: "proposed-plan",
    createdAt: "2026-08-24T09:00:00.000Z",
    proposedPlan: { id, planMarkdown: "# план" },
  }) as unknown as TimelineEntry;

const entries: TimelineEntry[] = [
  messageEntry("user-1", { role: "user", text: "сделай" }),
  workEntry("work-1"),
  // Пустая заготовка ответа: модель ещё ходит по инструментам.
  messageEntry("assistant-empty", { text: "  ", streaming: true }),
  workEntry("work-2"),
  messageEntry("assistant-1", { text: "готово" }),
  planEntry("plan-1"),
];

describe("filterTimelineEntriesForVisibility", () => {
  it("keeps everything in full mode (same array — без лишних ре-рендеров)", () => {
    expect(filterTimelineEntriesForVisibility(entries, "full")).toBe(entries);
  });

  it("drops the timeline entirely in composer-only mode", () => {
    expect(filterTimelineEntriesForVisibility(entries, "composer-only")).toEqual([]);
    expect(showsTimeline("composer-only")).toBe(false);
    expect(showsTimeline("answers-only")).toBe(true);
  });

  it("hides tool noise and empty assistant placeholders in answers-only mode", () => {
    const visible = filterTimelineEntriesForVisibility(entries, "answers-only");
    expect(visible.map((entry) => entry.id)).toEqual(["user-1", "assistant-1", "plan-1"]);
  });

  it("keeps system messages out of answers-only mode", () => {
    const withSystem = [messageEntry("system-1", { role: "system", text: "сессия перезапущена" })];
    expect(filterTimelineEntriesForVisibility(withSystem, "answers-only")).toEqual([]);
  });

  it("guards manifest values", () => {
    expect(isEmbeddedChatVisibility("answers-only")).toBe(true);
    expect(isEmbeddedChatVisibility("answers only")).toBe(false);
  });
});
