/**
 * `recording_frames`: frames from the person's screen recording (Loom Work),
 * so an agent can look closer at "0:12–0:15" than the timeline and the few
 * key frames it got with the message.
 *
 * The recording is a file on this computer or an Uno Drive key
 * (`Recordings/<name>.webm|mp4`, maybe with `<name>.events.json` next to it:
 * clicks and cursor moves, x/y relative to the frame). A Drive file is
 * downloaded once into `~/.uno-recordings/cache/` (named by a hash of its
 * key) and reused; ffmpeg cuts JPEG frames into
 * `~/.uno-recordings/frames/<name>-<from>-<to>/`, so a harness that doesn't
 * show MCP pictures can still open them by path. Both folders lose what is
 * older than 7 days, opportunistically.
 *
 * Pure parts (time parsing and formatting, the plan of a call, ffmpeg's
 * argv, event lookup, cache names) come first; the runner with the file
 * system and ffmpeg is at the end.
 *
 * @module unoWork/recordingFrames
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fsp } from "node:fs";
import path from "node:path";

// ── Limits ─────────────────────────────────────────────────────────────

export const RECORDING_FRAMES = {
  /** One call covers at most this many seconds. */
  maxSpanSec: 60,
  /** `to` defaults to `from` + this. */
  defaultSpanSec: 3,
  fps: { default: 2, min: 0.2, max: 5 },
  /** Each picture costs the model ~1–1.5k tokens. */
  maxFrames: { default: 6, cap: 12 },
  width: { default: 1280, min: 320, max: 1600 },
  ffmpegTimeoutMs: 60_000,
  /** Cache and frame folders older than this are deleted. */
  keepMs: 7 * 24 * 60 * 60 * 1000,
} as const;

/** Where ffmpeg may live when the daemon's PATH doesn't have it (Electron on a Mac). */
export const FFMPEG_EXTRA_DIRS: ReadonlyArray<string> = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
];

export const FFMPEG_MISSING_MESSAGE =
  "ffmpeg isn't on this computer, and recording_frames needs it to cut frames. Install it — Linux: `sudo apt-get install -y ffmpeg`, macOS: `brew install ffmpeg` — then call recording_frames again.";

export class RecordingFramesError extends Error {
  override readonly name = "RecordingFramesError";
}

function fail(message: string): never {
  throw new RecordingFramesError(message);
}

// ── Time ───────────────────────────────────────────────────────────────

