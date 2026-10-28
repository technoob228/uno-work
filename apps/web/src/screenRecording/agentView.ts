/**
 * Loom Work, second by second (Misha 28.10, «давай так»): the agent gets a
 * timeline with time marks and a few key frames as pictures, and can ask for
 * more frames itself (the `recording_frames` tool of uno-work).
 *
 * This file is the pure part:
 * - the **event track** — clicks and cursor moves Work sees, as fractions of
 *   the video frame (`mapPointerToFrame`), saved next to the video in Drive;
 * - **key frames** — candidates come from the recorder (clicks, screen
 *   changes, the first picture) and from the timeline (the moments the
 *   person says "вот", "тут", "this", "here"…); `selectKeyFrames` keeps a few
 *   (`keyFrameBudget`) by priority, spread over time;
 * - the **timeline** lines the agent reads (`formatTimeline`).
 *
 * Price: a picture of 1280×720 is ~1.2k tokens on Claude (w·h/750), ~1.1k on
 * GPT; the default budget is 8–12 frames (≈10–15k tokens), never above
 * KEY_FRAMES_MAX.
 */

// ── Event track ──────────────────────────────────────────────────────────

export type RecordingEventKind = "click" | "move" | "scene";

export interface RecordingEvent {
  /** Recording time, ms (pauses excluded). */
  readonly t: number;
  readonly kind: RecordingEventKind;
  /** 0..1 of the video frame from the top-left; absent when not known. */
  readonly x?: number;
  readonly y?: number;
}

/** Where the person's pointer was, in the page's own terms. */
export interface PointerSample {
  readonly kind: "click" | "move";
  readonly clientX: number;
  readonly clientY: number;
  readonly screenX: number;
  readonly screenY: number;
}

/** The page's window and the screen it is on (CSS pixels). */
export interface ViewportInfo {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly outerWidth: number;
  readonly outerHeight: number;
  readonly screenWidth: number;
  readonly screenHeight: number;
  /** The screen's origin among all screens (Chrome `screen.left/top`; 0 elsewhere). */
  readonly screenLeft: number;
  readonly screenTop: number;
}

/** What the screen share is: `track.getSettings().displaySurface`. */
export type DisplaySurface = "monitor" | "window" | "browser" | "unknown";

const ASPECT_TOLERANCE = 0.04;

function aspectMatches(width: number, height: number, frameW: number, frameH: number): boolean {
  if (width <= 0 || height <= 0 || frameW <= 0 || frameH <= 0) return false;
  const a = width / height;
  const b = frameW / frameH;
  return Math.abs(a - b) / b <= ASPECT_TOLERANCE;
}

function unit(value: number): number | null {
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return Math.round(value * 10_000) / 10_000;
}

/**
 * A pointer event in Work → where it is in the video, or null when Work
 * can't know (another tab or window is shared, a screen of another size).
 *
 * - `monitor`: the screen Work is on is the one shared (same proportions).
 * - `window`: Work's own window (same proportions as the outer window); the
 *   page sits under the browser's toolbar, centred sideways.
 * - `browser`: Work's own tab (same proportions as the page).
 */
export function mapPointerToFrame(
  sample: Pick<PointerSample, "clientX" | "clientY" | "screenX" | "screenY">,
  surface: DisplaySurface,
  view: ViewportInfo,
  frame: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } | null {
  let x: number | null = null;
  let y: number | null = null;
  if (surface === "monitor") {
    if (!aspectMatches(view.screenWidth, view.screenHeight, frame.width, frame.height)) return null;
    x = unit((sample.screenX - view.screenLeft) / view.screenWidth);
    y = unit((sample.screenY - view.screenTop) / view.screenHeight);
  } else if (surface === "window") {
    if (!aspectMatches(view.outerWidth, view.outerHeight, frame.width, frame.height)) return null;
    const side = Math.max(0, (view.outerWidth - view.innerWidth) / 2);
    const top = Math.max(0, view.outerHeight - view.innerHeight - side);
    x = unit((sample.clientX + side) / view.outerWidth);
    y = unit((sample.clientY + top) / view.outerHeight);
  } else if (surface === "browser") {
    if (!aspectMatches(view.innerWidth, view.innerHeight, frame.width, frame.height)) return null;
    x = unit(sample.clientX / view.innerWidth);
    y = unit(sample.clientY / view.innerHeight);
  }
  return x === null || y === null ? null : { x, y };
}

