import { describe, expect, it } from "vitest";

import {
  appendRecordingToPrompt,
  baseMimeType,
  buildRecordingBlock,
  cameraBubbleRect,
  compositeSize,
  describeCaptureError,
  displayMediaOptions,
  driveSpaceProblem,
  extensionForMime,
  extractRecordingBlock,
  formatClock,
  isScreenRecordingSupported,
  pickRecorderMimeType,
  prefilledInstruction,
  recordingDriveKey,
  recordingFileName,
} from "./recordingLogic";

const domError = (name: string, message = "") => Object.assign(new Error(message), { name });

describe("recorder format", () => {
  it("prefers WebM (MP4 can record no frames without an H.264 encoder), MP4 for Safari", () => {
    expect(pickRecorderMimeType(() => true)).toBe("video/webm;codecs=vp9,opus");
    expect(pickRecorderMimeType((type) => type.startsWith("video/mp4"))).toBe(
      "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
    );
    expect(pickRecorderMimeType(() => false)).toBeNull();
  });

  it("survives engines that throw on codec strings", () => {
    expect(
      pickRecorderMimeType((type) => {
        if (type.includes("codecs")) throw new Error("bad codec");
        return type === "video/mp4";
      }),
    ).toBe("video/mp4");
  });

  it("names files like macOS screenshots and keys them under Recordings/", () => {
    const date = new Date(2026, 9, 28, 14, 5, 7);
    expect(recordingFileName(date, "video/mp4;codecs=avc1")).toBe(
      "Screen recording 2026-10-28 at 14.05.07.mp4",
    );
    expect(recordingFileName(date, "video/webm")).toMatch(/\.webm$/);
    expect(recordingDriveKey("a.mp4")).toBe("Recordings/a.mp4");
    expect(baseMimeType("video/webm;codecs=vp9")).toBe("video/webm");
    expect(extensionForMime("video/quicktime")).toBe("webm");
  });

  it("formats the clock", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7_900)).toBe("0:07");
    expect(formatClock(245_000)).toBe("4:05");
    expect(formatClock(3_723_000)).toBe("1:02:03");
    expect(formatClock(-5)).toBe("0:00");
  });
});

describe("what getDisplayMedia is asked for", () => {
  it("hints the picker's tab by the chosen source and asks for sound", () => {
    const tab = displayMediaOptions({ source: "tab", camera: false, microphone: true });
    expect((tab.video as MediaTrackConstraints & { displaySurface: string }).displaySurface).toBe(
      "browser",
    );
    expect(tab.audio).toBe(true);
    const win = displayMediaOptions({ source: "window", camera: false, microphone: true });
    expect((win.video as { displaySurface: string }).displaySurface).toBe("window");
    const screen = displayMediaOptions({ source: "screen", camera: true, microphone: true });
    expect((screen.video as { displaySurface: string }).displaySurface).toBe("monitor");
  });

  it("is supported only with getDisplayMedia, MediaRecorder and https", () => {
    const mediaDevices = { getDisplayMedia: () => undefined };
    expect(
      isScreenRecordingSupported({ mediaDevices, MediaRecorder: class {}, isSecureContext: true }),
    ).toBe(true);
    expect(
      isScreenRecordingSupported({ mediaDevices, MediaRecorder: class {}, isSecureContext: false }),
    ).toBe(false);
    expect(isScreenRecordingSupported({ mediaDevices: {}, MediaRecorder: class {} })).toBe(false);
    expect(isScreenRecordingSupported({ mediaDevices })).toBe(false);
  });
});

describe("capture errors in words", () => {
  it("closing the picker is silent", () => {
    expect(
      describeCaptureError(domError("NotAllowedError", "Permission denied"), "screen"),
    ).toEqual({
      kind: "cancelled",
      message: null,
    });
  });

  it("macOS blocking screen recording names the setting and the app", () => {
    const desktop = describeCaptureError(
      domError("NotAllowedError", "Permission denied by system"),
      "screen",
      { mac: true, desktopApp: true },
    );
    expect(desktop.kind).toBe("denied");
    expect(desktop.message).toContain("Screen & System Audio Recording");
    expect(desktop.message).toContain("Uno Work");
    const browser = describeCaptureError(
      domError("NotAllowedError", "Permission denied by system"),
      "screen",
      { mac: true, desktopApp: false },
    );
    expect(browser.message).toContain("your browser");
  });

  it("camera/microphone problems say recording goes on", () => {
    expect(describeCaptureError(domError("NotAllowedError"), "camera").message).toContain(
      "goes on without it",
    );
    expect(describeCaptureError(domError("NotFoundError"), "microphone").kind).toBe("unsupported");
    expect(describeCaptureError(domError("NotReadableError"), "camera").kind).toBe("busy");
  });

  it("an unsupported browser for the screen says which ones work", () => {
    const problem = describeCaptureError(domError("NotSupportedError"), "screen");
    expect(problem.kind).toBe("unsupported");
    expect(problem.message).toContain("Chrome");
  });

  it("anything else keeps its own text", () => {
    expect(describeCaptureError(new Error("boom"), "screen")).toEqual({
      kind: "failed",
      message: "boom",
    });
  });
});

