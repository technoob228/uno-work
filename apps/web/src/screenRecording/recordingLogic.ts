/**
 * Loom Work (28.10, Misha): one button in the composer records the screen
 * (a whole screen, a window or a browser tab), the voice and — if wanted — the
 * camera in a circle in the corner. The video goes to Uno Drive
 * (`Recordings/`), the agent watches it (speech + what was on screen) and
 * gets it as a task: "do what I showed and said".
 *
 * This file is the pure part: names, limits, error wording, the block the
 * message carries for the agent and its parsing back for the chat.
 */

/** `POST /video/describe` watches up to 10 minutes, so a recording stops there. */
export const RECORDING_MAX_MS = 10 * 60 * 1000;
/** A minute before the limit the bar says so. */
export const RECORDING_WARN_MS = RECORDING_MAX_MS - 60 * 1000;
/** The agent copy must fit the gateway's 25 MB. */
export const AGENT_COPY_MAX_BYTES = 25 * 1024 * 1024;
export const RECORDINGS_FOLDER = "Recordings/";
/** Where the browser stages the files on the computer before Drive takes them. */
export const RECORDING_STAGING_DIR = ".uno-recordings";

export type CaptureSource = "screen" | "window" | "tab";

export interface RecordingOptions {
  readonly source: CaptureSource;
  readonly camera: boolean;
  readonly microphone: boolean;
}

export const DEFAULT_RECORDING_OPTIONS: RecordingOptions = {
  source: "screen",
  camera: true,
  microphone: true,
};

/**
 * WebM first where it records (Chrome, Edge, Firefox): MediaRecorder's MP4
 * leans on a platform H.264 encoder, and where there is none (headless,
 * some Linux/VMs) it writes a header and no frames — silently. Safari records
 * only MP4. (A share link playing everywhere is a server-side MP4 copy later.)
 */
export const RECORDER_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
  "video/mp4;codecs=avc1,opus",
  "video/mp4",
] as const;

export function pickRecorderMimeType(isTypeSupported: (type: string) => boolean): string | null {
  for (const candidate of RECORDER_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(candidate)) return candidate;
    } catch {
      // Some engines throw on codec strings they don't parse.
    }
  }
  return null;
}

/** `video/mp4;codecs=…` → `video/mp4`. */
export function baseMimeType(mimeType: string): string {
  return (mimeType.split(";")[0] ?? mimeType).trim() || "video/webm";
}

export function extensionForMime(mimeType: string): "mp4" | "webm" {
  return baseMimeType(mimeType) === "video/mp4" ? "mp4" : "webm";
}

const pad = (value: number) => String(value).padStart(2, "0");

/** "Screen recording 2026-10-28 at 14.05.32.mp4" (local time, like macOS screenshots). */
export function recordingFileName(date: Date, mimeType: string): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return `Screen recording ${day} at ${time}.${extensionForMime(mimeType)}`;
}

/** The recording's key in Uno Drive (copyToCloud keeps the file's own name). */
export function recordingDriveKey(name: string): string {
  return `${RECORDINGS_FOLDER}${name}`;
}

/** "0:07", "4:05", "1:02:03". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * What getDisplayMedia is asked for. The browser's own picker decides; the
 * hint only opens it on the right tab of the picker (Chrome) — "window" and
 * "tab" are not promises.
 */
export function displayMediaOptions(options: RecordingOptions): DisplayMediaStreamOptions {
  const displaySurface =
    options.source === "tab" ? "browser" : options.source === "window" ? "window" : "monitor";
  return {
    video: { displaySurface, frameRate: { ideal: 30, max: 30 } } as MediaTrackConstraints,
    // Tab/system sound when the browser offers it (Chrome: tabs, Windows: screen).
    audio: true,
    // Chrome-only hints; other browsers ignore unknown members.
    ...({
      selfBrowserSurface: "include",
      surfaceSwitching: "include",
      systemAudio: "include",
      monitorTypeSurfaces: "include",
    } as Record<string, string>),
  };
}

