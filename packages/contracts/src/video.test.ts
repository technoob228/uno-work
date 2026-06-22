import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ClientOrchestrationCommand } from "./orchestration.ts";
import { VideoDigest, VideoContextPack } from "./video.ts";

const decodeClientCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);
const decodeVideoDigest = Schema.decodeUnknownSync(VideoDigest);
const decodeVideoContextPack = Schema.decodeUnknownSync(VideoContextPack);

describe("video contracts", () => {
  it("accepts a complete video digest", () => {
    const parsed = decodeVideoDigest({
      schemaVersion: 1,
      digestId: "digest_1",
      source: {
        videoId: "video_1",
        fileName: "review.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1024,
        durationMs: 180_000,
        width: 1920,
        height: 1080,
        fps: 30,
        hasAudio: true,
      },
      transcript: {
        provider: "openrouter",
        model: "openai/whisper-large-v3",
        language: "ru",
        segments: [{ id: "seg_1", startMs: 0, endMs: 1200, text: "вот эта кнопка" }],
      },
      frames: [
        {
          id: "frame_1",
          timestampMs: 800,
          reason: "speech-anchor",
          artifactId: "artifact_1",
          width: 1280,
          height: 720,
          ocrText: ["Save"],
          importance: 0.91,
        },
      ],
      scenes: [
        {
          id: "scene_1",
          startMs: 0,
          endMs: 5000,
          keyFrameIds: ["frame_1"],
          visibleText: ["Save"],
          speech: "вот эта кнопка",
          summary: "User points at the Save button.",
        },
      ],
      timeline: [
        {
          startMs: 0,
          endMs: 5000,
          title: "Save button review",
          speech: "вот эта кнопка",
          visibleText: ["Save"],
          observedActions: ["Pointer highlights the Save button."],
          frameIds: ["frame_1"],
        },
      ],
      summary: "Short UI review screencast.",
    });

    expect(parsed.frames).toHaveLength(1);
    expect(parsed.transcript.segments[0]?.text).toBe("вот эта кнопка");
  });

  it("accepts a model-ready video context pack", () => {
    const parsed = decodeVideoContextPack({
      packId: "pack_1",
      promptText: "<video_context>summary</video_context>",
      artifacts: [
        {
          artifactId: "artifact_1",
          role: "contact_sheet",
          timestampMs: 0,
          mimeType: "image/png",
          width: 1600,
          height: 900,
        },
      ],
    });

    expect(parsed.artifacts[0]?.role).toBe("contact_sheet");
  });

  it("keeps client upload video attachments metadata-only", () => {
    const parsed = decodeClientCommand({
      type: "thread.turn.start",
      commandId: "cmd_video",
      threadId: "thread_video",
      message: {
        messageId: "msg_video",
        role: "user",
        text: "review this",
        attachments: [
          {
            type: "video_digest",
            digestId: "digest_1",
            jobId: "job_1",
            name: "review.mp4",
          },
        ],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-06-16T00:00:00.000Z",
    });

    if (parsed.type !== "thread.turn.start") {
      throw new Error("Expected thread.turn.start");
    }
    const attachment = parsed.message.attachments[0];
    expect(attachment?.type).toBe("video_digest");
    expect(JSON.stringify(attachment)).not.toContain("dataUrl");
    expect(JSON.stringify(attachment)).not.toContain("base64");
  });
});