/** The event track grows at most this long (≈ 10 moves a second for 30 min). */
export const RECORDING_EVENTS_MAX = 20_000;
/** Cursor moves are kept at most this often. */
export const MOVE_SAMPLE_MS = 100;

/** `Recordings/Screen recording … .webm` → `Recordings/Screen recording … .events.json`. */
export function recordingEventsName(videoName: string): string {
  return `${videoName.replace(/\.[a-z0-9]+$/i, "")}.events.json`;
}

export interface RecordingEventsFile {
  readonly version: 1;
  readonly video: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly events: ReadonlyArray<RecordingEvent>;
}

export function recordingEventsFile(input: {
  readonly videoName: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly events: ReadonlyArray<RecordingEvent>;
}): RecordingEventsFile {
  return {
    version: 1,
    video: input.videoName,
    width: input.width,
    height: input.height,
    durationMs: Math.round(input.durationMs),
    events: input.events.slice(0, RECORDING_EVENTS_MAX).map((event) => ({
      t: Math.round(event.t),
      kind: event.kind,
      ...(event.x !== undefined && event.y !== undefined ? { x: event.x, y: event.y } : {}),
    })),
  };
}

/** Clicks for the gateway's timeline (seconds, ≤ 2000). */
export function clicksForDescribe(
  events: ReadonlyArray<RecordingEvent>,
): Array<{ t: number; kind: "click"; x?: number; y?: number }> {
  return events
    .filter((event) => event.kind === "click")
    .slice(0, 2000)
    .map((event) => ({
      t: Math.round(event.t / 100) / 10,
      kind: "click" as const,
      ...(event.x !== undefined && event.y !== undefined ? { x: event.x, y: event.y } : {}),
    }));
}

/** The latest known cursor position at `t` (within `windowMs`), or null. */
export function cursorAt(
  events: ReadonlyArray<RecordingEvent>,
  t: number,
  windowMs = 1000,
): { readonly x: number; readonly y: number } | null {
  let best: RecordingEvent | null = null;
  for (const event of events) {
    if (event.kind === "scene" || event.x === undefined || event.y === undefined) continue;
    if (Math.abs(event.t - t) > windowMs) continue;
    if (!best || Math.abs(event.t - t) < Math.abs(best.t - t)) best = event;
  }
  return best && best.x !== undefined && best.y !== undefined ? { x: best.x, y: best.y } : null;
}

// ── Timeline ─────────────────────────────────────────────────────────────

export interface TimelineEntry {
  /** Seconds from the start. */
  readonly t: number;
  readonly say: string;
  readonly see: string;
  readonly do: string;
}

/** "0:07", "4:05", "1:02:03" from seconds. */
export function clockSec(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** `[0:12] says "эта кнопка" — cursor on Save, top-right; click → error 500`. */
export function formatTimelineLine(entry: TimelineEntry): string {
  const parts: string[] = [];
  const say = entry.say.trim();
  const see = entry.see.trim();
  const act = entry.do.trim();
  if (say) parts.push(`says "${say}"`);
  if (see) parts.push(parts.length > 0 ? `— ${see}` : see);
  if (act) parts.push(parts.length > 0 ? `; ${act}` : act);
  return `[${clockSec(entry.t)}] ${parts.join(" ")}`.trimEnd();
}

export function formatTimeline(entries: ReadonlyArray<TimelineEntry>): string {
  return entries.map(formatTimelineLine).join("\n");
}

/** A timeline the daemon passed on (defensive: drops junk, keeps order). */
export function normalizeTimeline(raw: unknown): TimelineEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: TimelineEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const t = typeof record.t === "number" && Number.isFinite(record.t) ? record.t : null;
    if (t === null || t < 0) continue;
    const text = (key: string) => (typeof record[key] === "string" ? String(record[key]) : "");
    out.push({ t, say: text("say"), see: text("see"), do: text("do") });
  }
  return out.sort((a, b) => a.t - b.t).slice(0, 400);
}

/**
 * Words that point at something on screen — the moment to show the agent a
 * picture: «вот», «тут», «здесь», «эта/этот/это», «сюда», "this", "here",
 * "that", "there".
 */
const POINTING_WORDS =
  /(?:^|[^\p{L}])(вот|тут|здесь|сюда|там|эт(?:а|от|о|у|ой|ом|и|их)|this|here|that|there|these|those)(?=$|[^\p{L}])/iu;

export function isPointingSpeech(text: string): boolean {
  return POINTING_WORDS.test(text);
}

