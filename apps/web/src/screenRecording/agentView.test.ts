import { describe, expect, it } from "vitest";

import {
  KEY_FRAMES_MAX,
  clicksForDescribe,
  cursorAt,
  formatTimelineLine,
  isPointingSpeech,
  keyFrameBudget,
  keyFrameLegend,
  keyFrameName,
  mapPointerToFrame,
  normalizeTimeline,
  parseKeyFrameName,
  pointingMoments,
  recordingEventsFile,
  recordingEventsName,
  selectKeyFrames,
} from "./agentView";
import {
  appendRecordingToPrompt,
  buildRecordingBlock,
  extractRecordingBlock,
} from "./recordingLogic";

const view = {
  innerWidth: 1440,
  innerHeight: 820,
  outerWidth: 1440,
  outerHeight: 900,
  screenWidth: 1440,
  screenHeight: 900,
  screenLeft: 0,
  screenTop: 0,
};
const at = (clientX: number, clientY: number, screenX = clientX, screenY = clientY + 80) => ({
  clientX,
  clientY,
  screenX,
  screenY,
});

describe("where a pointer event is on the video", () => {
  it("the whole screen: by screen coordinates", () => {
    expect(mapPointerToFrame(at(720, 370), "monitor", view, { width: 2880, height: 1800 })).toEqual({
      x: 0.5,
      y: 0.5,
    });
  });
  it("a second screen to the right: its own origin", () => {
    const right = { ...view, screenLeft: 1440 };
    expect(
      mapPointerToFrame(at(100, 100, 1440 + 360, 450), "monitor", right, { width: 1440, height: 900 }),
    ).toEqual({ x: 0.25, y: 0.5 });
  });
  it("a screen of another shape is not guessed", () => {
    expect(mapPointerToFrame(at(10, 10), "monitor", view, { width: 1920, height: 1080 })).toBeNull();
  });
  it("Work's own tab: by the page", () => {
    expect(mapPointerToFrame(at(1440, 0), "browser", view, { width: 1440, height: 820 })).toEqual({
      x: 1,
      y: 0,
    });
  });
  it("Work's window: the page sits under the toolbar", () => {
    expect(mapPointerToFrame(at(0, 0), "window", view, { width: 1440, height: 900 })).toEqual({
      x: 0,
      y: 0.0889,
    });
  });
  it("outside the frame: nothing", () => {
    expect(mapPointerToFrame(at(-5, 10, -5, 10), "monitor", view, { width: 1440, height: 900 })).toBeNull();
  });
});

describe("the event track", () => {
  const events = [
    { t: 900, kind: "move" as const, x: 0.1, y: 0.1 },
    { t: 12_400, kind: "click" as const, x: 0.83, y: 0.08 },
    { t: 13_000, kind: "click" as const },
    { t: 20_000, kind: "scene" as const },
  ];
  it("file next to the video", () => {
    expect(recordingEventsName("Screen recording 2026-10-28 at 14.05.07.webm")).toBe(
      "Screen recording 2026-10-28 at 14.05.07.events.json",
    );
    const file = recordingEventsFile({ videoName: "a.webm", width: 1920, height: 1080, durationMs: 30_000.4, events });
    expect(file).toMatchObject({ version: 1, video: "a.webm", durationMs: 30_000 });
    expect(file.events[2]).toEqual({ t: 13_000, kind: "click" });
  });
  it("clicks for the gateway in seconds", () => {
    expect(clicksForDescribe(events)).toEqual([
      { t: 12.4, kind: "click", x: 0.83, y: 0.08 },
      { t: 13, kind: "click" },
    ]);
  });
  it("cursor at a moment: the nearest placed event within a second", () => {
    expect(cursorAt(events, 12_000)).toEqual({ x: 0.83, y: 0.08 });
    expect(cursorAt(events, 5000)).toBeNull();
  });
});

describe("timeline", () => {
  it("a line like the brief's example", () => {
    expect(
      formatTimelineLine({ t: 12.4, say: "эта кнопка", see: "cursor on Save, top-right", do: "" }),
    ).toBe('[0:12] says "эта кнопка" — cursor on Save, top-right');
    expect(formatTimelineLine({ t: 15, say: "", see: "", do: "click → error 500" })).toBe(
      "[0:15] click → error 500",
    );
  });
  it("junk from a daemon is dropped, order kept", () => {
    expect(
      normalizeTimeline([{ t: 5, say: "b" }, null, { t: -1 }, { t: 1, see: "a" }, { t: "x" }]),
    ).toEqual([
      { t: 1, say: "", see: "a", do: "" },
      { t: 5, say: "b", see: "", do: "" },
    ]);
    expect(normalizeTimeline("nope")).toEqual([]);
  });
  it("pointing words in Russian and English", () => {
    for (const said of ["вот тут криво", "Эта кнопка", "здесь", "click this", "here it breaks", "put it there"]) {
      expect(isPointingSpeech(said), said).toBe(true);
    }
    for (const said of ["сделай зелёным", "вотсап", "thistle", "where", "make it green"]) {
      expect(isPointingSpeech(said), said).toBe(false);
    }
    expect(
      pointingMoments([
        { t: 1, say: "привет", see: "", do: "" },
        { t: 12.5, say: "вот тут криво", see: "", do: "" },
      ]),
    ).toEqual([12.5]);
  });
});

