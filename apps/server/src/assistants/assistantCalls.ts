/**
 * "Join my calls": an assistant sends the Notetaker (an App Store app on
 * this computer) to the person's calls — pure part.
 *
 * Contract: reports/day_2026-10-28/assistants-d-impl/CONTRACTS.md (W ↔ N).
 *
 * - State on this computer (`stateDir/assistant-calls.json`): which
 *   assistant, the bot's name, per-meeting choices, what the notetaker last
 *   said (calls coming up, a call's status, the last notes) and the ids of
 *   events already taken (an event is never acted on twice).
 * - The notetaker asks for the link and the calendar and reports events over
 *   the local App API (`appSdk/appApiHttp.ts`, manifest `"calls": true`).
 * - What an event does is decided here (`applyCallsEvent`): an Inbox item,
 *   a turn of the assistant (after the notes), nothing (a status for the UI).
 *
 * @module assistants/assistantCalls
 */

export const CALLS_RULE = "mine" as const;
export const CALLS_SOURCE = "notetaker";
/** The App Store template and the app id of its manifest. */
export const NOTETAKER_TEMPLATE_ID = "notetaker";
/** The thread a non-default assistant gets the meetings in. */
export const CALLS_THREAD_TITLE = "Meetings";

const SEEN_MAX = 500;
const STATUSES_MAX = 60;
const NOTES_MAX = 10;
const UPCOMING_MAX = 40;

export type CallsChoiceValue = "join" | "skip" | "";

export interface CallsChoice {
  readonly choice: CallsChoiceValue;
  readonly at: number;
}

export interface CallView {
  readonly key: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly platform: string;
  readonly platformName: string;
  readonly join: boolean;
  readonly why: string;
  readonly choice: CallsChoiceValue;
  readonly session: { readonly status: string; readonly detail: string } | null;
}

export interface CallStatus {
  readonly key: string;
  readonly session: string;
  readonly title: string;
  readonly start: string;
  readonly status: string;
  readonly reason: string;
  readonly text: string;
  readonly meetingId: string;
  readonly at: number;
}

export interface CallsNotesSummary {
  readonly meetingId: string;
  readonly title: string;
  readonly start: string;
  readonly actionItems: number;
  readonly at: number;
}

export interface AssistantCallsState {
  readonly enabled: boolean;
  readonly projectId: string | null;
  readonly assistantName: string;
  readonly botName: string;
  readonly rule: typeof CALLS_RULE;
  readonly enabledAt: number | null;
  readonly choices: Readonly<Record<string, CallsChoice>>;
  readonly upcoming: ReadonlyArray<CallView>;
  readonly upcomingAt: number | null;
  readonly statuses: ReadonlyArray<CallStatus>;
  readonly notes: ReadonlyArray<CallsNotesSummary>;
  readonly seen: ReadonlyArray<string>;
}

export function emptyCallsState(): AssistantCallsState {
  return {
    enabled: false,
    projectId: null,
    assistantName: "",
    botName: "",
    rule: CALLS_RULE,
    enabledAt: null,
    choices: {},
    upcoming: [],
    upcomingAt: null,
    statuses: [],
    notes: [],
    seen: [],
  };
}

const rec = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Plain one-line text: control and bidi characters out, clipped. */
export function cleanLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // oxlint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]+/g, " ");
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

const str = (value: unknown, max = 200) => cleanLine(value, max);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const KEY_RE = /^[a-f0-9]{6,40}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;

function parseChoice(value: unknown): CallsChoiceValue {
  return value === "join" || value === "skip" ? value : "";
}

function parseCallView(value: unknown): CallView | null {
  const r = rec(value);
  if (!r || typeof r["key"] !== "string" || !KEY_RE.test(r["key"])) return null;
  const session = rec(r["session"]);
  return {
    key: r["key"],
    title: str(r["title"]),
    start: str(r["start"], 40),
    end: str(r["end"], 40),
    platform: str(r["platform"], 20),
    platformName: str(r["platform_name"] ?? r["platformName"], 40),
    join: r["join"] === true,
    why: str(r["why"], 80),
    choice: parseChoice(r["choice"]),
    session: session
      ? { status: str(session["status"], 20), detail: str(session["detail"], 300) }
      : null,
  };
}

const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const bullets = (items: ReadonlyArray<string>) => items.map((line) => `- ${line}`);