/**
 * Seconds from "m:ss", "m:ss.s", "h:mm:ss", "12", "12.5", "12s" or a number;
 * null when it isn't a time.
 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  const seconds = /^(\d+(?:\.\d+)?)s?$/.exec(text);
  if (seconds) return Number(seconds[1]);
  const minutes = /^(\d+):([0-5]?\d(?:\.\d+)?)$/.exec(text);
  if (minutes) return Number(minutes[1]) * 60 + Number(minutes[2]);
  const hours = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(text);
  if (hours) return Number(hours[1]) * 3600 + Number(hours[2]) * 60 + Number(hours[3]);
  return null;
}

/** "0:12", "0:12.5", "1:02:03.5" (tenths of a second, only when not whole). */
export function formatTimestamp(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const whole = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ss = `${String(s).padStart(2, "0")}${fraction ? `.${fraction}` : ""}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const roundTo = (value: number, digits: number) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

// ── The plan of one call ───────────────────────────────────────────────

export interface FramesArgs {
  readonly from: unknown;
  readonly to?: unknown;
  readonly fps?: number | undefined;
  readonly maxFrames?: number | undefined;
  readonly width?: number | undefined;
}

export interface FramesPlan {
  readonly fromSec: number;
  /** The end asked for (or from + 3 s), cut at the recording's end when known. */
  readonly toSec: number;
  readonly fps: number;
  readonly width: number;
  /** Frames ffmpeg is asked for: min(maxFrames, what the span holds at fps). */
  readonly frameCount: number;
  /** Seconds ffmpeg reads (frameCount / fps, at most the span). */
  readonly readSec: number;
  /** maxFrames cut the span short: the frames end before `toSec`. */
  readonly truncated: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const TIME_HINT = 'a time like "0:12", "1:02.5", "1:02:03" or seconds ("12.5")';

/** Validates and clamps the arguments; `durationSec` (when known) bounds the range. */
export function planFrames(
  args: FramesArgs,
  durationSec: number | null,
):
  | { readonly ok: true; readonly plan: FramesPlan }
  | { readonly ok: false; readonly error: string } {
  const fromSec = parseTimestamp(args.from);
  if (fromSec === null) return { ok: false, error: `"from" must be ${TIME_HINT}.` };
  let toSec = fromSec + RECORDING_FRAMES.defaultSpanSec;
  if (args.to !== undefined && args.to !== null && args.to !== "") {
    const parsed = parseTimestamp(args.to);
    if (parsed === null) return { ok: false, error: `"to" must be ${TIME_HINT}.` };
    toSec = parsed;
  }
  if (toSec <= fromSec) {
    return {
      ok: false,
      error: `"to" (${formatTimestamp(toSec)}) must be after "from" (${formatTimestamp(fromSec)}).`,
    };
  }
  if (toSec - fromSec > RECORDING_FRAMES.maxSpanSec + 1e-9) {
    return {
      ok: false,
      error: `That's ${roundTo(toSec - fromSec, 1)} s; one call covers at most ${RECORDING_FRAMES.maxSpanSec} s. Ask for a shorter piece, e.g. from ${formatTimestamp(fromSec)} to ${formatTimestamp(fromSec + RECORDING_FRAMES.maxSpanSec)}.`,
    };
  }
  if (durationSec !== null && durationSec > 0) {
    if (fromSec >= durationSec) {
      return {
        ok: false,
        error: `"from" ${formatTimestamp(fromSec)} is past the end: the recording is ${formatTimestamp(durationSec)} long.`,
      };
    }
    toSec = Math.min(toSec, durationSec);
  }
  const fps = clamp(
    args.fps ?? RECORDING_FRAMES.fps.default,
    RECORDING_FRAMES.fps.min,
    RECORDING_FRAMES.fps.max,
  );
  const maxFrames = Math.round(
    clamp(args.maxFrames ?? RECORDING_FRAMES.maxFrames.default, 1, RECORDING_FRAMES.maxFrames.cap),
  );
  const width = Math.round(
    clamp(
      args.width ?? RECORDING_FRAMES.width.default,
      RECORDING_FRAMES.width.min,
      RECORDING_FRAMES.width.max,
    ),
  );
  const span = toSec - fromSec;
  // Frames at from, from + 1/fps, … strictly before `to` (at least one).
  const fits = Math.max(1, Math.ceil(span * fps - 1e-6));
  const frameCount = Math.min(maxFrames, fits);
  return {
    ok: true,
    plan: {
      fromSec,
      toSec,
      fps,
      width,
      frameCount,
      readSec: Math.min(span, frameCount / fps),
      truncated: frameCount < fits,
    },
  };
}

/** Where frame `index` (0-based) sits in the recording. */
export function frameSeconds(plan: Pick<FramesPlan, "fromSec" | "fps">, index: number): number {
  return plan.fromSec + index / plan.fps;
}

/** ffmpeg's arguments (an argv, never a shell line): input seek, fps, scale, JPEGs. */
export function ffmpegFrameArgs(plan: FramesPlan, input: string, outDir: string): string[] {
  const fps = roundTo(plan.fps, 4);
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-ss",
    plan.fromSec.toFixed(3),
    "-i",
    input,
    "-t",
    plan.readSec.toFixed(3),
    "-an",
    "-vf",
    `fps=${fps},scale='min(${plan.width},iw)':-2`,
    "-frames:v",
    String(plan.frameCount),
    "-q:v",
    "4",
    path.join(outDir, "f-%03d.jpg"),
  ];
}

/** ffprobe's arguments for the container's duration in seconds. */
export function ffprobeDurationArgs(input: string): string[] {
  return [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    input,
  ];
}

