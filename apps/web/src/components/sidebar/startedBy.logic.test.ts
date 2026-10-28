import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  type StartedByThread,
  passesAssistantChatsFilter,
  resolveStartedBy,
  startedByElsewhere,
  startedByKey,
  startedByLabel,
} from "./startedBy.logic";

const chat = (
  environmentId: string,
  id: string,
  projectId: string,
  extra: Partial<StartedByThread> = {},
): StartedByThread => ({ environmentId, id, projectId, archivedAt: null, ...extra });

const names: Record<string, string> = {
  [`work:${ASSISTANT_PROJECT_ID}`]: "Uno",
  "work:assistant-mia": "Mia",
};
const assistantName = (environmentId: string, projectId: string) =>
  names[`${environmentId}:${projectId}`] ?? null;

describe("resolveStartedBy — store fallback (older daemon)", () => {
  const threads = [
    // Mia's conversation, a chat she started, and one its agent started.
    chat("work", "mia-talk", "assistant-mia"),
    chat("work", "mia-job", "p-landing", { spawnedByThreadId: "mia-talk" }),
    chat("work", "mia-sub", "p-landing", { spawnedByThreadId: "mia-job" }),
    // Uno marks its own create_thread chats `spawned`.
    chat("work", "uno-job", "p-landing", { assistantRole: "spawned" }),
    // The person's own chat and one its agent started.
    chat("work", "mine", "p-landing"),
    chat("work", "mine-sub", "p-landing", { spawnedByThreadId: "mine" }),
  ];
  const result = resolveStartedBy({ threads, entries: new Map(), assistantName });

  it("follows spawnedByThreadId up to the assistant's conversation", () => {
    expect(result.get(startedByKey("work", "mia-job"))).toMatchObject({
      name: "Mia",
      projectId: "assistant-mia",
      environmentId: "work",
      isUno: false,
      fromComputer: null,
    });
    expect(result.get(startedByKey("work", "mia-sub"))?.name).toBe("Mia");
  });

  it("a spawned chat with no parent is the computer's Uno", () => {
    expect(result.get(startedByKey("work", "uno-job"))).toMatchObject({ name: "Uno", isUno: true });
  });

  it("the conversation itself and the person's chats are nobody's", () => {
    expect(result.has(startedByKey("work", "mia-talk"))).toBe(false);
    expect(result.has(startedByKey("work", "mine"))).toBe(false);
    expect(result.has(startedByKey("work", "mine-sub"))).toBe(false);
  });

  it("survives a loop in the chain and skips archived chats", () => {
    const looped = resolveStartedBy({
      threads: [
        chat("work", "a", "p", { spawnedByThreadId: "b" }),
        chat("work", "b", "p", { spawnedByThreadId: "a" }),
        chat("work", "old", "p", { assistantRole: "spawned", archivedAt: "2026-10-01T00:00:00Z" }),
      ],
      entries: new Map(),
      assistantName,
    });
    expect(looped.size).toBe(0);
  });

  it("an assistant the app can't name yet still reads as one", () => {
    const unknown = resolveStartedBy({
      threads: [
        chat("mac", "talk", "assistant-zed"),
        chat("mac", "job", "p", { spawnedByThreadId: "talk" }),
      ],
      entries: new Map(),
      assistantName,
    });
    expect(unknown.get(startedByKey("mac", "job"))?.name).toBe("an assistant");
  });
});

describe("resolveStartedBy — the daemon's list", () => {
  it("names an assistant from another computer with that computer", () => {
    const result = resolveStartedBy({
      threads: [chat("mac", "tests", "p-landing", { assistantRole: "spawned" })],
      entries: new Map([
        [
          "mac",
          [
            {
              threadId: "tests" as never,
              assistantName: "Uno" as never,
              assistantProjectId: ASSISTANT_PROJECT_ID,
              local: false,
              fromComputerName: "stage-work",
            },
          ],
        ],
      ]),
      assistantName,
    });
    const startedBy = result.get(startedByKey("mac", "tests"))!;
    // Not the MacBook's own Uno, as the store alone would say.
    expect(startedBy).toMatchObject({
      name: "Uno",
      environmentId: null,
      fromComputer: "stage-work",
    });
    expect(startedByLabel(startedBy)).toBe("Started by Uno · from stage-work");
  });

  it("a chat the daemon doesn't list yet falls back to the store", () => {
    const result = resolveStartedBy({
      threads: [
        chat("work", "mia-talk", "assistant-mia"),
        chat("work", "fresh", "p", { spawnedByThreadId: "mia-talk" }),
      ],
      entries: new Map([["work", []]]),
      assistantName,
    });
    expect(startedByLabel(result.get(startedByKey("work", "fresh"))!)).toBe("Started by Mia");
  });
});

describe("the Assistants' chats filter", () => {
  const base = { hidden: true, startedByAssistant: true, isOpen: false, pinned: false };
  it("hides what assistants started, keeps the person's own", () => {
    expect(passesAssistantChatsFilter(base)).toBe(false);
    expect(passesAssistantChatsFilter({ ...base, startedByAssistant: false })).toBe(true);
  });
  it("never hides the open chat or a pinned one", () => {
    expect(passesAssistantChatsFilter({ ...base, isOpen: true })).toBe(true);
    expect(passesAssistantChatsFilter({ ...base, pinned: true })).toBe(true);
  });
  it("shown: everything passes", () => {
    expect(passesAssistantChatsFilter({ ...base, hidden: false })).toBe(true);
  });
});

describe("startedByElsewhere (one computer in view)", () => {
  const threads = [
    chat("work", "here", "p", { assistantRole: "spawned" }),
    chat("mac", "there", "p", { assistantRole: "spawned" }),
    chat("mac", "mine", "p"),
  ];
  const startedBy = resolveStartedBy({ threads, entries: new Map(), assistantName });
  it("adds the chats assistants started on the other computers only", () => {
    expect(
      startedByElsewhere({ threads, startedBy, inView: "work" }).map((thread) => thread.id),
    ).toEqual(["there"]);
  });
  it("adds nothing when every computer is in view", () => {
    expect(startedByElsewhere({ threads, startedBy, inView: null })).toEqual([]);
  });
});