/** The state file → state (tolerant: a damaged file is an empty state). */
export function parseCallsState(raw: unknown): AssistantCallsState {
  const r = rec(raw);
  if (!r) return emptyCallsState();
  const choices: Record<string, CallsChoice> = {};
  for (const [key, value] of Object.entries(rec(r["choices"]) ?? {})) {
    const c = rec(value);
    if (KEY_RE.test(key) && c)
      choices[key] = { choice: parseChoice(c["choice"]), at: num(c["at"]) };
  }
  return {
    enabled: r["enabled"] === true,
    projectId: typeof r["projectId"] === "string" && r["projectId"] ? r["projectId"] : null,
    assistantName: str(r["assistantName"], 60),
    botName: str(r["botName"], 60),
    rule: CALLS_RULE,
    enabledAt: num(r["enabledAt"]) || null,
    choices,
    upcoming: list(r["upcoming"])
      .map(parseCallView)
      .filter((c): c is CallView => c !== null),
    upcomingAt: num(r["upcomingAt"]) || null,
    statuses: list(r["statuses"]).flatMap((value) => {
      const s = rec(value);
      return s && typeof s["session"] === "string" ? [s as unknown as CallStatus] : [];
    }),
    notes: list(r["notes"]).flatMap((value) => {
      const n = rec(value);
      return n && typeof n["meetingId"] === "string" ? [n as unknown as CallsNotesSummary] : [];
    }),
    seen: list(r["seen"]).filter((id): id is string => typeof id === "string"),
  };
}

/** "Ada (Uno notes)" — what the host sees in the participants list. */
export function botNameFor(assistantName: string): string {
  const name = cleanLine(assistantName, 40) || "Uno";
  return `${name} (Uno notes)`;
}

export function enableCalls(
  state: AssistantCallsState,
  input: { readonly projectId: string; readonly assistantName: string; readonly now: number },
): AssistantCallsState {
  const same = state.projectId === input.projectId;
  return {
    ...state,
    enabled: true,
    projectId: input.projectId,
    assistantName: cleanLine(input.assistantName, 60),
    botName: botNameFor(input.assistantName),
    enabledAt: same && state.enabled ? state.enabledAt : input.now,
    // Another assistant takes it over: its own fresh view of the calls.
    ...(same ? {} : { choices: {}, statuses: [], notes: [] }),
  };
}

export function disableCalls(state: AssistantCallsState): AssistantCallsState {
  return { ...state, enabled: false, upcoming: [], upcomingAt: null };
}

export function setCallChoice(
  state: AssistantCallsState,
  key: string,
  choice: CallsChoiceValue,
  now: number,
): AssistantCallsState {
  if (!KEY_RE.test(key)) return state;
  return {
    ...state,
    choices: { ...pruneChoices(state.choices), [key]: { choice, at: now } },
    // Shown at once; the notetaker confirms with its next "calls.upcoming".
    upcoming: state.upcoming.map((c) =>
      c.key === key
        ? {
            ...c,
            choice,
            join: choice === "join" ? true : choice === "skip" ? false : c.join,
            why:
              choice === "skip"
                ? "you turned it off"
                : choice === "join"
                  ? "you turned it on"
                  : c.why,
          }
        : c,
    ),
  };
}

function pruneChoices(choices: Readonly<Record<string, CallsChoice>>): Record<string, CallsChoice> {
  const entries = Object.entries(choices);
  if (entries.length < 300) return { ...choices };
  return Object.fromEntries(entries.toSorted((a, b) => b[1].at - a[1].at).slice(0, 200));
}

/** `GET /v1/assistant/link`. */
export function linkBody(
  state: AssistantCallsState,
  owner: { readonly name: string; readonly email: string },
) {
  return {
    enabled: state.enabled,
    assistant: { projectId: state.projectId ?? "", name: state.assistantName },
    owner: { name: owner.name, email: owner.email },
    botName: state.botName || botNameFor(state.assistantName),
    rule: state.rule,
    choices: state.choices,
  };
}

// ---- events -------------------------------------------------------------------

export interface MeetingNotesEvent {
  readonly kind: "meeting.notes";
  readonly id: string;
  readonly meetingId: string;
  readonly key: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly durationS: number;
  readonly platform: string;
  readonly attendees: ReadonlyArray<string>;
  readonly summary: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  readonly questions: ReadonlyArray<string>;
  readonly actionItems: ReadonlyArray<{
    readonly owner: string;
    readonly text: string;
    readonly due: string;
    readonly done: boolean;
  }>;
  readonly notesPath: string;
  readonly transcriptPath: string;
}

