import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { InboxEntry } from "../../inbox/inboxStore";
import { bellSections } from "./inboxBell.logic";

const NOW = Date.parse("2026-09-24T15:00:00.000Z");

function entry(overrides: Partial<InboxEntry> & { id: string }): InboxEntry {
  return {
    environmentId: EnvironmentId.make("env"),
    kind: "agent.done",
    source: { kind: "agent", id: "t1", name: "Chat", icon: null },
    title: overrides.id,
    body: null,
    open: { kind: "thread", threadId: "t1" },
    createdAt: "2026-09-24T14:00:00.000Z",
    updatedAt: "2026-09-24T14:00:00.000Z",
    count: 1,
    readAt: null,
    snoozedUntil: null,
    ...overrides,
  } as InboxEntry;
}

describe("bellSections", () => {
  const items = [
    entry({ id: "approval", kind: "agent.approval" }),
    entry({ id: "done-today" }),
    entry({ id: "old", updatedAt: "2026-09-20T10:00:00.000Z" }),
    entry({
      id: "app",
      kind: "app",
      source: { kind: "app", id: "tb", name: "Taskboard", icon: null },
      open: null,
    }),
    entry({ id: "snoozed", snoozedUntil: "2026-09-25T00:00:00.000Z" }),
  ];

  it("puts what waits for you first, then today, then earlier; hides snoozed", () => {
    const sections = bellSections(items, "all", NOW);
    expect(sections.map((section) => section.items.map((item) => item.id))).toEqual([
      ["approval"],
      ["done-today", "app"],
      ["old"],
    ]);
  });

  it("filters by chip", () => {
    const ids = (filter: Parameters<typeof bellSections>[1]) =>
      bellSections(items, filter, NOW).flatMap((section) => section.items.map((item) => item.id));
    expect(ids("needs-you")).toEqual(["approval"]);
    expect(ids("apps")).toEqual(["app"]);
    expect(ids("chats")).toEqual(["approval", "done-today", "old"]);
  });
});
