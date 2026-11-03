import { describe, expect, it } from "vitest";

import { AccountHttpError } from "../account/unoAccount";
import { deleteRefusal } from "./backend";
import { ownComputerChatState } from "./chatState";

const computer = { computerId: "41", computerName: "MacBook", path: "/Users/misha/projects/app" };

describe("ownComputerChatState", () => {
  it("waits while the turn waits for the computer", () => {
    const since = "2026-11-03T10:00:00.000Z";
    expect(
      ownComputerChatState({
        computer,
        wait: { computerId: "41", computerName: "MacBook", since },
        own: [{ id: "41", purpose: "full" }],
      }),
    ).toEqual({ kind: "waiting", name: "MacBook", since });
  });

  it("goes on when the computer is a full computer", () => {
    expect(
      ownComputerChatState({ computer, wait: null, own: [{ id: "41", purpose: "full" }] }),
    ).toBeNull();
  });

  it("can't go on there when it's a tool now, or was removed", () => {
    expect(
      ownComputerChatState({ computer, wait: null, own: [{ id: "41", purpose: "tool" }] }),
    ).toEqual({ kind: "tool", name: "MacBook" });
    expect(ownComputerChatState({ computer, wait: null, own: [] })).toEqual({
      kind: "removed",
      name: "MacBook",
    });
  });

  it("says nothing while the computers aren't known, or for a cloud project", () => {
    expect(ownComputerChatState({ computer, wait: null, own: null })).toBeNull();
    expect(ownComputerChatState({ computer: null, wait: null, own: [] })).toBeNull();
  });
});

describe("deleteRefusal", () => {
  it("tells the plan's last computer and a console that doesn't allow it yet apart", () => {
    expect(
      deleteRefusal(
        new AccountHttpError(409, '409: {"error":"LAST_COMPUTER_ON_PLAN"}', {
          error: "LAST_COMPUTER_ON_PLAN",
        }),
      ),
    ).toBe("last-on-plan");
    expect(deleteRefusal(new AccountHttpError(403, "403: forbidden", null))).toBe("not-here");
    expect(deleteRefusal(new AccountHttpError(500, "500", null))).toBeNull();
    expect(deleteRefusal(new Error("network"))).toBeNull();
  });
});
