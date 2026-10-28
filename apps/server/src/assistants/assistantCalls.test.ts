import { describe, expect, it } from "vitest";

import {
  applyCallsEvent,
  botNameFor,
  disableCalls,
  emptyCallsState,
  enableCalls,
  lastProblem,
  linkBody,
  nextCall,
  notesPrompt,
  parseCalendarFeed,
  parseCallsEvent,
  parseCallsState,
  setCallChoice,
  type CallsEvent,
} from "./assistantCalls.ts";

const KEY = "a1b2c3d4e5f6";
const on = () =>
  enableCalls(emptyCallsState(), { projectId: "assistant-ada", assistantName: "Ada", now: 1000 });

const event = (body: Record<string, unknown>): CallsEvent => {
  const parsed = parseCallsEvent(body);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.event;
};

const notes = (id = "notes-m1") =>
  event({
    id,
    kind: "meeting.notes",
    meeting_id: "m1",
    key: KEY,
    title: "Pilot sync",
    start: "2026-10-28T14:00:00+00:00",
    end: "2026-10-28T14:32:00+00:00",
    platform: "meet",
    attendees: ["Oleg", "Sarah"],
    summary: ["Pilot starts in November"],
    decisions: ["Plan B"],
    questions: ["Who pays for travel?"],
    action_items: [
      { owner: "Oleg", text: "send the contract", due: "Friday", done: false },
      { owner: "Misha", text: "book a room", due: "", done: true },
    ],
    notes_path: "~/Meetings/2026-10-28 14-00 Pilot sync/notes.md",
    transcript_path: "~/Meetings/2026-10-28 14-00 Pilot sync/transcript.md",
  });