export type CallsEvent =
  | {
      readonly kind: "calls.upcoming";
      readonly id: string;
      readonly calls: ReadonlyArray<CallView>;
    }
  | ({ readonly kind: "call.status"; readonly id: string } & Omit<CallStatus, "at">)
  | MeetingNotesEvent
  | {
      readonly kind: "meeting.error";
      readonly id: string;
      readonly meetingId: string;
      readonly title: string;
      readonly error: string;
    };

const lines = (value: unknown, max: number, each = 400) =>
  (Array.isArray(value) ? value : [])
    .map((v) => cleanLine(v, each))
    .filter((v) => v.length > 0)
    .slice(0, max);

const homePath = (value: unknown) => {
  const p = str(value, 400);
  return p.startsWith("~/Meetings/") && !p.includes("..") ? p : "";
};

export function parseCallsEvent(
  body: unknown,
):
  | { readonly ok: true; readonly event: CallsEvent }
  | { readonly ok: false; readonly message: string } {
  const r = rec(body);
  if (!r) return { ok: false, message: "An event is a JSON object." };
  const id = typeof r["id"] === "string" ? r["id"] : "";
  if (!ID_RE.test(id))
    return { ok: false, message: 'Every event needs an "id" (letters, digits, -_.:).' };
  switch (r["kind"]) {
    case "calls.upcoming":
      return {
        ok: true,
        event: {
          kind: "calls.upcoming",
          id,
          calls: (Array.isArray(r["calls"]) ? r["calls"] : [])
            .slice(0, UPCOMING_MAX)
            .map(parseCallView)
            .filter((c): c is CallView => c !== null),
        },
      };
    case "call.status": {
      const session = str(r["session"], 40);
      if (!session) return { ok: false, message: 'call.status needs "session".' };
      return {
        ok: true,
        event: {
          kind: "call.status",
          id,
          key: str(r["key"], 40),
          session,
          title: str(r["title"]),
          start: str(r["start"], 40),
          status: str(r["status"], 20),
          reason: str(r["reason"], 30),
          text: str(r["text"], 300),
          meetingId: str(r["meeting_id"], 40),
        },
      };
    }
    case "meeting.notes":
      return {
        ok: true,
        event: {
          kind: "meeting.notes",
          id,
          meetingId: str(r["meeting_id"], 40),
          key: str(r["key"], 40),
          title: str(r["title"]) || "Meeting",
          start: str(r["start"], 40),
          end: str(r["end"], 40),
          durationS: num(r["duration_s"]),
          platform: str(r["platform"], 20),
          attendees: lines(r["attendees"], 40, 80),
          summary: lines(r["summary"], 12),
          decisions: lines(r["decisions"], 12),
          questions: lines(r["questions"], 12),
          actionItems: (Array.isArray(r["action_items"]) ? r["action_items"] : [])
            .slice(0, 30)
            .flatMap((value) => {
              const a = rec(value);
              const text = a ? cleanLine(a["text"], 400) : "";
              return a && text
                ? [
                    {
                      owner: str(a["owner"], 80),
                      text,
                      due: str(a["due"], 60),
                      done: a["done"] === true,
                    },
                  ]
                : [];
            }),
          notesPath: homePath(r["notes_path"]),
          transcriptPath: homePath(r["transcript_path"]),
        },
      };
    case "meeting.error":
      return {
        ok: true,
        event: {
          kind: "meeting.error",
          id,
          meetingId: str(r["meeting_id"], 40),
          title: str(r["title"]) || "Meeting",
          error: str(r["error"], 300),
        },
      };
    default:
      return { ok: false, message: `Unknown event kind ${JSON.stringify(r["kind"] ?? null)}.` };
  }
}

export interface CallsInboxPost {
  readonly title: string;
  readonly body: string | null;
  readonly groupKey: string;
}

export interface CallsEffects {
  readonly inbox: CallsInboxPost | null;
  /** The assistant's turn after a call (prompt + header for Telegram). */
  readonly turn: { readonly prompt: string; readonly header: string } | null;
}

const NO_EFFECTS: CallsEffects = { inbox: null, turn: null };
const FAILED = new Set(["failed", "not_admitted"]);

