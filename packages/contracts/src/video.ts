import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VIDEO_CONTEXT_SCHEMA_VERSION = 1;
export const PROVIDER_SEND_TURN_MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_VIDEO_DURATION_MS = 60 * 60 * 1000;

export const VideoMimeType = Schema.Literals(["video/mp4", "video/quicktime", "video/webm"]);
export type VideoMimeType = typeof VideoMimeType.Type;

export const VideoDigestId = TrimmedNonEmptyString.pipe(Schema.brand("VideoDigestId"));
export type VideoDigestId = typeof VideoDigestId.Type;

export const UnoVideoUploadId = TrimmedNonEmptyString.pipe(Schema.brand("UnoVideoUploadId"));
export type UnoVideoUploadId = typeof UnoVideoUploadId.Type;

export const UnoVideoId = TrimmedNonEmptyString.pipe(Schema.brand("UnoVideoId"));
export type UnoVideoId = typeof UnoVideoId.Type;

export const UnoVideoJobId = TrimmedNonEmptyString.pipe(Schema.brand("UnoVideoJobId"));
export type UnoVideoJobId = typeof UnoVideoJobId.Type;

export const UnoVideoArtifactId = TrimmedNonEmptyString.pipe(Schema.brand("UnoVideoArtifactId"));
export type UnoVideoArtifactId = typeof UnoVideoArtifactId.Type;

export const UnoVideoJobStatus = Schema.Literals([
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
]);
export type UnoVideoJobStatus = typeof UnoVideoJobStatus.Type;

export const UnoVideoJobStage = Schema.Literals([
  "queued",
  "probing",
  "audio_extract",
  "stt",
  "frame_analysis",
  "ocr",
  "packing",
  "complete",
  "failed",
  "cancelled",
]);
export type UnoVideoJobStage = typeof UnoVideoJobStage.Type;

export const VideoTranscriptSegment = Schema.Struct({
  id: TrimmedNonEmptyString,
  startMs: NonNegativeInt,
  endMs: NonNegativeInt,
  text: Schema.String,
});
export type VideoTranscriptSegment = typeof VideoTranscriptSegment.Type;

export const VideoFrameReason = Schema.Literals([
  "scene-change",
  "ocr-change",
  "speech-anchor",
  "motion",
  "interval",
  "poster",
]);
export type VideoFrameReason = typeof VideoFrameReason.Type;

export const VideoDigestFrame = Schema.Struct({
  id: TrimmedNonEmptyString,
  timestampMs: NonNegativeInt,
  reason: VideoFrameReason,
  artifactId: UnoVideoArtifactId,
  width: PositiveInt,
  height: PositiveInt,
  ocrText: Schema.Array(Schema.String),
  importance: Schema.Number,
});
export type VideoDigestFrame = typeof VideoDigestFrame.Type;

export const VideoDigestScene = Schema.Struct({
  id: TrimmedNonEmptyString,
  startMs: NonNegativeInt,
  endMs: NonNegativeInt,
  keyFrameIds: Schema.Array(TrimmedNonEmptyString),
  visibleText: Schema.Array(Schema.String),
  speech: Schema.String,
  summary: Schema.String,
});
export type VideoDigestScene = typeof VideoDigestScene.Type;

export const VideoDigestTimelineItem = Schema.Struct({
  startMs: NonNegativeInt,
  endMs: NonNegativeInt,
  title: Schema.String,
  speech: Schema.String,
  visibleText: Schema.Array(Schema.String),
  observedActions: Schema.Array(Schema.String),
  frameIds: Schema.Array(TrimmedNonEmptyString),
});
export type VideoDigestTimelineItem = typeof VideoDigestTimelineItem.Type;

export const VideoDigest = Schema.Struct({
  schemaVersion: Schema.Literal(VIDEO_CONTEXT_SCHEMA_VERSION),
  digestId: VideoDigestId,
  source: Schema.Struct({
    videoId: UnoVideoId,
    fileName: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
    mimeType: VideoMimeType,
    sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_VIDEO_BYTES)),
    durationMs: NonNegativeInt.check(
      Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_VIDEO_DURATION_MS),
    ),
    width: PositiveInt,
    height: PositiveInt,
    fps: Schema.Number,
    hasAudio: Schema.Boolean,
    sha256: Schema.optional(Schema.String),
  }),
  transcript: Schema.Struct({
    provider: Schema.Literal("openrouter"),
    model: TrimmedNonEmptyString,
    language: Schema.optional(Schema.String),
    segments: Schema.Array(VideoTranscriptSegment),
  }),
  frames: Schema.Array(VideoDigestFrame),
  scenes: Schema.Array(VideoDigestScene),
  timeline: Schema.Array(VideoDigestTimelineItem),
  summary: Schema.String,
});
export type VideoDigest = typeof VideoDigest.Type;

export const UnoVideoUploadPart = Schema.Struct({
  partNumber: PositiveInt,
  uploadUrl: TrimmedNonEmptyString,
});
export type UnoVideoUploadPart = typeof UnoVideoUploadPart.Type;

