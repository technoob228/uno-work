import { describe, expect, it } from "vitest";

import { doneShelfLabel, threadContextMenuItems } from "./simpleSidebar.logic";

const ALL = [
  { id: "rename", label: "Rename chat" },
  { id: "pin", label: "Pin chat" },
  { id: "settle", label: "Settle chat" },
  { id: "snooze", label: "Snooze" },
  { id: "mark-unread", label: "Mark unread" },
  { id: "copy-path", label: "Copy Path" },
  { id: "copy-thread-id", label: "Copy chat ID" },
  { id: "continue-on-machine", label: "Continue on another machine…" },
  { id: "agents-access", label: "Don't let agents write here" },
  { id: "archive", label: "Archive" },
  { id: "delete", label: "Delete", destructive: true },
];

describe("threadContextMenuItems", () => {
  it("keeps four items and the agents switch without Dev mode", () => {
    expect(threadContextMenuItems(ALL, false).map((item) => item.id)).toEqual([
      "rename",
      "pin",
      "agents-access",
      "archive",
      "delete",
    ]);
  });

  it("keeps everything in Dev mode", () => {
    expect(threadContextMenuItems(ALL, true)).toHaveLength(ALL.length);
  });
});

describe("doneShelfLabel", () => {
  it("counts while folded", () => {
    expect(doneShelfLabel(3, false)).toBe("Done (3)");
    expect(doneShelfLabel(3, true)).toBe("Done");
  });
});
