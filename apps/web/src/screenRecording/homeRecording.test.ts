import { describe, expect, it } from "vitest";

import { homeRecordingKey, homeRecordingPrefill, homeSendCheck } from "./homeRecording";
import { INITIAL_SAVE, INITIAL_WATCH, type RecordingItem } from "./pipeline";

function item(overrides: Partial<RecordingItem> = {}): RecordingItem {
  return {
    id: "r1",
    threadKey: "home:env-1",
    environmentId: "env-1",
    name: "Screen recording 2026-10-28 at 14.05.07.webm",
    mimeType: "video/webm",
    sizeBytes: 2048,
    durationMs: 5000,
    blob: new Blob([new Uint8Array(8)]),
    previewUrl: "blob:x",
    agentParts: [],
    agentCopyMimeType: null,
    hasVoice: true,
    width: 1280,
    height: 720,
    events: [],
    liveFrames: [],
    createdAt: "2026-10-28T14:05:07.000Z",
    save: { ...INITIAL_SAVE },
    watch: { ...INITIAL_WATCH },
    prefilled: false,
    ...overrides,
  };
}

const saved = { ...INITIAL_SAVE, status: "done" as const, driveKey: "Recordings/a.webm" };
const watched = (speech: string) => ({ ...INITIAL_WATCH, status: "done" as const, speech });

describe("Home's recording key", () => {
  it("one per computer, never a chat id", () => {
    expect(homeRecordingKey("env-1")).toBe("home:env-1");
    expect(homeRecordingKey("env-2")).not.toBe(homeRecordingKey("env-1"));
  });
});

describe("Home's box gets the words", () => {
  it("nothing yet while the agent is watching", () => {
    expect(
      homeRecordingPrefill(item({ watch: { ...INITIAL_WATCH, status: "running" } }), ""),
    ).toEqual({ mark: false, text: null });
    expect(homeRecordingPrefill(null, "")).toEqual({ mark: false, text: null });
  });

  it("watched: the words go into an empty box", () => {
    expect(homeRecordingPrefill(item({ watch: watched("Put Pro first") }), "  ")).toEqual({
      mark: true,
      text: "Put Pro first",
    });
  });

  it("no speech: a neutral ask", () => {
    expect(homeRecordingPrefill(item({ watch: watched("") }), "").text).toBe(
      "Do what I showed in this recording.",
    );
  });

  it("what the person typed stays; once only", () => {
    expect(homeRecordingPrefill(item({ watch: watched("Put Pro first") }), "My own task")).toEqual({
      mark: true,
      text: null,
    });
    expect(
      homeRecordingPrefill(item({ watch: watched("Put Pro first"), prefilled: true }), ""),
    ).toEqual({ mark: false, text: null });
  });

  it("watching skipped also counts as done", () => {
    expect(
      homeRecordingPrefill(item({ watch: { ...INITIAL_WATCH, status: "skipped" } }), "").mark,
    ).toBe(true);
  });
});

describe("sending from Home", () => {
  it("empty without text, attachments or a recording", () => {
    expect(homeSendCheck({ text: " ", attachments: 0, recording: null })).toEqual({
      kind: "empty",
    });
    expect(homeSendCheck({ text: "Do it", attachments: 0, recording: null }).kind).toBe("send");
  });

  it("waits while the recording saves or is watched — same words as the chat", () => {
    expect(homeSendCheck({ text: "Do it", attachments: 0, recording: item() })).toEqual({
      kind: "blocked",
      message: "Wait until the agent has watched the recording.",
    });
    expect(
      homeSendCheck({
        text: "Do it",
        attachments: 0,
        recording: item({
          save: { ...INITIAL_SAVE, status: "running" },
          watch: watched("x"),
        }),
      }),
    ).toEqual({ kind: "blocked", message: "Wait until the recording is saved to Uno Drive." });
  });

  it("neither saved nor watched: Retry or remove first", () => {
    expect(
      homeSendCheck({
        text: "",
        attachments: 0,
        recording: item({
          save: { ...INITIAL_SAVE, status: "failed", error: "x" },
          watch: { ...INITIAL_WATCH, status: "failed", error: "y" },
        }),
      }).kind,
    ).toBe("blocked");
  });

  it("a ready recording goes even with an empty box", () => {
    expect(
      homeSendCheck({
        text: "",
        attachments: 0,
        recording: item({ save: saved, watch: watched("Put Pro first") }),
      }),
    ).toEqual({ kind: "send" });
  });
});