/** Seconds where the person points with words (from the timeline). */
export function pointingMoments(timeline: ReadonlyArray<TimelineEntry>): number[] {
  return timeline.filter((entry) => isPointingSpeech(entry.say)).map((entry) => entry.t);
}

// ── Key frames ───────────────────────────────────────────────────────────

export type KeyFrameReason = "pointing" | "click" | "scene" | "start";

export interface KeyFrameCandidate {
  /** Recording time, ms. */
  readonly t: number;
  readonly reason: KeyFrameReason;
}

/** Never more pictures than this in one message (also the schema's extra room). */
export const KEY_FRAMES_MAX = 24;

/**
 * How many pictures go with the message: few by default (a picture is
 * ~1.2k tokens), a little more for a long recording.
 */
export function keyFrameBudget(durationMs: number): number {
  if (durationMs <= 2 * 60_000) return 8;
  if (durationMs <= 10 * 60_000) return 12;
  return 20;
}

const PRIORITY: Record<KeyFrameReason, number> = { pointing: 4, click: 3, scene: 2, start: 1 };
/** Two candidates closer than this are one moment: the more telling one stays. */
const SAME_MOMENT_MS = 1500;

/**
 * Picks the frames: the more telling reasons first (pointing > click >
 * screen change > the first picture), one per moment; over the budget the
 * kept ones are spread over the recording. Sorted by time.
 */
export function selectKeyFrames<T extends KeyFrameCandidate>(
  candidates: ReadonlyArray<T>,
  budget: number,
): T[] {
  const limit = Math.max(0, Math.min(KEY_FRAMES_MAX, Math.floor(budget)));
  if (limit === 0) return [];
  const byPriority = [...candidates].sort(
    (a, b) => PRIORITY[b.reason] - PRIORITY[a.reason] || a.t - b.t,
  );
  const kept: T[] = [];
  for (const candidate of byPriority) {
    if (kept.some((other) => Math.abs(other.t - candidate.t) < SAME_MOMENT_MS)) continue;
    kept.push(candidate);
  }
  if (kept.length <= limit) return kept.sort((a, b) => a.t - b.t);
  // Over budget: take each priority level whole while it fits; the level
  // that doesn't fit is thinned evenly over time.
  const chosen: T[] = [];
  const levels = [...new Set(kept.map((c) => PRIORITY[c.reason]))].sort((a, b) => b - a);
  for (const level of levels) {
    const items = kept.filter((c) => PRIORITY[c.reason] === level).sort((a, b) => a.t - b.t);
    const room = limit - chosen.length;
    if (room <= 0) break;
    if (items.length <= room) {
      chosen.push(...items);
      continue;
    }
    for (let i = 0; i < room; i += 1) {
      const index = room === 1 ? 0 : Math.round((i * (items.length - 1)) / (room - 1));
      const item = items[index];
      if (item && !chosen.includes(item)) chosen.push(item);
    }
  }
  return chosen.sort((a, b) => a.t - b.t);
}

/** Attachment names carry the moment: `recording-frame 0m12.4s click.jpg`. */
export const KEY_FRAME_PREFIX = "recording-frame ";

export function keyFrameName(frame: KeyFrameCandidate): string {
  const totalTenths = Math.max(0, Math.round(frame.t / 100));
  const minutes = Math.floor(totalTenths / 600);
  const seconds = (totalTenths % 600) / 10;
  return `${KEY_FRAME_PREFIX}${minutes}m${seconds.toFixed(1)}s ${frame.reason}.jpg`;
}

export function parseKeyFrameName(name: string): KeyFrameCandidate | null {
  const match = /^recording-frame (\d+)m(\d+(?:\.\d)?)s (pointing|click|scene|start)\.jpg$/.exec(
    name,
  );
  if (!match) return null;
  const t = (Number(match[1]) * 60 + Number(match[2])) * 1000;
  return { t: Math.round(t), reason: match[3] as KeyFrameReason };
}

const REASON_WORDS: Record<KeyFrameReason, string> = {
  pointing: "they point with words",
  click: "a click (yellow ring)",
  scene: "the screen changed",
  start: "the first picture",
};

/** "[0:12] a click (yellow ring)" — one line per attached picture, in order. */
export function keyFrameLegend(frames: ReadonlyArray<KeyFrameCandidate>): string {
  return frames
    .map(
      (frame, index) => `${index + 1}. [${clockSec(frame.t / 1000)}] ${REASON_WORDS[frame.reason]}`,
    )
    .join("\n");
}