/** ffprobe's answer → seconds; null for "N/A" (a MediaRecorder WebM has none) or junk. */
export function parseProbeDuration(output: string): number | null {
  const value = Number(output.trim().split(/\s+/)[0]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// ── Events (`<name>.events.json`) ──────────────────────────────────────

export interface RecordingEvent {
  /** Milliseconds from the start of the video. */
  readonly t: number;
  readonly kind: "click" | "move" | "scene";
  readonly x?: number;
  readonly y?: number;
}

export interface RecordingEvents {
  readonly durationMs: number | null;
  readonly events: ReadonlyArray<RecordingEvent>;
}

const unit = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;

/** The events file, tolerant: unknown kinds and broken entries are dropped; null if not one. */
export function parseRecordingEvents(raw: unknown): RecordingEvents | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.events)) return null;
  const events: RecordingEvent[] = [];
  for (const entry of record.events as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const event = entry as Record<string, unknown>;
    const t = event.t;
    const kind = event.kind;
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0) continue;
    if (kind !== "click" && kind !== "move" && kind !== "scene") continue;
    const x = unit(event.x);
    const y = unit(event.y);
    events.push({
      t,
      kind,
      ...(x !== undefined && y !== undefined ? { x, y } : {}),
    });
  }
  events.sort((a, b) => a.t - b.t);
  const durationMs =
    typeof record.durationMs === "number" &&
    Number.isFinite(record.durationMs) &&
    record.durationMs > 0
      ? record.durationMs
      : null;
  return { durationMs, events };
}

export interface FrameEvents {
  readonly clicks: ReadonlyArray<{ readonly t: string; readonly x?: number; readonly y?: number }>;
  readonly cursor: { readonly x: number; readonly y: number } | null;
}

/** Clicks within ±0.5 s of the frame; the cursor = the nearest move/click within 1 s. */
export function eventsAtFrame(events: RecordingEvents | null, seconds: number): FrameEvents {
  if (!events) return { clicks: [], cursor: null };
  const at = seconds * 1000;
  const clicks = events.events
    .filter((event) => event.kind === "click" && Math.abs(event.t - at) <= 500)
    .map((event) => ({
      t: formatTimestamp(event.t / 1000),
      ...(event.x !== undefined && event.y !== undefined
        ? { x: roundTo(event.x, 3), y: roundTo(event.y, 3) }
        : {}),
    }));
  let cursor: { x: number; y: number } | null = null;
  let best = Infinity;
  for (const event of events.events) {
    if (event.kind === "scene" || event.x === undefined || event.y === undefined) continue;
    const distance = Math.abs(event.t - at);
    if (distance <= 1000 && distance < best) {
      best = distance;
      cursor = { x: roundTo(event.x, 3), y: roundTo(event.y, 3) };
    }
  }
  return { clicks, cursor };
}

// ── Names ──────────────────────────────────────────────────────────────

/** `Recordings/a.webm` → `Recordings/a.events.json`. */
export function eventsKeyFor(videoKey: string): string {
  const ext = path.posix.extname(videoKey);
  return `${ext ? videoKey.slice(0, -ext.length) : videoKey}.events.json`;
}

/** The cache file's base name: a hash of the Drive key (same key → same file). */
export function cacheBaseName(driveKey: string): string {
  return createHash("sha256").update(driveKey).digest("hex").slice(0, 24);
}

/** The video's extension for the cached copy (ffmpeg goes by content, this is for people). */
export function videoExtension(name: string): string {
  const ext = path.posix.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ".video";
}

/** "Screen recording 2026-10-28 at 14.42.54.webm" → "screen-recording-2026-10-28-at-14-42-54". */
export function recordingSlug(name: string): string {
  const base = path.posix.basename(name.replace(/\\/g, "/"));
  const ext = path.posix.extname(base);
  const slug = (ext ? base.slice(0, -ext.length) : base)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "recording";
}

const secondsTag = (seconds: number) => `${roundTo(seconds, 1)}s`;

/** `<slug>-<from>-<to>`, e.g. "screen-recording-…-12s-15.5s". */
export function framesFolderName(name: string, fromSec: number, toSec: number): string {
  return `${recordingSlug(name)}-${secondsTag(fromSec)}-${secondsTag(toSec)}`;
}

