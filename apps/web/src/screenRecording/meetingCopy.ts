/**
 * Loom Work + Notetaker (29.10): a recording, once saved to Uno Drive and
 * watched, also lands in the Notetaker library next to the calls — as a ready
 * folder in `~/Meetings` (uno-notetaker docs/screen-recordings.md). Notetaker
 * notices it, writes the notes and action items (with "Ask Uno to do it") and
 * plays the video from the Drive link.
 *
 * Only when `~/Meetings` exists (Notetaker is installed); best effort — the
 * recording itself is already safe in Drive. `meeting.json` goes last, so the
 * app never sees a half-written folder.
 */
import { type TimelineEntry, normalizeTimeline } from "./agentView";

export const MEETINGS_DIR = "Meetings";

export interface MeetingSegment {
  readonly start: number;
  readonly end: number;
  /** "Me" when something was said, "" for a silent moment. */
  readonly speaker: "Me" | "";
  readonly text: string;
  readonly screen: string;
  readonly did: string;
}

export interface MeetingCopyInput {
  /** 10 × [a-z0-9] — the Notetaker meeting id. */
  readonly id: string;
  /** When the recording was made (the person's local time, with offset). */
  readonly createdAt: Date;
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
  readonly driveKey: string;
  readonly shareUrl: string | null;
  readonly shareExpiresAt: string | null;
  readonly speech: string;
  readonly visual: string;
  readonly timeline: ReadonlyArray<TimelineEntry>;
}

export interface MeetingCopy {
  /** Folder name inside `~/Meetings`. */
  readonly folder: string;
  /** In write order: meeting.json is the last. */
  readonly files: ReadonlyArray<{ readonly name: string; readonly contents: string }>;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO with the local offset ("2026-10-29T14:02:11+03:00"), like Notetaker writes. */
export function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** "2026-10-29 14-02 Screen recording" — Notetaker renames it to the notes' title. */
export function meetingFolderName(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}-${pad(date.getMinutes())} Screen recording`
  );
}

export function newMeetingId(random: () => number = Math.random): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 10; i++) id += alphabet[Math.floor(random() * alphabet.length) % 36];
  return id;
}

/** The timeline as Notetaker transcript lines; without one, the whole speech as one line. */
export function meetingSegments(
  timeline: ReadonlyArray<TimelineEntry>,
  speech: string,
  visual: string,
  durationSec: number,
): MeetingSegment[] {
  const entries = normalizeTimeline(timeline).filter(
    (entry) => entry.say.trim() || entry.see.trim() || entry.do.trim(),
  );
  if (entries.length === 0) {
    const text = speech.trim();
    const screen = visual.trim();
    if (!text && !screen) return [];
    return [
      {
        start: 0,
        end: Math.max(0, Math.round(durationSec)),
        speaker: text ? "Me" : "",
        text,
        screen,
        did: "",
      },
    ];
  }
  return entries.map((entry, i) => {
    const next = entries[i + 1];
    const text = entry.say.trim();
    return {
      start: entry.t,
      end: next ? next.t : Math.max(entry.t, Math.round(durationSec)),
      speaker: text ? "Me" : "",
      text,
      screen: entry.see.trim(),
      did: entry.do.trim(),
    };
  });
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function transcriptMd(createdAt: Date, durationSec: number, segments: MeetingSegment[]): string {
  const day = localIso(createdAt).replace("T", " ").slice(0, 16);
  const lines = ["# Transcript — Screen recording", "", `_${day} · ${clock(durationSec)}_`, ""];
  for (const s of segments) {
    lines.push(`**[${clock(s.start)}]**${s.speaker ? ` ${s.speaker}:` : ""} ${s.text}`.trimEnd());
    const extra = [
      s.screen ? `_On screen: ${s.screen}_` : null,
      s.did ? `_Did: ${s.did}_` : null,
    ].filter((x): x is string => x !== null);
    if (extra.length) lines.push(extra.join("  \n"));
    lines.push("");
  }
  return lines.join("\n");
}

/** The folder's files, or null when there is nothing to write notes from. */
export function buildMeetingCopy(input: MeetingCopyInput): MeetingCopy | null {
  const durationSec = Math.max(0, Math.round(input.durationMs / 1000));
  const segments = meetingSegments(input.timeline, input.speech, input.visual, durationSec);
  if (segments.length === 0) return null;
  const folder = meetingFolderName(input.createdAt);
  const meeting = {
    id: input.id,
    title: "",
    created_at: localIso(input.createdAt),
    source: "screen",
    template: "screen",
    language: "auto",
    status: "summarizing",
    progress: "Writing notes…",
    error: "",
    duration: durationSec,
    tracks: {},
    share: null,
    chat: [],
    usage: {},
    folder,
    screen: {
      drive_key: input.driveKey,
      share_url: input.shareUrl,
      share_expires_at: input.shareExpiresAt,
      width: input.width,
      height: input.height,
      from: "uno-work",
    },
  };
  return {
    folder,
    files: [
      { name: "transcript.json", contents: JSON.stringify(segments, null, 2) },
      { name: "transcript.md", contents: transcriptMd(input.createdAt, durationSec, segments) },
      { name: "meeting.json", contents: JSON.stringify(meeting, null, 2) },
    ],
  };
}

export interface MeetingCopyDeps {
  readonly homePath: () => Promise<string>;
  /** Whether a folder exists (absolute path). */
  readonly folderExists: (path: string) => Promise<boolean>;
  readonly writeFile: (input: {
    cwd: string;
    relativePath: string;
    contents: string;
    encoding?: "utf8" | "base64";
    mode?: "replace" | "append";
  }) => Promise<unknown>;
}

/**
 * Writes the folder when Notetaker is there. Returns the folder's path from
 * home (`Meetings/…`), or null when it was not written (no Notetaker, nothing
 * to write). A clash with an existing folder of the same minute gets " (2)".
 */
export async function copyToMeetings(
  input: MeetingCopyInput,
  deps: MeetingCopyDeps,
): Promise<string | null> {
  const copy = buildMeetingCopy(input);
  if (!copy) return null;
  const home = (await deps.homePath()).replace(/\/+$/, "");
  if (!(await deps.folderExists(`${home}/${MEETINGS_DIR}`))) return null;
  let folder = copy.folder;
  for (let n = 2; await deps.folderExists(`${home}/${MEETINGS_DIR}/${folder}`); n++) {
    folder = `${copy.folder} (${n})`;
  }
  for (const file of copy.files) {
    const contents =
      file.name === "meeting.json" && folder !== copy.folder
        ? JSON.stringify({ ...JSON.parse(file.contents), folder }, null, 2)
        : file.contents;
    await deps.writeFile({
      cwd: home,
      relativePath: `${MEETINGS_DIR}/${folder}/${file.name}`,
      contents,
      encoding: "utf8",
      mode: "replace",
    });
  }
  return `${MEETINGS_DIR}/${folder}`;
}
