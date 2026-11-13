import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary } from "./types";
import { unreadAnswersFromInbox, withUnreadAnswers } from "./unreadAnswers";

const item = (
  threadId: string,
  body: string,
  extra: { readAt?: string | null; updatedAt?: string; kind?: "agent.done" | "agent.input" } = {},
) => ({
  kind: extra.kind ?? ("agent.done" as const),
  body,
  readAt: extra.readAt ?? null,
  updatedAt: extra.updatedAt ?? "2026-11-13T10:00:00.000Z",
  open: { kind: "thread" as const, threadId: ThreadId.make(threadId) },
});

const summary = (id: string): SidebarThreadSummary =>
  ({
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make("env"),
    projectId: ProjectId.make("p"),
  }) as SidebarThreadSummary;

describe("unread answers (Misha 13.11)", () => {
  it("takes the unread 'Answer to your question' items, not Finished or read ones", () => {
    const answers = unreadAnswersFromInbox([
      item("a", "Answer to your question: three plans."),
      item("b", "Answer to your question: done.", { readAt: "2026-11-13T11:00:00.000Z" }),
      item("c", "Finished — done."),
      item("d", "Needs you: pick one", { kind: "agent.input" }),
    ]);
    expect([...answers]).toEqual([["a", "2026-11-13T10:00:00.000Z"]]);
  });

  it("puts them on the summaries and takes them off, keeping the record when nothing changed", () => {
    const byId = { a: summary("a"), b: summary("b") } as Record<ThreadId, SidebarThreadSummary>;
    const answers = new Map([[ThreadId.make("a"), "2026-11-13T10:00:00.000Z"]]);
    const marked = withUnreadAnswers(byId, answers);
    expect(marked[ThreadId.make("a")]?.unreadAnswerAt).toBe("2026-11-13T10:00:00.000Z");
    expect(marked[ThreadId.make("b")]).toBe(byId[ThreadId.make("b")]);
    expect(withUnreadAnswers(marked, answers)).toBe(marked);
    const cleared = withUnreadAnswers(marked, new Map());
    expect(cleared[ThreadId.make("a")]?.unreadAnswerAt).toBeUndefined();
  });
});