export type CaptureErrorKind = "cancelled" | "denied" | "unsupported" | "busy" | "failed";

export interface CaptureProblem {
  readonly kind: CaptureErrorKind;
  /** For the person; null when there is nothing to say (they closed the picker). */
  readonly message: string | null;
}

/**
 * getDisplayMedia / getUserMedia errors in words. Closing the picker is
 * `NotAllowedError` too — Chrome says "Permission denied by system" only when
 * macOS itself blocks screen recording.
 */
export function describeCaptureError(
  error: unknown,
  what: "screen" | "camera" | "microphone",
  platform: { readonly mac: boolean; readonly desktopApp: boolean } = {
    mac: false,
    desktopApp: false,
  },
): CaptureProblem {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    if (what === "screen") {
      if (/system/i.test(text)) {
        return {
          kind: "denied",
          message: platform.mac
            ? `macOS blocks screen recording for ${platform.desktopApp ? "Uno Work" : "your browser"}. Turn it on in System Settings → Privacy & Security → Screen & System Audio Recording, then reopen ${platform.desktopApp ? "Uno Work" : "the browser"}.`
            : "Your system blocked screen recording. Allow it for this app and try again.",
        };
      }
      return { kind: "cancelled", message: null };
    }
    return {
      kind: "denied",
      message: `No access to the ${what}. Allow it in the address bar (or system settings) — recording goes on without it.`,
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return { kind: "unsupported", message: `No ${what} found — recording goes on without it.` };
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return {
      kind: "busy",
      message: `The ${what} is busy in another app — recording goes on without it.`,
    };
  }
  if (name === "NotSupportedError" || name === "TypeError") {
    return {
      kind: "unsupported",
      message:
        what === "screen"
          ? "This browser can't record the screen. Use Chrome, Edge, Firefox or Safari on a computer (https)."
          : `This browser can't use the ${what}.`,
    };
  }
  return { kind: "failed", message: text || `Couldn't start the ${what}.` };
}

export function isScreenRecordingSupported(env: {
  readonly mediaDevices?: { getDisplayMedia?: unknown } | undefined;
  readonly MediaRecorder?: unknown;
  readonly isSecureContext?: boolean;
}): boolean {
  return (
    env.isSecureContext !== false &&
    typeof env.mediaDevices?.getDisplayMedia === "function" &&
    typeof env.MediaRecorder === "function"
  );
}

/** The person's Uno Drive has room for `size` more bytes; else what to say. */
export function driveSpaceProblem(
  drive: {
    readonly available: boolean;
    readonly usedBytes: number;
    readonly quotaBytes: number;
    readonly message?: string | null;
  },
  size: number,
): string | null {
  if (!drive.available) {
    return drive.message || "Uno Drive isn't connected on this computer.";
  }
  if (drive.quotaBytes > 0 && drive.usedBytes + size > drive.quotaBytes) {
    const free = Math.max(0, drive.quotaBytes - drive.usedBytes);
    return `Uno Drive is full: the recording is ${formatBytes(size)}, ${formatBytes(free)} left. Free some space or upgrade the plan.`;
  }
  return null;
}

/** Where the camera circle goes on a frame of `width`×`height` (bottom-left, like Loom). */
export function cameraBubbleRect(width: number, height: number) {
  const size = Math.round(Math.max(96, Math.min(width, height) * 0.22));
  const margin = Math.round(size * 0.18);
  return { x: margin, y: height - size - margin, size };
}

/** Canvas size for compositing: the screen's own size, at most 1920 wide. */
export function compositeSize(width: number, height: number) {
  const w = width > 0 ? width : 1280;
  const h = height > 0 ? height : 720;
  if (w <= 1920) return { width: even(w), height: even(h) };
  const scale = 1920 / w;
  return { width: 1920, height: even(h * scale) };
}