/** What one event changes and does. A repeated id does nothing. */
export function applyCallsEvent(
  state: AssistantCallsState,
  event: CallsEvent,
  now: number,
): {
  readonly state: AssistantCallsState;
  readonly effects: CallsEffects;
  readonly duplicate: boolean;
} {
  if (state.seen.includes(event.id)) return { state, effects: NO_EFFECTS, duplicate: true };
  const seen = [...state.seen, event.id].slice(-SEEN_MAX);
  switch (event.kind) {
    case "calls.upcoming":
      return {
        state: { ...state, seen, upcoming: event.calls, upcomingAt: now },
        effects: NO_EFFECTS,
        duplicate: false,
      };
    case "call.status": {
      const { kind: _kind, id: _id, ...rest } = event;
      const status: CallStatus = { ...rest, at: now };
      const statuses = [...state.statuses.filter((s) => s.session !== event.session), status].slice(
        -STATUSES_MAX,
      );
      const inbox = FAILED.has(event.status)
        ? {
            title: cleanLine(event.text || `Couldn't join ${event.title || "the call"}`, 140),
            body: null,
            groupKey: `calls:${event.session}`,
          }
        : null;
      return {
        state: { ...state, seen, statuses },
        effects: { inbox, turn: null },
        duplicate: false,
      };
    }
    case "meeting.notes": {
      const open = event.actionItems.filter((a) => !a.done).length;
      const notes = [
        ...state.notes.filter((n) => n.meetingId !== event.meetingId),
        {
          meetingId: event.meetingId,
          title: event.title,
          start: event.start,
          actionItems: open,
          at: now,
        },
      ].slice(-NOTES_MAX);
      return {
        state: { ...state, seen, notes },
        effects: {
          inbox: {
            title: cleanLine(`Notes: ${event.title}`, 140),
            body: notesInboxBody(event),
            groupKey: `calls:notes:${event.meetingId}`,
          },
          turn: {
            prompt: notesPrompt(event, state.botName || botNameFor(state.assistantName)),
            header: `📝 ${event.title}\n\n`,
          },
        },
        duplicate: false,
      };
    }
    case "meeting.error":
      return {
        state: { ...state, seen },
        effects: {
          inbox: {
            title: cleanLine(`Couldn't make notes for ${event.title}`, 140),
            body: event.error || null,
            groupKey: `calls:error:${event.meetingId}`,
          },
          turn: null,
        },
        duplicate: false,
      };
  }
}

function notesInboxBody(event: MeetingNotesEvent): string {
  const open = event.actionItems.filter((a) => !a.done);
  const head =
    open.length > 0
      ? `${open.length} action item${open.length === 1 ? "" : "s"} · ${open
          .slice(0, 3)
          .map((a) => (a.owner ? `${a.owner}: ${a.text}` : a.text))
          .join("; ")}`
      : event.summary.slice(0, 2).join(" ") || "No action items.";
  return cleanLine(head, 500);
}

function when(event: { readonly start: string; readonly end: string }): string {
  const start = Date.parse(event.start);
  if (!Number.isFinite(start)) return "";
  const end = Date.parse(event.end);
  const day = new Date(start).toISOString().slice(0, 10);
  return `${day} ${clock(start)}${Number.isFinite(end) ? `–${clock(end)}` : ""} UTC`;
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  meet: "Google Meet",
  zoom: "Zoom",
  teams: "Microsoft Teams",
  telemost: "Yandex Telemost",
  zoho: "Zoho Meeting",
  jitsi: "Jitsi Meet",
};

/** What the assistant reads after a call. */
export function notesPrompt(event: MeetingNotesEvent, botName: string): string {
  const meta = [
    when(event),
    PLATFORM_NAMES[event.platform] ?? "",
    event.attendees.length > 0 ? event.attendees.slice(0, 12).join(", ") : "",
  ].filter((part) => part.length > 0);
  const items = event.actionItems.map(
    (a) =>
      `- [${a.done ? "x" : " "}] ${a.owner ? `${a.owner}: ` : ""}${a.text}${a.due ? ` (due ${a.due})` : ""}`,
  );
  return [
    `[Meeting notes from Uno Notetaker — you sent "${botName}" to this call for the person.`,
    "The person is not in this chat right now; your final message goes to them in Telegram, so keep it short.]",
    "",
    `Meeting: ${event.title}${meta.length > 0 ? ` · ${meta.join(" · ")}` : ""}`,
    ...(event.summary.length > 0 ? ["", "Summary:", ...bullets(event.summary)] : []),
    ...(event.decisions.length > 0 ? ["", "Decisions:", ...bullets(event.decisions)] : []),
    ...(items.length > 0 ? ["", "Action items:", ...items] : ["", "Action items: none."]),
    ...(event.questions.length > 0 ? ["", "Open questions:", ...bullets(event.questions)] : []),
    ...(event.notesPath
      ? [
          "",
          `Full notes: ${event.notesPath}${event.transcriptPath ? ` · transcript: ${event.transcriptPath}` : ""}`,
        ]
      : []),
    "",
    "Tell the person in 2–4 lines what matters, and offer what you can do next (draft the follow-up email,",
    "add the action items to their task list). Do the safe preparation now (drafts, notes in files);",
    "anything that goes out to other people needs their OK.",
  ].join("\n");
}

