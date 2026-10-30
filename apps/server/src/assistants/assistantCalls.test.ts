import { describe, expect, it } from "vitest";

import {
  anyCalendarSignedIn,
  applyCallsEvent,
  calendarFeedFailure,
  calendarsBody,
  botNameFor,
  callsBusy,
  callsWakeAt,
  CALLS_RECHECK_MS,
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
    // the bot is done with a call it couldn't get into: the next one is next
    const over = {
      ...state,
      upcoming: state.upcoming.map((c) =>
        c.key === KEY ? { ...c, session: { status: "failed", detail: "x" } } : c,
      ),
    };
    expect(nextCall(over, Date.parse("2026-10-28T14:10:00Z"))?.title).toBe("Later");
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

  describe("economy: wake for calls, hold during them", () => {
    const at = (iso: string) => Date.parse(iso);
    const withCalls = (
      calls: Array<{ key: string; start: string; end: string; join: boolean }>,
    ) => ({
      ...on(),
      upcoming: calls.map((c) => ({
        ...c,
        title: c.key,
        platform: "meet",
        platformName: "Google Meet",
        why: "auto",
        choice: "" as const,
        session: null,
      })),
    });
    const status = (session: string, s: string, atSec: number, meetingId = "") => ({
      key: "k",
      session,
      title: "Sync",
      start: "2026-10-28T17:00:00+00:00",
      status: s,
      reason: "",
      text: "",
      meetingId,
      at: atSec,
    });

    it("wakes 3 minutes before the next call it joins, skipped calls don't count", () => {
      const state = withCalls([
        {
          key: "skip",
          start: "2026-10-28T16:30:00+00:00",
          end: "2026-10-28T16:45:00+00:00",
          join: false,
        },
        {
          key: "go",
          start: "2026-10-28T17:00:00+00:00",
          end: "2026-10-28T17:30:00+00:00",
          join: true,
        },
      ]);
      expect(callsWakeAt(state, at("2026-10-28T16:10:00Z"))).toBe(at("2026-10-28T16:57:00Z"));
    });

    it("re-reads the calendar every couple of hours, on a clock boundary", () => {
      const now = at("2026-10-28T16:10:00Z");
      const wake = callsWakeAt(on(), now);
      expect(wake).not.toBeNull();
      expect(wake! % CALLS_RECHECK_MS).toBe(0);
      expect(wake! - now).toBeLessThanOrEqual(CALLS_RECHECK_MS);
      expect(callsWakeAt(on(), now + 60_000)).toBe(wake);
    });

    it("off — neither wakes nor holds", () => {
      const state = disableCalls(
        withCalls([
          {
            key: "go",
            start: "2026-10-28T17:00:00+00:00",
            end: "2026-10-28T17:30:00+00:00",
            join: true,
          },
        ]),
      );
      expect(callsWakeAt(state, at("2026-10-28T16:59:00Z"))).toBeNull();
      expect(callsBusy(state, at("2026-10-28T16:59:00Z"))).toBe(false);
    });

    it("holds from 3 minutes before the start until the bot could still knock", () => {
      const state = withCalls([
        {
          key: "go",
          start: "2026-10-28T17:00:00+00:00",
          end: "2026-10-28T19:00:00+00:00",
          join: true,
        },
      ]);
      expect(callsBusy(state, at("2026-10-28T16:56:00Z"))).toBe(false);
      expect(callsBusy(state, at("2026-10-28T16:58:00Z"))).toBe(true);
      expect(callsBusy(state, at("2026-10-28T17:14:00Z"))).toBe(true);
      // a long meeting the bot never got into doesn't keep the computer up to its end
      expect(callsBusy(state, at("2026-10-28T17:30:00Z"))).toBe(false);
    });

    it("holds while the bot is in a call and until its notes are in", () => {
      const t = at("2026-10-28T18:00:00Z") / 1000;
      const inCall = {
        ...on(),
        statuses: [status("s1", "joining", t - 3000), status("s1", "recording", t - 2900)],
      };
      expect(callsBusy(inCall, t * 1000)).toBe(true);
      const left = {
        ...inCall,
        statuses: [...inCall.statuses, status("s1", "done", t - 60, "m1")],
      };
      expect(callsBusy(left, t * 1000)).toBe(true);
      const noted = {
        ...left,
        notes: [{ meetingId: "m1", title: "Sync", start: "", actionItems: 1, at: t }],
      };
      expect(callsBusy(noted, t * 1000)).toBe(false);
      expect(callsBusy(left, (t + 3600) * 1000)).toBe(false); // notes never came: let it sleep
      const failed = {
        ...on(),
        statuses: [status("s2", "joining", t - 100), status("s2", "failed", t - 50)],
      };
      expect(callsBusy(failed, t * 1000)).toBe(false);
      const stale = { ...on(), statuses: [status("s3", "recording", t - 5 * 3600)] };
      expect(callsBusy(stale, t * 1000)).toBe(false);
    });
  });
});

describe("the person's calendars", () => {
  const row = (provider: string, connected: boolean, needsReconnect = false) => ({
    provider,
    available: true,
    connected,
    account: connected ? `${provider}@x.com` : null,
    needsReconnect,
  });

  it("lists both calendars; one the console doesn't list is unavailable", () => {
    expect(calendarsBody([row("gmail", true), row("notion", true)])).toEqual({
      calendars: [
        {
          provider: "gmail",
          name: "Google Calendar",
          available: true,
          connected: true,
          account: "gmail@x.com",
          needsReconnect: false,
        },
        {
          provider: "microsoft",
          name: "Outlook & Teams",
          available: false,
          connected: false,
          account: "",
          needsReconnect: false,
        },
      ],
    });
    expect(calendarsBody(null).calendars.every((c) => !c.available && !c.connected)).toBe(true);
  });

  it("any signed-in calendar is enough for Join my calls", () => {
    expect(anyCalendarSignedIn([row("gmail", false), row("microsoft", true)])).toBe(true);
    expect(anyCalendarSignedIn([row("gmail", true, true), row("microsoft", false)])).toBe(false);
    expect(anyCalendarSignedIn(null)).toBe(false);
  });

  it("names the failure by provider", () => {
    expect(calendarFeedFailure("gmail", { kind: "call", status: 401, message: "x" }).code).toBe(
      "google_reconnect",
    );
    expect(calendarFeedFailure("microsoft", { kind: "call", status: 403, message: "x" }).code).toBe(
      "microsoft_reconnect",
    );
    expect(calendarFeedFailure("microsoft", { kind: "call", status: 404, message: "x" })).toEqual({
      status: 424,
      code: "microsoft_not_connected",
      message: "Outlook & Teams calendar isn't connected in Uno Work.",
    });
    expect(
      calendarFeedFailure("gmail", { kind: "answer", message: "Gmail is not connected" }).code,
    ).toBe("google_not_connected");
    expect(
      calendarFeedFailure("microsoft", { kind: "answer", message: "token expired" }).code,
    ).toBe("microsoft_reconnect");
    expect(calendarFeedFailure("gmail", { kind: "call", status: 500, message: "down" })).toEqual({
      status: 502,
      code: "calendar_unavailable",
      message: "down",
    });
  });
});
