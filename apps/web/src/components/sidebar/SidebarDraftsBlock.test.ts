import { describe, expect, it } from "vitest";

import { unsentDrafts } from "./SidebarDraftsBlock";

const draft = (prompt: string, pictures = 0) =>
  ({ prompt, images: Array(pictures).fill({}), persistedAttachments: [] }) as never;

describe("unsentDrafts", () => {
  it("lists boxes with something typed, by their first line", () => {
    const rows = unsentDrafts({
      drafts: { "env:t1": draft("fix header\nand footer"), d1: draft("new task"), d2: draft("  ") },
      sessions: { d1: {} as never, d2: {} as never },
      onScreenKey: null,
    });
    expect(rows).toEqual([
      {
        key: "env:t1",
        preview: "fix header",
        open: { kind: "chat", ref: { environmentId: "env", threadId: "t1" } },
      },
      { key: "d1", preview: "new task", open: { kind: "draft", draftId: "d1" } },
    ]);
  });

  it("names a box with only pictures", () => {
    const rows = unsentDrafts({ drafts: { d1: draft("", 2) }, sessions: {}, onScreenKey: null });
    expect(rows).toEqual([]);
    expect(
      unsentDrafts({
        drafts: { d1: draft("", 2) },
        sessions: { d1: {} as never },
        onScreenKey: null,
      })[0]?.preview,
    ).toBe("2 pictures");
  });

  it("skips the box on screen and a draft on its way", () => {
    expect(
      unsentDrafts({
        drafts: { d1: draft("a"), d2: draft("b") },
        sessions: { d1: {} as never, d2: { promotedTo: {} } as never },
        onScreenKey: "d1",
      }),
    ).toEqual([]);
  });
});