describe("Uno Drive space", () => {
  const drive = {
    available: true,
    usedBytes: 9 * 1024 ** 3,
    quotaBytes: 10 * 1024 ** 3,
    message: null,
  };
  it("fits", () => expect(driveSpaceProblem(drive, 100 * 1024 ** 2)).toBeNull());
  it("is full: says how big and how much is left", () => {
    const message = driveSpaceProblem(drive, 2 * 1024 ** 3);
    expect(message).toContain("Uno Drive is full");
    expect(message).toContain("2.00 GB");
    expect(message).toContain("1.00 GB left");
  });
  it("unknown quota (0) never blocks", () =>
    expect(driveSpaceProblem({ ...drive, quotaBytes: 0 }, 5 * 1024 ** 3)).toBeNull());
  it("not connected", () =>
    expect(driveSpaceProblem({ ...drive, available: false, message: null }, 1)).toContain(
      "isn't connected",
    ));
});

describe("geometry", () => {
  it("keeps the screen size up to 1920 wide, even numbers", () => {
    expect(compositeSize(1440, 901)).toEqual({ width: 1440, height: 902 });
    expect(compositeSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
    expect(compositeSize(0, 0)).toEqual({ width: 1280, height: 720 });
  });
  it("puts the camera bottom-left inside the frame", () => {
    const rect = cameraBubbleRect(1920, 1080);
    expect(rect.x).toBeGreaterThan(0);
    expect(rect.y + rect.size).toBeLessThan(1080);
    expect(rect.size).toBeGreaterThanOrEqual(96);
  });
});

describe("the message block", () => {
  const recording = {
    name: 'Screen recording 2026-10-28 at 14.05.07 "demo".mp4',
    durationMs: 102_000,
    driveKey: "Recordings/Screen recording 2026-10-28 at 14.05.07.mp4",
    shareUrl: "https://api.getuno.xyz/d/abc123",
    speech: "Make the Sign up button green and move it above the fold.",
    visual: "The landing page at localhost:5173 with a grey <Sign up> button at the bottom.",
  };

  it("tells the agent what to do and where the video is", () => {
    const block = buildRecordingBlock(recording);
    expect(block).toContain("<screen_recording ");
    expect(block).toContain('duration="1:42"');
    expect(block).toContain("Do what they showed and asked");
    expect(block).toContain(recording.speech);
    expect(block).toContain("Recordings/Screen recording");
    expect(block).toContain("</screen_recording>");
  });

  it("round-trips through the chat (quotes and < in names/text)", () => {
    const text = appendRecordingToPrompt("Please also update the README.", recording);
    const parsed = extractRecordingBlock(text);
    expect(parsed.text).toBe("Please also update the README.");
    expect(parsed.recording).toMatchObject({
      name: recording.name,
      duration: "1:42",
      driveKey: recording.driveKey,
      shareUrl: recording.shareUrl,
      speech: recording.speech,
      visual: recording.visual,
    });
  });

  it("works with no words of the person's own, no speech and no Drive copy", () => {
    const text = appendRecordingToPrompt("", {
      ...recording,
      speech: "",
      visual: "",
      driveKey: null,
      shareUrl: null,
    });
    const parsed = extractRecordingBlock(text);
    expect(parsed.text).toBe("");
    expect(parsed.recording).toMatchObject({
      speech: "",
      visual: "",
      driveKey: null,
      shareUrl: null,
    });
  });

  it("leaves ordinary messages alone", () => {
    expect(extractRecordingBlock("hello <screen_recording")).toEqual({
      text: "hello <screen_recording",
      recording: null,
    });
    expect(appendRecordingToPrompt("hi", null)).toBe("hi");
  });

  it("prefills the box with the person's own words", () => {
    expect(prefilledInstruction("  Fix the header  ")).toBe("Fix the header");
    expect(prefilledInstruction("")).toBe("Do what I showed in this recording.");
  });
});
