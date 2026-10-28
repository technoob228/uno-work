import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * uno.transcribeAudio — dictation clips recorded in the web client are
 * transcribed server-side through the Uno Gateway `/audio/transcriptions`
 * route, so the account API key never reaches the browser.
 */

/** ~16 MB of base64 ≈ 12 MB of audio — far above any realistic dictation clip. */
export const UNO_TRANSCRIBE_MAX_BASE64_LENGTH = 16_000_000;

export const UnoTranscribeAudioInput = Schema.Struct({
  audioBase64: TrimmedNonEmptyString.check(Schema.isMaxLength(UNO_TRANSCRIBE_MAX_BASE64_LENGTH)),
  mimeType: TrimmedNonEmptyString,
  fileName: Schema.optional(Schema.String),
});
export type UnoTranscribeAudioInput = typeof UnoTranscribeAudioInput.Type;

export const UnoTranscribeAudioResult = Schema.Struct({
  text: Schema.String,
});
export type UnoTranscribeAudioResult = typeof UnoTranscribeAudioResult.Type;

export class UnoTranscriptionError extends Schema.TaggedErrorClass<UnoTranscriptionError>()(
  "UnoTranscriptionError",
  {
    message: Schema.String,
    reason: Schema.optional(Schema.Literals(["missing-api-key", "invalid-audio", "gateway"])),
  },
) {}

/**
 * uno.describeVideo — Loom Work (28.10): a screen recording made in Work is
 * watched by the Uno Gateway's `POST /video/describe` (speech + what was on
 * screen, one multimodal call). The browser first stages the small "agent
 * copy" of the recording on the computer; the daemon reads it from there, so
 * no 20 MB frame goes over the WebSocket and the key stays server-side.
 */
export const UNO_DESCRIBE_VIDEO_MAX_BYTES = 25 * 1024 * 1024;
/** One part (and a recording in one call). */
export const UNO_DESCRIBE_VIDEO_MAX_SECONDS = 10 * 60;
/** A long recording, watched from its parts in Uno Drive. */
export const UNO_DESCRIBE_VIDEO_LONG_MAX_SECONDS = 60 * 60;

export const UnoDescribeVideoDrivePart = Schema.Struct({
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(900)),
  durationSec: Schema.Number,
});
export type UnoDescribeVideoDrivePart = typeof UnoDescribeVideoDrivePart.Type;

export const UNO_DESCRIBE_VIDEO_MAX_EVENTS = 2000;

export const UnoDescribeVideoEvent = Schema.Struct({
  t: Schema.Number,
  kind: Schema.Literal("click"),
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
});
export type UnoDescribeVideoEvent = typeof UnoDescribeVideoEvent.Type;

export const UnoDescribeVideoTimelineEntry = Schema.Struct({
  /** Seconds from the start of the recording. */
  t: Schema.Number,
  say: Schema.String,
  see: Schema.String,
  do: Schema.String,
});
export type UnoDescribeVideoTimelineEntry = typeof UnoDescribeVideoTimelineEntry.Type;

export const UnoDescribeVideoInput = Schema.Struct({
  /**
   * One file inside the home folder (`~/.uno-recordings/<id>/agent.webm` or
   * absolute) — sent to `/video/describe`. Or:
   */
  path: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
  /** …the parts of a long recording already in Uno Drive, in order — `/video/describe/drive`. */
  driveParts: Schema.optional(
    Schema.Array(UnoDescribeVideoDrivePart).check(Schema.isMaxLength(24)),
  ),
  mimeType: TrimmedNonEmptyString,
  durationSec: Schema.Number,
  /**
   * "timeline": also second by second — what is said, where the cursor is
   * and what happens (the gateway's timeline mode; an older gateway ignores it).
   */
  mode: Schema.optional(Schema.Literal("timeline")),
  /** Clicks Work saw: seconds from the start, x/y as fractions of the frame. */
  events: Schema.optional(
    Schema.Array(UnoDescribeVideoEvent).check(Schema.isMaxLength(UNO_DESCRIBE_VIDEO_MAX_EVENTS)),
  ),
});
export type UnoDescribeVideoInput = typeof UnoDescribeVideoInput.Type;

export const UnoDescribeVideoResult = Schema.Struct({
  /** Verbatim transcript of what was said ("" when nobody spoke). */
  speech: Schema.String,
  /** What was on screen, with readable text quoted. */
  visual: Schema.String,
  /** Second by second (mode "timeline", from a gateway that has it). */
  timeline: Schema.optional(Schema.Array(UnoDescribeVideoTimelineEntry)),
});
export type UnoDescribeVideoResult = typeof UnoDescribeVideoResult.Type;

export class UnoDescribeVideoError extends Schema.TaggedErrorClass<UnoDescribeVideoError>()(
  "UnoDescribeVideoError",
  {
    message: Schema.String,
    reason: Schema.optional(
      Schema.Literals(["missing-api-key", "invalid-path", "too-large", "unsupported", "gateway"]),
    ),
  },
) {}