/** The call the bot goes to next (for "Joining Pilot sync at 14:00"). */
export function nextCall(state: AssistantCallsState, nowMs: number): CallView | null {
  return (
    state.upcoming
      .filter((c) => c.join && Date.parse(c.end) > nowMs)
      .toSorted((a, b) => Date.parse(a.start) - Date.parse(b.start))[0] ?? null
  );
}

/** Wake the computer this long before a call: the bot opens the call page at the start. */
export const CALLS_WAKE_BEFORE_MS = 3 * 60_000;
/**
 * A sleeping computer reads no calendar: wake it this often to see meetings
 * added meanwhile (aligned to the clock, so the report doesn't change every tick).
 */
export const CALLS_RECHECK_MS = 2 * 3600_000;
/** After the bot's "done" the notes take a few minutes (speech to text, summary). */
const NOTES_WAIT_S = 30 * 60;
/** A status older than this no longer holds the computer (the notetaker died mid-call). */
const ACTIVE_MAX_S = 4 * 3600;
/** The bot may wait in the lobby up to 15 minutes after the start. */
const JOIN_WINDOW_MS = 15 * 60_000;
const ACTIVE = new Set(["queued", "joining", "lobby", "recording", "leaving"]);

/**
 * When the computer should wake up for calls (economy mode sleeps it after
 * ~10 idle minutes): a few minutes before the next call it joins, and at
 * least every couple of hours to re-read the calendar. Null — calls are off.
 */
export function callsWakeAt(state: AssistantCallsState, nowMs: number): number | null {
  if (!state.enabled) return null;
  let best = (Math.floor(nowMs / CALLS_RECHECK_MS) + 1) * CALLS_RECHECK_MS;
  for (const c of state.upcoming) {
    if (!c.join) continue;
    const at = Date.parse(c.start) - CALLS_WAKE_BEFORE_MS;
    if (Number.isFinite(at) && at > nowMs && at < best) best = at;
  }
  return best;
}

/**
 * Whether calls hold the computer awake now: a call is about to start or the
 * bot may still be knocking, the bot is in a call, or the notes of a call it
 * just left are not in yet.
 */
export function callsBusy(state: AssistantCallsState, nowMs: number): boolean {
  if (!state.enabled) return false;
  for (const c of state.upcoming) {
    if (!c.join) continue;
    const start = Date.parse(c.start);
    if (start - CALLS_WAKE_BEFORE_MS <= nowMs && nowMs <= start + JOIN_WINDOW_MS) return true;
  }
  const nowSec = nowMs / 1000;
  const latest = new Map<string, CallStatus>();
  for (const s of state.statuses) {
    const prev = latest.get(s.session);
    if (!prev || s.at >= prev.at) latest.set(s.session, s);
  }
  const noted = new Set(state.notes.map((n) => n.meetingId));
  for (const s of latest.values()) {
    if (ACTIVE.has(s.status) && nowSec - s.at < ACTIVE_MAX_S) return true;
    if (
      s.status === "done" &&
      nowSec - s.at < NOTES_WAIT_S &&
      !(s.meetingId && noted.has(s.meetingId))
    ) {
      return true;
    }
  }
  return false;
}

/** The newest failure of the last day ("Couldn't join Pilot sync: waiting room …"). */
export function lastProblem(state: AssistantCallsState, nowSec: number): CallStatus | null {
  const recent = state.statuses.filter((s) => nowSec - s.at < 24 * 3600);
  const last = recent.toSorted((a, b) => b.at - a.at)[0];
  return last && FAILED.has(last.status) ? last : null;
}

/** The connector's calendar_feed answer (JSON in the first text block) → object. */
export function parseCalendarFeed(result: {
  readonly content: ReadonlyArray<Record<string, unknown>>;
  readonly isError?: boolean;
}):
  | { readonly ok: true; readonly feed: unknown }
  | { readonly ok: false; readonly message: string } {
  const block = result.content.find((c) => c["type"] === "text");
  const text = typeof block?.["text"] === "string" ? block["text"] : "";
  if (result.isError) return { ok: false, message: text || "The calendar didn't answer." };
  try {
    const feed = JSON.parse(text) as unknown;
    return rec(feed)
      ? { ok: true, feed }
      : { ok: false, message: "The calendar answered something else." };
  } catch {
    return { ok: false, message: "The calendar answered something else." };
  }
}