function even(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

// ── The message the agent gets ───────────────────────────────────────────

export interface RecordingForAgent {
  readonly name: string;
  readonly durationMs: number;
  readonly driveKey: string | null;
  readonly shareUrl: string | null;
  readonly speech: string;
  readonly visual: string;
}

const OPEN = "<screen_recording";
const CLOSE = "</screen_recording>";

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function unattr(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/**
 * The block after the person's words. Plain text the agent reads (no tool
 * needed), with where the full video is if it wants a closer look.
 */
export function buildRecordingBlock(recording: RecordingForAgent): string {
  const attrs = [
    `name="${attr(recording.name)}"`,
    `duration="${formatClock(recording.durationMs)}"`,
    recording.driveKey ? `drive_key="${attr(recording.driveKey)}"` : null,
    recording.shareUrl ? `link="${attr(recording.shareUrl)}"` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const lines = [
    `${OPEN} ${attrs}>`,
    "The person recorded their screen and talked you through it. Do what they showed and asked; if something is unclear, ask before acting.",
    "",
    "What they said:",
    recording.speech.trim() || "(nothing — the recording has no speech)",
    "",
    "What was on screen:",
    recording.visual.trim() || "(no description)",
  ];
  if (recording.driveKey) {
    lines.push(
      "",
      `The full video is in their Uno Drive at ${recording.driveKey}${recording.shareUrl ? ` (link: ${recording.shareUrl})` : ""} — open it with the Drive tools if you need a detail the summary misses.`,
    );
  }
  lines.push(CLOSE);
  return lines.join("\n");
}

export function appendRecordingToPrompt(
  prompt: string,
  recording: RecordingForAgent | null,
): string {
  if (!recording) return prompt;
  const block = buildRecordingBlock(recording);
  const trimmed = prompt.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
}

export interface ParsedRecording {
  readonly name: string;
  readonly duration: string;
  readonly driveKey: string | null;
  readonly shareUrl: string | null;
  readonly speech: string;
  readonly visual: string;
}

/** The person's own words and the recording block, as the chat shows them. */
export function extractRecordingBlock(text: string): {
  readonly text: string;
  readonly recording: ParsedRecording | null;
} {
  const start = text.lastIndexOf(`${OPEN} `);
  if (start === -1) return { text, recording: null };
  const end = text.indexOf(CLOSE, start);
  if (end === -1) return { text, recording: null };
  const headerEnd = text.indexOf(">", start);
  if (headerEnd === -1 || headerEnd > end) return { text, recording: null };
  const header = text.slice(start + OPEN.length, headerEnd);
  const read = (key: string) => {
    const match = new RegExp(`${key}="([^"]*)"`).exec(header);
    return match ? unattr(match[1] ?? "") : null;
  };
  const body = text.slice(headerEnd + 1, end);
  const section = (label: string, next: string | null) => {
    const at = body.indexOf(`${label}\n`);
    if (at === -1) return "";
    const from = at + label.length + 1;
    const to = next ? body.indexOf(`\n\n${next}`, from) : -1;
    const raw = body.slice(from, to === -1 ? undefined : to).trim();
    return raw.startsWith("(") && raw.endsWith(")") ? "" : raw;
  };
  const speech = section("What they said:", "What was on screen:");
  let visual = section("What was on screen:", null);
  const fullVideoAt = visual.indexOf("\n\nThe full video is in");
  if (fullVideoAt !== -1) visual = visual.slice(0, fullVideoAt).trim();
  if (visual.startsWith("The full video is in")) visual = "";
  const before = text.slice(0, start).replace(/\s+$/, "");
  const after = text.slice(end + CLOSE.length).replace(/^\s+/, "");
  return {
    text: after ? `${before}\n\n${after}`.trim() : before,
    recording: {
      name: read("name") ?? "Screen recording",
      duration: read("duration") ?? "",
      driveKey: read("drive_key"),
      shareUrl: read("link"),
      speech,
      visual,
    },
  };
}

/**
 * What the box says once the agent watched it: the person's own words become
 * the task (they can edit before sending). Without speech — a neutral ask.
 */
export function prefilledInstruction(speech: string): string {
  const said = speech.trim();
  return said.length > 0 ? said : "Do what I showed in this recording.";
}