export const UnoVideoCreateUploadInput = Schema.Struct({
  fileName: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: VideoMimeType,
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_VIDEO_BYTES)),
  sha256: Schema.optional(Schema.String),
  projectHint: Schema.optional(Schema.String),
  threadHint: Schema.optional(Schema.String),
});
export type UnoVideoCreateUploadInput = typeof UnoVideoCreateUploadInput.Type;

export const UnoVideoCreateUploadResult = Schema.Struct({
  uploadId: UnoVideoUploadId,
  objectKey: TrimmedNonEmptyString,
  maxPartBytes: PositiveInt,
  parts: Schema.Array(UnoVideoUploadPart),
  expiresAt: TrimmedNonEmptyString,
});
export type UnoVideoCreateUploadResult = typeof UnoVideoCreateUploadResult.Type;

export const UnoVideoCompleteUploadInput = Schema.Struct({
  uploadId: UnoVideoUploadId,
  parts: Schema.Array(
    Schema.Struct({
      partNumber: PositiveInt,
      etag: TrimmedNonEmptyString,
    }),
  ),
  sha256: Schema.optional(Schema.String),
});
export type UnoVideoCompleteUploadInput = typeof UnoVideoCompleteUploadInput.Type;

export const UnoVideoCompleteUploadResult = Schema.Struct({
  videoId: UnoVideoId,
  sourceArtifactId: UnoVideoArtifactId,
});
export type UnoVideoCompleteUploadResult = typeof UnoVideoCompleteUploadResult.Type;

export const UnoVideoCreateJobInput = Schema.Struct({
  videoId: UnoVideoId,
  purpose: Schema.Literal("llm_context"),
  profile: Schema.Literal("ui_review"),
  quality: Schema.Literal("high"),
});
export type UnoVideoCreateJobInput = typeof UnoVideoCreateJobInput.Type;

export const UnoVideoCreateJobResult = Schema.Struct({
  jobId: UnoVideoJobId,
  status: Schema.Literal("queued"),
});
export type UnoVideoCreateJobResult = typeof UnoVideoCreateJobResult.Type;

export const UnoVideoGetJobInput = Schema.Struct({
  jobId: UnoVideoJobId,
});
export type UnoVideoGetJobInput = typeof UnoVideoGetJobInput.Type;

export const UnoVideoJobResult = Schema.Struct({
  jobId: UnoVideoJobId,
  status: UnoVideoJobStatus,
  progress: Schema.Number,
  stage: UnoVideoJobStage,
  error: Schema.optional(Schema.String),
  digestId: Schema.optional(VideoDigestId),
});
export type UnoVideoJobResult = typeof UnoVideoJobResult.Type;

export const UnoVideoCancelJobInput = Schema.Struct({
  jobId: UnoVideoJobId,
});
export type UnoVideoCancelJobInput = typeof UnoVideoCancelJobInput.Type;

export const UnoVideoCancelJobResult = Schema.Struct({
  ok: Schema.Boolean,
});
export type UnoVideoCancelJobResult = typeof UnoVideoCancelJobResult.Type;

export const UnoVideoGetDigestInput = Schema.Struct({
  digestId: VideoDigestId,
});
export type UnoVideoGetDigestInput = typeof UnoVideoGetDigestInput.Type;

export const VideoContextPackInput = Schema.Struct({
  digestId: VideoDigestId,
  target: Schema.Struct({
    providerKind: TrimmedNonEmptyString,
    modelId: TrimmedNonEmptyString,
    supportsVision: Schema.Boolean,
    maxInputChars: PositiveInt,
    maxImages: NonNegativeInt,
  }),
  userPrompt: Schema.String,
});
export type VideoContextPackInput = typeof VideoContextPackInput.Type;

export const VideoContextPackArtifact = Schema.Struct({
  artifactId: UnoVideoArtifactId,
  role: TrimmedNonEmptyString,
  timestampMs: NonNegativeInt,
  mimeType: TrimmedNonEmptyString.check(Schema.isPattern(/^image\//i)),
  width: PositiveInt,
  height: PositiveInt,
});
export type VideoContextPackArtifact = typeof VideoContextPackArtifact.Type;

export const VideoContextPack = Schema.Struct({
  packId: TrimmedNonEmptyString,
  promptText: Schema.String,
  artifacts: Schema.Array(VideoContextPackArtifact),
});
export type VideoContextPack = typeof VideoContextPack.Type;

export const UnoVideoDownloadArtifactInput = Schema.Struct({
  artifactId: UnoVideoArtifactId,
});
export type UnoVideoDownloadArtifactInput = typeof UnoVideoDownloadArtifactInput.Type;

export const UnoVideoDownloadArtifactResult = Schema.Struct({
  downloadUrl: TrimmedNonEmptyString,
});
export type UnoVideoDownloadArtifactResult = typeof UnoVideoDownloadArtifactResult.Type;

export class UnoVideoRpcError extends Schema.TaggedErrorClass<UnoVideoRpcError>()(
  "UnoVideoRpcError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    code: Schema.optional(Schema.String),
  },
) {}