describe("key frames", () => {
  it("few by default, a little more for long recordings, never above the ceiling", () => {
    expect(keyFrameBudget(60_000)).toBe(8);
    expect(keyFrameBudget(5 * 60_000)).toBe(12);
    expect(keyFrameBudget(60 * 60_000)).toBe(20);
    expect(keyFrameBudget(60 * 60_000)).toBeLessThanOrEqual(KEY_FRAMES_MAX);
  });
  it("one per moment, the more telling reason wins", () => {
    const picked = selectKeyFrames(
      [
        { t: 0, reason: "start" as const },
        { t: 1000, reason: "scene" as const },
        { t: 10_000, reason: "click" as const },
        { t: 10_400, reason: "pointing" as const },
      ],
      8,
    );
    expect(picked.map((f) => f.reason)).toEqual(["scene", "pointing"]);
  });
  it("over budget: pointing and clicks first, screen changes spread out", () => {
    const candidates = [
      ...Array.from({ length: 30 }, (_, i) => ({ t: i * 10_000 + 5000, reason: "scene" as const })),
      { t: 2000, reason: "pointing" as const },
      { t: 101_000, reason: "click" as const },
    ];
    const picked = selectKeyFrames(candidates, 6);
    expect(picked).toHaveLength(6);
    expect(picked.filter((f) => f.reason === "scene")).toHaveLength(4);
    expect(picked.some((f) => f.reason === "pointing")).toBe(true);
    expect(picked.some((f) => f.reason === "click")).toBe(true);
    expect(picked.at(-1)!.t).toBeGreaterThan(250_000);
    expect(selectKeyFrames(candidates, 500)).toHaveLength(KEY_FRAMES_MAX);
  });
  it("names carry the moment and read back", () => {
    const name = keyFrameName({ t: 72_440, reason: "click" });
    expect(name).toBe("recording-frame 1m12.4s click.jpg");
    expect(parseKeyFrameName(name)).toEqual({ t: 72_400, reason: "click" });
    expect(parseKeyFrameName("photo.jpg")).toBeNull();
    expect(keyFrameLegend([{ t: 12_400, reason: "pointing" }])).toBe(
      "1. [0:12] they point with words",
    );
  });
});

describe("the block the agent reads", () => {
  const recording = {
    name: "Screen recording 2026-10-28 at 14.05.07.webm",
    durationMs: 20_000,
    driveKey: "Recordings/Screen recording 2026-10-28 at 14.05.07.webm",
    shareUrl: "https://api.getuno.xyz/api/v1/drive/d/tok",
    speech: "вот тут криво",
    visual: "A pricing page",
    timeline: [
      { t: 3, say: "", see: "cursor on the header", do: "" },
      { t: 12.4, say: "вот тут криво", see: 'cursor on "Pricing" card, right', do: "" },
    ],
    frames: [
      { t: 800, reason: "start" as const },
      { t: 12_400, reason: "pointing" as const },
    ],
  };
  it("has the timeline, the frames' legend and the tool to look closer", () => {
    const block = buildRecordingBlock(recording);
    expect(block).toContain('frames="2"');
    expect(block).toContain('[0:12] says "вот тут криво" — cursor on "Pricing" card, right');
    expect(block).toContain("2. [0:12] they point with words");
    expect(block).toContain(`recording_frames with recording="${recording.driveKey}"`);
  });
  it("reads back for the chat card (timeline too)", () => {
    const parsed = extractRecordingBlock(appendRecordingToPrompt("Fix it", recording));
    expect(parsed.text).toBe("Fix it");
    expect(parsed.recording).toMatchObject({
      speech: "вот тут криво",
      visual: "A pricing page",
      driveKey: recording.driveKey,
    });
    expect(parsed.recording!.timeline.split("\n")).toHaveLength(2);
  });
  it("without timeline and frames it is the block as before", () => {
    const parsed = extractRecordingBlock(
      appendRecordingToPrompt("", { ...recording, timeline: [], frames: [] }),
    );
    expect(parsed.recording).toMatchObject({ speech: "вот тут криво", visual: "A pricing page", timeline: "" });
    expect(buildRecordingBlock({ ...recording, timeline: [], frames: [] })).not.toContain("Timeline");
  });
});