/** `candidate` is `root` or inside it (both already resolved). */
export function isInsideFolder(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** A Drive key or a path on this computer (absolute or `~`). */
export function isLocalRecordingPath(recording: string): boolean {
  const value = recording.trim();
  return value === "~" || value.startsWith("~/") || path.isAbsolute(value);
}

// ── ffmpeg on this computer ────────────────────────────────────────────

const canExecute = (candidate: string) =>
  fsp.access(candidate, fsConstants.X_OK).then(
    () => fsp.stat(candidate).then((stats) => stats.isFile()),
    () => false,
  );

/** The first runnable `name` on PATH, then in `extraDirs`; null when none. */
export async function findExecutable(
  name: string,
  options: {
    readonly pathEnv?: string | undefined;
    readonly extraDirs?: ReadonlyArray<string>;
    readonly isExecutable?: (candidate: string) => Promise<boolean>;
  } = {},
): Promise<string | null> {
  const isExecutable = options.isExecutable ?? canExecute;
  const dirs = [
    ...(options.pathEnv ?? "").split(path.delimiter).filter(Boolean),
    ...(options.extraDirs ?? FFMPEG_EXTRA_DIRS),
  ];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export interface FfmpegTools {
  readonly ffmpeg: string;
  /** Measures the duration; null when missing (then the events file's durationMs). */
  readonly ffprobe: string | null;
}

/** ffmpeg (and ffprobe, preferably next to it) on this computer; null without ffmpeg. */
export async function findFfmpegTools(pathEnv = process.env.PATH): Promise<FfmpegTools | null> {
  const ffmpeg = await findExecutable("ffmpeg", { pathEnv });
  if (!ffmpeg) return null;
  const sibling = path.join(path.dirname(ffmpeg), "ffprobe");
  const ffprobe = (await canExecute(sibling))
    ? sibling
    : await findExecutable("ffprobe", { pathEnv });
  return { ffmpeg, ffprobe };
}

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Output kept from a child process: the first ~8 KB is enough to explain a failure. */
const keep = (current: string, chunk: Buffer) =>
  current.length > 8_000 ? current : current + chunk.toString("utf8");

/** Runs a program with an argv (no shell), killing it after `timeoutMs`. */
export function runProcess(
  bin: string,
  argv: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = keep(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = keep(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Deletes entries of `dir` not touched for `maxAgeMs` (files and folders). */
export async function pruneOlderThan(dir: string, maxAgeMs: number, now: number): Promise<void> {
  const entries = await fsp.readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    const target = path.join(dir, entry);
    const stats = await fsp.lstat(target).catch(() => null);
    if (stats && now - stats.mtimeMs > maxAgeMs) {
      await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// ── The runner ─────────────────────────────────────────────────────────

export interface RecordingFramesInput extends FramesArgs {
  readonly home: string;
  /** A Drive key ("Recordings/….webm") or a path on this computer (absolute or ~). */
  readonly recording: string;
  /** `~/x` → absolute (the tools' resolveUserPath). */
  readonly resolveLocalPath: (raw: string) => string;
  /**
   * Uno Drive: copy one key into `folder` (an existing, empty folder) and
   * return where it landed. Absent where Uno Drive isn't wired.
   */
  readonly driveDownload?: (key: string, folder: string) => Promise<string>;
  /** Tests: ffmpeg's location (null = not installed). Default: looked up. */
  readonly tools?: FfmpegTools | null;
  readonly now?: number;
}

export interface RecordingFrame {
  /** 0:12.5 */
  readonly t: string;
  readonly seconds: number;
  /** Absolute path of the JPEG. */
  readonly file: string;
  readonly jpegBase64: string;
  readonly clicks: FrameEvents["clicks"];
  readonly cursor: FrameEvents["cursor"];
}

export interface RecordingFramesResult {
  readonly recording: string;
  readonly plan: FramesPlan;
  readonly durationSec: number | null;
  readonly folder: string;
  readonly frames: ReadonlyArray<RecordingFrame>;
  readonly hasEvents: boolean;
}

export const recordingsRoot = (home: string) => path.join(home, ".uno-recordings");

interface CacheMeta {
  readonly key: string;
  readonly size: number;
  readonly fetchedAt: string;
  readonly events: boolean;
}

const exists = (target: string) => fsp.stat(target).then(Boolean, () => false);

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
};

/** A Drive recording in the cache: downloaded once per key, reused after. */
async function cachedDriveRecording(
  input: RecordingFramesInput,
  key: string,
  now: number,
): Promise<{ video: string; events: string | null }> {
  if (key.endsWith("/"))
    fail(`"${key}" is a folder: name one recording file, e.g. "Recordings/<name>.webm".`);
  if (!input.driveDownload) fail("Uno Drive isn't available in this Uno Work version.");
  const cacheDir = path.join(recordingsRoot(input.home), "cache");
  await fsp.mkdir(cacheDir, { recursive: true });
  await pruneOlderThan(cacheDir, RECORDING_FRAMES.keepMs, now);
  const base = cacheBaseName(key);
  const video = path.join(cacheDir, `${base}${videoExtension(key)}`);
  const eventsFile = path.join(cacheDir, `${base}.events.json`);
  const metaFile = path.join(cacheDir, `${base}.meta.json`);
  const meta = (await readJson(metaFile)) as Partial<CacheMeta> | null;
  const stats = await fsp.stat(video).catch(() => null);
  if (stats && meta?.key === key && meta.size === stats.size) {
    // Touched on use: a recording looked at all week stays cached.
    const touch = new Date(now);
    for (const file of [video, metaFile, ...(meta.events ? [eventsFile] : [])]) {
      await fsp.utimes(file, touch, touch).catch(() => undefined);
    }
    return { video, events: meta.events && (await exists(eventsFile)) ? eventsFile : null };
  }
  const staging = await fsp.mkdtemp(path.join(cacheDir, `.dl-${base}-`));
  try {
    const landed = await input.driveDownload!(key, staging);
    await fsp.rename(landed, video);
    let events = false;
    try {
      const landedEvents = await input.driveDownload!(eventsKeyFor(key), staging);
      await fsp.rename(landedEvents, eventsFile);
      events = true;
    } catch {
      // No events file next to it: frames without clicks and cursor.
      await fsp.rm(eventsFile, { force: true });
    }
    const size = (await fsp.stat(video)).size;
    const record: CacheMeta = { key, size, fetchedAt: new Date(now).toISOString(), events };
    await fsp.writeFile(metaFile, JSON.stringify(record));
    return { video, events: events ? eventsFile : null };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** A recording already on this computer: only inside the home folder. */
async function localRecording(
  input: RecordingFramesInput,
): Promise<{ video: string; events: string | null }> {
  const absolute = input.resolveLocalPath(input.recording);
  const real = await fsp.realpath(absolute).catch(() => null);
  const home = await fsp.realpath(input.home).catch(() => input.home);
  if (real === null) {
    return fail(
      `No file at ${input.recording} on this computer. For a recording in Uno Drive pass its key, e.g. "Recordings/<name>.webm" (drive_find lists them).`,
    );
  }
  if (!isInsideFolder(real, home))
    fail("Only recordings inside the home folder (~) can be opened.");
  const stats = await fsp.stat(real);
  if (!stats.isFile()) fail(`${input.recording} is a folder: name one recording file.`);
  const ext = path.extname(real);
  const eventsFile = `${ext ? real.slice(0, -ext.length) : real}.events.json`;
  return { video: real, events: (await exists(eventsFile)) ? eventsFile : null };
}

/** Frames of a recording between two moments, as JPEG files and base64. */
export async function recordingFrames(input: RecordingFramesInput): Promise<RecordingFramesResult> {
  const now = input.now ?? Date.now();
  const recording = input.recording.trim();
  if (!recording)
    fail('Name the recording: an Uno Drive key like "Recordings/<name>.webm" or a path.');
  // Bad times fail before anything is downloaded.
  const early = planFrames(input, null);
  if (!early.ok) return fail(early.error);
  const tools = input.tools === undefined ? await findFfmpegTools() : input.tools;
  if (!tools) return fail(FFMPEG_MISSING_MESSAGE);

  const source = isLocalRecordingPath(recording)
    ? await localRecording({ ...input, recording })
    : await cachedDriveRecording(input, recording.replace(/^\/+/, ""), now);
  const events = source.events ? parseRecordingEvents(await readJson(source.events)) : null;

  let durationSec: number | null = null;
  if (tools.ffprobe) {
    const probe = await runProcess(tools.ffprobe, ffprobeDurationArgs(source.video), 15_000);
    if (probe.code === 0) durationSec = parseProbeDuration(probe.stdout);
  }
  if (durationSec === null && events?.durationMs) durationSec = events.durationMs / 1000;

  const planned = planFrames(input, durationSec);
  if (!planned.ok) return fail(planned.error);
  const plan = planned.plan;

  const framesRoot = path.join(recordingsRoot(input.home), "frames");
  await fsp.mkdir(framesRoot, { recursive: true });
  await pruneOlderThan(framesRoot, RECORDING_FRAMES.keepMs, now);
  const folder = path.join(framesRoot, framesFolderName(recording, plan.fromSec, plan.toSec));
  await fsp.rm(folder, { recursive: true, force: true });
  await fsp.mkdir(folder, { recursive: true });

  const run = await runProcess(
    tools.ffmpeg,
    ffmpegFrameArgs(plan, source.video, folder),
    RECORDING_FRAMES.ffmpegTimeoutMs,
  );
  if (run.timedOut) {
    fail(
      `ffmpeg took over ${RECORDING_FRAMES.ffmpegTimeoutMs / 1000} s and was stopped. Ask for a shorter piece or fewer frames.`,
    );
  }
  const files = (await fsp.readdir(folder).catch(() => [] as string[]))
    .filter((name) => /^f-\d{3}\.jpg$/.test(name))
    .toSorted();
  if (files.length === 0) {
    if (run.code !== 0) {
      const reason = run.stderr.trim().split("\n")[0] ?? "";
      fail(`ffmpeg couldn't read the recording${reason ? `: ${reason}` : "."}`);
    }
    fail(
      durationSec !== null
        ? `No frames there — the recording is ${formatTimestamp(durationSec)} long.`
        : `No frames there — ${formatTimestamp(plan.fromSec)} is probably past the end of the recording.`,
    );
  }
  const frames: RecordingFrame[] = [];
  for (const [index, name] of files.entries()) {
    const seconds = frameSeconds(plan, index);
    const file = path.join(folder, name);
    frames.push({
      t: formatTimestamp(seconds),
      seconds,
      file,
      jpegBase64: (await fsp.readFile(file)).toString("base64"),
      ...eventsAtFrame(events, seconds),
    });
  }
  return { recording, plan, durationSec, folder, frames, hasEvents: events !== null };
}

/** The JSON the agent reads after the pictures (paths spelled by `display`). */
export function recordingFramesSummary(
  result: RecordingFramesResult,
  display: (absolute: string) => string,
) {
  const { plan } = result;
  const last = result.frames.at(-1);
  const coveredTo = last ? last.seconds + 1 / plan.fps : plan.toSec;
  return {
    recording: result.recording,
    from: formatTimestamp(plan.fromSec),
    to: formatTimestamp(plan.toSec),
    fps: roundTo(plan.fps, 2),
    ...(result.durationSec !== null ? { duration: formatTimestamp(result.durationSec) } : {}),
    folder: display(result.folder),
    frames: result.frames.map((frame) => ({
      t: frame.t,
      path: display(frame.file),
      clicks: frame.clicks,
      cursor: frame.cursor,
    })),
    ...(plan.truncated && coveredTo < plan.toSec
      ? {
          note: `maxFrames stopped at ${result.frames.length} frames (up to ${formatTimestamp(coveredTo)}). For the rest call again with from "${formatTimestamp(coveredTo)}", or a lower fps.`,
        }
      : {}),
    ...(!result.hasEvents ? { events: "none: no clicks or cursor data for this recording" } : {}),
  };
}