describe("assistantCalls", () => {
  it("names the bot after the assistant", () => {
    expect(botNameFor("Ada")).toBe("Ada (Uno notes)");
    expect(botNameFor("  ")).toBe("Uno (Uno notes)");
    expect(on().botName).toBe("Ada (Uno notes)");
  });

  it("gives the notetaker its link, and one assistant at a time", () => {
    const state = setCallChoice(on(), KEY, "skip", 1200);
    expect(linkBody(state, { name: "", email: "misha@x.com" })).toEqual({
      enabled: true,
      assistant: { projectId: "assistant-ada", name: "Ada" },
      owner: { name: "", email: "misha@x.com" },
      botName: "Ada (Uno notes)",
      rule: "mine",
      choices: { [KEY]: { choice: "skip", at: 1200 } },
    });
    // Another assistant takes "Join my calls" over: a fresh start, the bot renamed.
    const bob = enableCalls(state, { projectId: "assistant-bob", assistantName: "Bob", now: 2000 });
    expect(bob.projectId).toBe("assistant-bob");
    expect(bob.botName).toBe("Bob (Uno notes)");
    expect(bob.choices).toEqual({});
    // Re-enabling the same one keeps its choices and its start.
    const again = enableCalls(state, {
      projectId: "assistant-ada",
      assistantName: "Ada",
      now: 3000,
    });
    expect(again.enabledAt).toBe(1000);
    expect(again.choices[KEY]?.choice).toBe("skip");
    expect(disableCalls(again).enabled).toBe(false);
  });

  it("refuses broken events", () => {
    expect(parseCallsEvent(null).ok).toBe(false);
    expect(parseCallsEvent({ kind: "calls.upcoming" }).ok).toBe(false); // no id
    expect(parseCallsEvent({ id: "x", kind: "nope" }).ok).toBe(false);
    expect(parseCallsEvent({ id: "x", kind: "call.status" }).ok).toBe(false); // no session
    // Paths outside ~/Meetings are dropped, not followed.
    const e = event({
      id: "n",
      kind: "meeting.notes",
      notes_path: "/etc/passwd",
      transcript_path: "~/Meetings/../x",
    });
    expect(e.kind === "meeting.notes" && [e.notesPath, e.transcriptPath]).toEqual(["", ""]);
  });

  it("keeps the calls coming up and the next one", () => {
    const upcoming = event({
      id: "up-1",
      kind: "calls.upcoming",
      calls: [
        {
          key: "bbbbbbbbbbbb",
          title: "Later",
          start: "2026-10-28T16:00:00Z",
          end: "2026-10-28T17:00:00Z",
          join: true,
        },
        {
          key: KEY,
          title: "Pilot sync",
          start: "2026-10-28T14:00:00Z",
          end: "2026-10-28T14:30:00Z",
          join: true,
        },
        {
          key: "cccccccccccc",
          title: "Skipped",
          start: "2026-10-28T13:00:00Z",
          end: "2026-10-28T13:30:00Z",
          join: false,
        },
        { key: "not a key", title: "junk" },
      ],
    });
    const { state, effects } = applyCallsEvent(on(), upcoming, 5000);
    expect(state.upcoming.map((c) => c.title)).toEqual(["Later", "Pilot sync", "Skipped"]);
    expect(effects).toEqual({ inbox: null, turn: null });
    expect(nextCall(state, Date.parse("2026-10-28T12:00:00Z"))?.title).toBe("Pilot sync");
    expect(nextCall(state, Date.parse("2026-10-28T14:40:00Z"))?.title).toBe("Later");
    // A switch pressed in Work shows at once.
    const skipped = setCallChoice(state, KEY, "skip", 5100);
    expect(skipped.upcoming.find((c) => c.key === KEY)).toMatchObject({
      join: false,
      choice: "skip",
    });
    expect(nextCall(skipped, Date.parse("2026-10-28T12:00:00Z"))?.title).toBe("Later");
  });

  it("tells the person when the bot couldn't get in, once", () => {
    const failed = event({
      id: "st-s1-not_admitted",
      kind: "call.status",
      key: KEY,
      session: "s1",
      title: "Pilot sync",
      status: "not_admitted",
      reason: "waiting_room",
      text: "Couldn't join Pilot sync: waiting room — nobody let Ada (Uno notes) in",
    });
    const first = applyCallsEvent(on(), failed, 6000);
    expect(first.effects.inbox).toEqual({
      title: "Couldn't join Pilot sync: waiting room — nobody let Ada (Uno notes) in",
      body: null,
      groupKey: "calls:s1",
    });
    expect(lastProblem(first.state, 6100)?.reason).toBe("waiting_room");
    expect(lastProblem(first.state, 6000 + 25 * 3600)).toBeNull();
    const again = applyCallsEvent(first.state, failed, 6200);
    expect(again.duplicate).toBe(true);
    expect(again.effects).toEqual({ inbox: null, turn: null });
    // Joining / recording: no Inbox.
    const joining = event({
      id: "st-s2-joining",
      kind: "call.status",
      session: "s2",
      status: "joining",
      text: "Joining",
    });
    expect(applyCallsEvent(first.state, joining, 6300).effects.inbox).toBeNull();
  });

  it("after a call: a turn for the assistant and one Inbox item", () => {
    const { state, effects } = applyCallsEvent(on(), notes(), 7000);
    expect(effects.inbox).toEqual({
      title: "Notes: Pilot sync",
      body: "1 action item · Oleg: send the contract",
      groupKey: "calls:notes:m1",
    });
    expect(effects.turn?.header).toBe("📝 Pilot sync\n\n");
    const prompt = effects.turn?.prompt ?? "";
    expect(prompt).toContain('you sent "Ada (Uno notes)" to this call');
    expect(prompt).toContain(
      "Meeting: Pilot sync · 2026-10-28 14:00–14:32 UTC · Google Meet · Oleg, Sarah",
    );
    expect(prompt).toContain("- [ ] Oleg: send the contract (due Friday)");
    expect(prompt).toContain("- [x] Misha: book a room");
    expect(prompt).toContain("Full notes: ~/Meetings/2026-10-28 14-00 Pilot sync/notes.md");
    expect(prompt).toContain("needs their OK");
    expect(state.notes).toEqual([
      {
        meetingId: "m1",
        title: "Pilot sync",
        start: "2026-10-28T14:00:00+00:00",
        actionItems: 1,
        at: 7000,
      },
    ]);
    expect(applyCallsEvent(state, notes(), 7100).duplicate).toBe(true);
  });

  it("writes a prompt without empty sections", () => {
    const bare = event({ id: "n2", kind: "meeting.notes", title: "Chat" });
    if (bare.kind !== "meeting.notes") throw new Error("kind");
    const prompt = notesPrompt(bare, "Ada (Uno notes)");
    expect(prompt).toContain("Meeting: Chat\n");
    expect(prompt).toContain("Action items: none.");
    expect(prompt).not.toContain("Summary:");
    expect(prompt).not.toContain("Full notes");
  });

  it("survives a damaged state file", () => {
    expect(parseCallsState("junk")).toEqual(emptyCallsState());
    const round = parseCallsState(
      JSON.parse(JSON.stringify(applyCallsEvent(on(), notes(), 1).state)),
    );
    expect(round.enabled).toBe(true);
    expect(round.notes).toHaveLength(1);
    expect(round.seen).toEqual(["notes-m1"]);
  });

  it("reads the connector's calendar feed", () => {
    expect(
      parseCalendarFeed({ content: [{ type: "text", text: '{"events":[]}' }], isError: false }),
    ).toEqual({
      ok: true,
      feed: { events: [] },
    });
    expect(
      parseCalendarFeed({
        content: [{ type: "text", text: "Gmail & Calendar is not connected." }],
        isError: true,
      }),
    ).toEqual({ ok: false, message: "Gmail & Calendar is not connected." });
    expect(
      parseCalendarFeed({ content: [{ type: "text", text: "[Truncated" }], isError: false }).ok,
    ).toBe(false);
  });
});
