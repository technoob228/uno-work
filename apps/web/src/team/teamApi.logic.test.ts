import { describe, expect, it } from "vitest";

import { AccountHttpError } from "../account/unoAccount";
import {
  PARTS_OFF,
  isCollabOff,
  parseFeedPage,
  parseInboxPage,
  parseJournal,
  parseLevels,
  parseParts,
  parseProjectChats,
  teamCollabErrorMessage,
} from "./teamApi.logic";

describe("collab parts", () => {
  it("reads the four parts; anything odd is off", () => {
    expect(parseParts({ share: true, requests: true, agents: false, tasks: "yes" })).toEqual({
      share: true,
      requests: true,
      agents: false,
      tasks: false,
    });
    expect(parseParts(null)).toEqual(PARTS_OFF);
  });

  it("knows the server's 'off' answers", () => {
    const off = new AccountHttpError(404, "404", { error: "WORK_TEAM_COLLAB_DISABLED" });
    expect(isCollabOff(off)).toBe(true);
    expect(isCollabOff(new AccountHttpError(404, "404", { error: "WORK_TEAM_DISABLED" }))).toBe(
      true,
    );
    expect(isCollabOff(new AccountHttpError(500, "500", {}))).toBe(false);
  });

  it("says refusals in plain words", () => {
    expect(
      teamCollabErrorMessage(new AccountHttpError(409, "409", { error: "PERSON_NOT_ENABLED" })),
    ).toBe("They don't have this in their Uno Work yet.");
    expect(teamCollabErrorMessage(new AccountHttpError(429, "429", {}))).toContain("a lot");
  });
});

describe("chats", () => {
  it("reads mine with shares and the ones shared with me", () => {
    const chats = parseProjectChats({
      mine: [
        {
          id: 7,
          project_id: 512,
          owner: { user_id: 85, email: "m@x", username: "misha" },
          source: "env-a",
          thread_id: "t1",
          title: "Stripe",
          computer: "uno-work",
          status: "running",
          updated_at: "2026-11-20T14:00:00Z",
          shares: [
            { user_id: 2731, level: "read" },
            { user_id: 1, level: "admin" },
          ],
        },
        { title: "no id" },
      ],
      shared_with_me: [{ id: 9, owner: 85, my_level: "write", status: "weird" }],
    });
    expect(chats.mine).toHaveLength(1);
    expect(chats.mine[0]!.shares).toEqual([{ userId: 2731, level: "read" }]);
    expect(chats.mine[0]!.status).toBe("running");
    expect(chats.sharedWithMe[0]!.owner).toEqual({ userId: 85, email: null, username: "" });
    expect(chats.sharedWithMe[0]!.myLevel).toBe("write");
    expect(chats.sharedWithMe[0]!.status).toBe("idle");
  });

  it("reads a feed page", () => {
    const page = parseFeedPage({
      events: [
        {
          seq: 3,
          pos: 0,
          message_id: "a",
          role: "user",
          author_id: null,
          text: "Hi",
          created_at: "x",
        },
        { seq: 4, pos: 1, role: "tool", text: "nope" },
      ],
      status: "waiting",
      title: "Stripe",
      next_seq: 4,
      my_level: "read",
    });
    expect(page.events).toHaveLength(1);
    expect(page).toMatchObject({ status: "waiting", nextSeq: 4, myLevel: "read" });
  });
});

describe("requests, levels, journal", () => {
  it("reads the inbox and its cursor", () => {
    const page = parseInboxPage({
      requests: [
        {
          id: 1,
          rev: 12,
          kind: "question",
          status: "waiting",
          via_agent: true,
          from: { user_id: 2731, email: "a@x", username: "Andrei" },
          level: "ask",
          level_now: "answer",
          project_name: "landing",
        },
        { id: 2, kind: "telepathy", status: "waiting" },
      ],
      rev: 10,
    });
    expect(page.rev).toBe(12);
    expect(page.requests).toHaveLength(1);
    expect(page.requests[0]).toMatchObject({
      viaAgent: true,
      levelNow: "answer",
      kind: "question",
    });
  });

  it("reads levels by person id", () => {
    const levels = parseLevels({
      ceiling: { default: "ask", people: { "2731": "answer", "9": "max" } },
      mine: { default: null, people: {} },
      effective_in: { "2731": "answer" },
      can_set: true,
    });
    expect(levels.ceiling).toEqual({ default: "ask", people: { 2731: "answer" } });
    expect(levels.mine.default).toBeNull();
    expect(levels.effectiveIn[2731]).toBe("answer");
    expect(levels.canSet).toBe(true);
  });

  it("reads the journal", () => {
    expect(
      parseJournal({
        entries: [
          { id: 3, at: "2026-11-20T14:16:00Z", actor: 2731, level: "answer", text: "Asked" },
        ],
      }),
    ).toEqual([
      {
        id: 3,
        at: "2026-11-20T14:16:00Z",
        actor: { userId: 2731, email: null, username: "" },
        target: null,
        kind: "",
        viaAgent: false,
        level: "answer",
        text: "Asked",
      },
    ]);
  });
});
