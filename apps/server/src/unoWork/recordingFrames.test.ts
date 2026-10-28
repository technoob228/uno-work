import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { McpContent } from "../mcp/mcpJsonRpc.ts";
import {
  FFMPEG_MISSING_MESSAGE,
  RECORDING_FRAMES,
  cacheBaseName,
  eventsAtFrame,
  eventsKeyFor,
  ffmpegFrameArgs,
  findExecutable,
  findFfmpegTools,
  formatTimestamp,
  frameSeconds,
  framesFolderName,
  isInsideFolder,
  isLocalRecordingPath,
  parseProbeDuration,
  parseRecordingEvents,
  parseTimestamp,
  planFrames,
  recordingFrames,
  recordingSlug,
  videoExtension,
  type FramesPlan,
} from "./recordingFrames.ts";
import { UNO_WORK_TOOLS, runUnoWorkTool, toolLevel, type UnoWorkToolDeps } from "./tools.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const plan = (args: Parameters<typeof planFrames>[0], duration: number | null = null) => {
  const result = planFrames(args, duration);
  if (!result.ok) throw new Error(result.error);
  return result.plan;
};
const planError = (args: Parameters<typeof planFrames>[0], duration: number | null = null) => {
  const result = planFrames(args, duration);
  if (result.ok) throw new Error("expected an error");
  return result.error;
};

describe("recording_frames: time", () => {
  it("parses m:ss, m:ss.s, h:mm:ss, seconds and numbers", () => {
    expect(parseTimestamp("0:12")).toBe(12);
    expect(parseTimestamp("1:02.5")).toBe(62.5);
    expect(parseTimestamp(" 12:05 ")).toBe(725);
    expect(parseTimestamp("1:02:03")).toBe(3723);
    expect(parseTimestamp("1:02:03.5")).toBe(3723.5);
    expect(parseTimestamp("12")).toBe(12);
    expect(parseTimestamp("12.5")).toBe(12.5);
    expect(parseTimestamp("12s")).toBe(12);
    expect(parseTimestamp(7.25)).toBe(7.25);
    expect(parseTimestamp(0)).toBe(0);
  });

  it("refuses what isn't a time", () => {
    for (const bad of ["", "abc", "0:75", "1:2:3", "-3", "1:02:60", "12:", ":12", "1.2.3"]) {
      expect(parseTimestamp(bad), bad).toBeNull();
    }
    expect(parseTimestamp(-1)).toBeNull();
    expect(parseTimestamp(Number.NaN)).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
  });

  it("formats to tenths only when needed, hours when there are any", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(12)).toBe("0:12");
    expect(formatTimestamp(12.5)).toBe("0:12.5");
    expect(formatTimestamp(12.333)).toBe("0:12.3");
    expect(formatTimestamp(59.96)).toBe("1:00");
    expect(formatTimestamp(62.5)).toBe("1:02.5");
    expect(formatTimestamp(3723.5)).toBe("1:02:03.5");
    for (const seconds of [0, 5, 12.5, 61.2, 3599.9, 3723.5]) {
      expect(parseTimestamp(formatTimestamp(seconds))).toBeCloseTo(seconds, 5);
    }
  });
});

describe("recording_frames: the plan of a call", () => {
  it("defaults: to = from + 3 s, 2 fps, 6 frames, 1280 px", () => {
    expect(plan({ from: "0:12" })).toEqual({
      fromSec: 12,
      toSec: 15,
      fps: 2,
      width: 1280,
      frameCount: 6,
      readSec: 3,
      truncated: false,
    } satisfies FramesPlan);
  });

  it("counts frames strictly before `to` and caps them at maxFrames (hard cap 12)", () => {
    expect(plan({ from: "0:00", to: "0:01", fps: 2 }).frameCount).toBe(2);
    expect(plan({ from: "0:00", to: "0:01.2", fps: 2 }).frameCount).toBe(3);
    expect(plan({ from: "0:00", to: "0:00.1", fps: 0.2 }).frameCount).toBe(1);
    const capped = plan({ from: "0:10", to: "0:20", fps: 2 });
    expect(capped).toMatchObject({ frameCount: 6, readSec: 3, truncated: true });
    expect(plan({ from: "0", to: "60", fps: 5, maxFrames: 40 }).frameCount).toBe(12);
  });

  it("clamps fps and width into range", () => {
    expect(plan({ from: "0", fps: 50, width: 4000 })).toMatchObject({ fps: 5, width: 1600 });
    expect(plan({ from: "0", fps: 0.01, width: 10 })).toMatchObject({ fps: 0.2, width: 320 });
  });

  it("explains bad ranges", () => {
    expect(planError({ from: "soon" })).toMatch(/"from" must be a time like "0:12"/);
    expect(planError({ from: "0:12", to: "later" })).toMatch(/"to" must be a time/);
    expect(planError({ from: "0:12", to: "0:10" })).toBe(
      '"to" (0:10) must be after "from" (0:12).',
    );
    expect(planError({ from: "0:12", to: "0:12" })).toMatch(/must be after/);
    expect(planError({ from: "0:00", to: "1:15" })).toMatch(
      /That's 75 s; one call covers at most 60 s\. .*from 0:00 to 1:00/,
    );
    expect(plan({ from: "0:00", to: "1:00" }).toSec).toBe(60);
  });

  it("bounds the range by the recording's length when known", () => {
    expect(planError({ from: "2:00" }, 94)).toBe(
      '"from" 2:00 is past the end: the recording is 1:34 long.',
    );
    expect(plan({ from: "1:33" }, 94)).toMatchObject({ toSec: 94, frameCount: 2 });
  });

  it("frame timestamps step by 1/fps from `from`", () => {
    const p = plan({ from: "0:12", fps: 4 });
    expect([0, 1, 2, 5].map((i) => frameSeconds(p, i))).toEqual([12, 12.25, 12.5, 13.25]);
  });

  it("builds ffmpeg's argv with input seek, fps, no upscale and a frame cap", () => {
    const argv = ffmpegFrameArgs(
      plan({ from: "0:12.5", to: "0:14", fps: 2 }),
      "/h/a b.webm",
      "/out",
    );
    expect(argv).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-ss",
      "12.500",
      "-i",
      "/h/a b.webm",
      "-t",
      "1.500",
      "-an",
      "-vf",
      "fps=2,scale='min(1280,iw)':-2",
      "-frames:v",
      "3",
      "-q:v",
      "4",
      path.join("/out", "f-%03d.jpg"),
    ]);
    // The seek comes before -i (fast input seek).
    expect(argv.indexOf("-ss")).toBeLessThan(argv.indexOf("-i"));
  });

  it("reads ffprobe's duration, none for N/A", () => {
    expect(parseProbeDuration("94.120000\n")).toBeCloseTo(94.12);
    expect(parseProbeDuration("N/A\n")).toBeNull();
    expect(parseProbeDuration("")).toBeNull();
  });
});

describe("recording_frames: events", () => {
  const file = {
    version: 1,
    video: "a.webm",
    width: 1920,
    height: 1080,
    durationMs: 20_000,
    events: [
      { t: 12_400, kind: "click", x: 0.83, y: 0.08 },
      { t: 11_000, kind: "move", x: 0.5, y: 0.5 },
      { t: 12_900, kind: "move", x: 0.81234, y: 0.1 },
      { t: 13_000, kind: "scene" },
      { t: 14_000, kind: "click" },
      { t: "x", kind: "click" },
      { t: 1, kind: "scroll", x: 0.1, y: 0.1 },
      { t: 2, kind: "move", x: 3, y: 0.1 },
    ],
  };

  it("keeps known, well-formed events in time order", () => {
    const parsed = parseRecordingEvents(file)!;
    expect(parsed.durationMs).toBe(20_000);
    expect(parsed.events.map((event) => `${event.t}:${event.kind}`)).toEqual([
      "2:move",
      "11000:move",
      "12400:click",
      "12900:move",
      "13000:scene",
      "14000:click",
    ]);
    // An x outside 0..1 drops the position, not the event.
    expect(parsed.events[0]).toEqual({ t: 2, kind: "move" });
    expect(parseRecordingEvents({ version: 1 })).toBeNull();
    expect(parseRecordingEvents("nope")).toBeNull();
  });

  it("clicks within ±0.5 s; cursor = nearest move/click within 1 s", () => {
    const parsed = parseRecordingEvents(file);
    expect(eventsAtFrame(parsed, 12.5)).toEqual({
      clicks: [{ t: "0:12.4", x: 0.83, y: 0.08 }],
      cursor: { x: 0.83, y: 0.08 },
    });
    expect(eventsAtFrame(parsed, 12.8)).toEqual({
      clicks: [{ t: "0:12.4", x: 0.83, y: 0.08 }],
      cursor: { x: 0.812, y: 0.1 },
    });
    expect(eventsAtFrame(parsed, 14.2)).toEqual({ clicks: [{ t: "0:14" }], cursor: null });
    expect(eventsAtFrame(parsed, 5)).toEqual({ clicks: [], cursor: null });
    expect(eventsAtFrame(null, 12.5)).toEqual({ clicks: [], cursor: null });
  });
});

describe("recording_frames: names", () => {
  it("names the events file, the cache entry and the frames folder", () => {
    const key = "Recordings/Screen recording 2026-10-28 at 14.42.54.webm";
    expect(eventsKeyFor(key)).toBe(
      "Recordings/Screen recording 2026-10-28 at 14.42.54.events.json",
    );
    expect(eventsKeyFor("Recordings/noext")).toBe("Recordings/noext.events.json");
    expect(cacheBaseName(key)).toMatch(/^[0-9a-f]{24}$/);
    expect(cacheBaseName(key)).toBe(cacheBaseName(key));
    expect(cacheBaseName(key)).not.toBe(cacheBaseName(`${key}x`));
    expect(videoExtension(key)).toBe(".webm");
    expect(videoExtension("a.MP4")).toBe(".mp4");
    expect(videoExtension("a")).toBe(".video");
    expect(recordingSlug(key)).toBe("screen-recording-2026-10-28-at-14-42-54");
    expect(recordingSlug("Recordings/.webm")).toBe("webm");
    expect(recordingSlug("Recordings/«».mp4")).toBe("recording");
    expect(framesFolderName(key, 12, 15.5)).toBe(
      "screen-recording-2026-10-28-at-14-42-54-12s-15.5s",
    );
  });

  it("tells paths from Drive keys and checks a path stays inside home", () => {
    expect(isLocalRecordingPath("~/Videos/a.mp4")).toBe(true);
    expect(isLocalRecordingPath("/home/u/a.mp4")).toBe(true);
    expect(isLocalRecordingPath("Recordings/a.webm")).toBe(false);
    expect(isInsideFolder("/home/u/a.mp4", "/home/u")).toBe(true);
    expect(isInsideFolder("/home/u", "/home/u")).toBe(true);
    expect(isInsideFolder("/home/user2/a.mp4", "/home/u")).toBe(false);
    expect(isInsideFolder("/etc/passwd", "/home/u")).toBe(false);
  });

  it("finds an executable on PATH first, then in the usual folders", async () => {
    const seen: string[] = [];
    const found = await findExecutable("ffmpeg", {
      pathEnv: ["/a", "/b"].join(path.delimiter),
      extraDirs: ["/opt/homebrew/bin", "/b"],
      isExecutable: async (candidate) => {
        seen.push(candidate);
        return candidate === path.join("/opt/homebrew/bin", "ffmpeg");
      },
    });
    expect(found).toBe(path.join("/opt/homebrew/bin", "ffmpeg"));
    expect(seen).toEqual(
      ["/a/ffmpeg", "/b/ffmpeg", "/opt/homebrew/bin/ffmpeg"].map(path.normalize),
    );
    expect(
      await findExecutable("ffmpeg", {
        pathEnv: "",
        extraDirs: [],
        isExecutable: async () => true,
      }),
    ).toBeNull();
  });
});

// ── The tool ───────────────────────────────────────────────────────────

const tool = UNO_WORK_TOOLS.find((entry) => entry.name === "recording_frames")!;

function toolDeps(home: string, files: Partial<UnoWorkToolDeps["files"]> = {}): UnoWorkToolDeps {
  return {
    home,
    caller: { threadId: "t1", threadTitle: "Loom", runtimeMode: "approval-required", cwd: home },
    requestApproval: () => Effect.die("recording_frames must not ask"),
    files: files as UnoWorkToolDeps["files"],
  } as unknown as UnoWorkToolDeps;
}

const runTool = (deps: UnoWorkToolDeps, args: Record<string, unknown>) =>
  Effect.runPromise(Effect.result(runUnoWorkTool(tool, deps, args)));

describe("recording_frames tool", () => {
  it("is a safe files tool with a strict schema", () => {
    expect(tool.group).toBe("files");
    expect(toolLevel(tool, { recording: "Recordings/a.webm", from: "0:01" })).toBe("safe");
    expect(tool.inputSchema.required).toEqual(["recording", "from"]);
    expect(tool.description).toMatch(/1–1\.5k tokens/);
    expect(tool.description).toMatch(/saved as JPEG files/);
  });

  it("refuses a bad range before touching anything", async () => {
    const home = tempDir("rf-home-");
    const result = await runTool(toolDeps(home), {
      recording: "Recordings/a.webm",
      from: "0:20",
      to: "0:10",
    });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toMatch(/must be after/);
    expect(existsSync(path.join(home, ".uno-recordings"))).toBe(false);
  });

  it("says how to install ffmpeg when it's missing", async () => {
    const home = tempDir("rf-home-");
    await expect(
      recordingFrames({
        home,
        recording: "~/a.webm",
        from: "0:01",
        resolveLocalPath: (raw) => path.join(home, raw.slice(2)),
        tools: null,
      }),
    ).rejects.toThrow(FFMPEG_MISSING_MESSAGE);
    expect(FFMPEG_MISSING_MESSAGE).toMatch(/sudo apt-get install -y ffmpeg/);
    expect(FFMPEG_MISSING_MESSAGE).toMatch(/brew install ffmpeg/);
  });

  it("opens only files inside the home folder", async () => {
    const home = tempDir("rf-home-");
    const outside = tempDir("rf-out-");
    writeFileSync(path.join(outside, "a.webm"), "x");
    const tools = { ffmpeg: "/nonexistent/ffmpeg", ffprobe: null };
    const base = { home, from: "0:01", tools, resolveLocalPath: (raw: string) => raw };
    await expect(
      recordingFrames({ ...base, recording: path.join(outside, "a.webm") }),
    ).rejects.toThrow("Only recordings inside the home folder (~) can be opened.");
    await expect(
      recordingFrames({ ...base, recording: path.join(home, "missing.webm") }),
    ).rejects.toThrow(/No file at .*missing\.webm on this computer/);
  });

  it("explains a Drive key whose download fails, disk refusal included", async () => {
    const home = tempDir("rf-home-");
    const deps = toolDeps(home, {
      driveState: Effect.succeed({ available: true, bucketId: 9 } as never),
      cloudCopyToComputer: () =>
        Effect.fail({
          message:
            "Not enough space on this computer: needs 3.0 GB, 2.0 GB free. Free up space or pick fewer files.",
        }),
    });
    const tools = await findFfmpegTools();
    if (!tools) return; // the ffmpeg-missing case is above
    const result = await runTool(deps, { recording: "Recordings/a.webm", from: "0:01" });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toBe(
        "Not enough space on this computer: needs 3.0 GB, 2.0 GB free. Free space with computer_cleanup or pick fewer files.",
      );
    }
  });
});

// ── Real ffmpeg on a tiny clip ─────────────────────────────────────────

const images = (content: McpContent) =>
  content.content.filter((part) => part.type === "image") as Array<{
    mimeType: string;
    data: string;
  }>;
const summary = (content: McpContent) =>
  JSON.parse(String(content.content.at(-1)!.text)) as {
    recording: string;
    from: string;
    to: string;
    fps: number;
    duration?: string;
    frames: Array<{ t: string; path: string; clicks: unknown[]; cursor: unknown }>;
    note?: string;
  };

const ffmpegTools = await findFfmpegTools();
const describeWithFfmpeg = ffmpegTools ? describe : describe.skip;

describeWithFfmpeg("recording_frames with ffmpeg", () => {
  /** A 3 s 320x240 clip at 10 fps (WebM if libvpx is there, else MP4). */
  function makeClip(dir: string): string {
    const webm = path.join(dir, "clip.webm");
    try {
      execFileSync(
        ffmpegTools!.ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=320x240:rate=10",
          "-t",
          "3",
          "-c:v",
          "libvpx",
          "-b:v",
          "200k",
          "-y",
          webm,
        ],
        { stdio: "ignore", timeout: 30_000 },
      );
      return webm;
    } catch {
      const mp4 = path.join(dir, "clip.mp4");
      execFileSync(
        ffmpegTools!.ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=320x240:rate=10",
          "-t",
          "3",
          "-pix_fmt",
          "yuv420p",
          "-y",
          mp4,
        ],
        { stdio: "ignore", timeout: 30_000 },
      );
      return mp4;
    }
  }

  it("cuts JPEG frames at the right moments from a file in the home folder", async () => {
    const home = tempDir("rf-home-");
    const videos = path.join(home, "Videos");
    mkdirSync(videos);
    const clip = makeClip(videos);
    const ext = path.extname(clip);
    writeFileSync(
      path.join(videos, "clip.events.json"),
      JSON.stringify({
        version: 1,
        video: path.basename(clip),
        width: 320,
        height: 240,
        durationMs: 3000,
        events: [
          { t: 1400, kind: "click", x: 0.25, y: 0.75 },
          { t: 1550, kind: "move", x: 0.3, y: 0.7 },
        ],
      }),
    );
    const result = await runTool(toolDeps(home), {
      recording: `~/Videos/clip${ext}`,
      from: "0:01",
      to: "0:02.5",
      fps: 2,
    });
    expect(result._tag, result._tag === "Failure" ? result.failure.message : "").toBe("Success");
    if (result._tag !== "Success") return;
    const content = result.success as McpContent;
    expect(content).toBeInstanceOf(McpContent);
    const pictures = images(content);
    expect(pictures).toHaveLength(3);
    for (const picture of pictures) {
      expect(picture.mimeType).toBe("image/jpeg");
      expect(Buffer.from(picture.data, "base64").subarray(0, 3)).toEqual(
        Buffer.from([0xff, 0xd8, 0xff]),
      );
    }
    // image, its line, image, its line, …, then the JSON.
    expect(content.content.map((part) => part.type)).toEqual([
      "image",
      "text",
      "image",
      "text",
      "image",
      "text",
      "text",
    ]);
    expect(String(content.content[1]!.text)).toMatch(
      /^Frame 1 of 3 at 0:01 \(~\/\.uno-recordings\/frames\/clip-1s-2\.5s\/f-001\.jpg\); click at 0:01\.4 \(x 0\.25, y 0\.75\)$/,
    );
    const json = summary(content);
    expect(json).toMatchObject({
      recording: `~/Videos/clip${ext}`,
      from: "0:01",
      to: "0:02.5",
      fps: 2,
    });
    expect(json.frames.map((frame) => frame.t)).toEqual(["0:01", "0:01.5", "0:02"]);
    expect(json.frames.map((frame) => frame.path)).toEqual(
      ["f-001.jpg", "f-002.jpg", "f-003.jpg"].map(
        (name) => `~/.uno-recordings/frames/clip-1s-2.5s/${name}`,
      ),
    );
    expect(json.frames[0]).toMatchObject({
      clicks: [{ t: "0:01.4", x: 0.25, y: 0.75 }],
      cursor: { x: 0.25, y: 0.75 },
    });
    expect(json.frames[1]).toMatchObject({
      clicks: [{ t: "0:01.4", x: 0.25, y: 0.75 }],
      cursor: { x: 0.3, y: 0.7 },
    });
    expect(json.frames[2]!.clicks).toEqual([]);
    for (const name of ["f-001.jpg", "f-002.jpg", "f-003.jpg"]) {
      expect(existsSync(path.join(home, ".uno-recordings", "frames", "clip-1s-2.5s", name))).toBe(
        true,
      );
    }
    // Frames differ over time (the seek works, not one frame repeated).
    expect(pictures[0]!.data).not.toBe(pictures[2]!.data);

    // Asking again replaces the folder: fewer frames, no leftovers.
    const again = await runTool(toolDeps(home), {
      recording: `~/Videos/clip${ext}`,
      from: "1",
      to: "2.5",
      fps: 1,
    });
    expect(again._tag).toBe("Success");
    expect(readdirSync(path.join(home, ".uno-recordings", "frames", "clip-1s-2.5s"))).toEqual([
      "f-001.jpg",
      "f-002.jpg",
    ]);
  });

  it("caps at maxFrames and says where to go on", async () => {
    const home = tempDir("rf-home-");
    const clip = makeClip(home);
    const result = await runTool(toolDeps(home), {
      recording: clip,
      from: "0:00",
      to: "0:03",
      fps: 5,
      maxFrames: 4,
      width: 320,
    });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    const json = summary(result.success as McpContent);
    expect(images(result.success as McpContent)).toHaveLength(4);
    expect(json.frames.map((frame) => frame.t)).toEqual(["0:00", "0:00.2", "0:00.4", "0:00.6"]);
    expect(json.note).toMatch(/call again with from "0:00\.8"/);
  });

  it("says how long the recording is when there are no frames there", async () => {
    const home = tempDir("rf-home-");
    const clip = makeClip(home);
    const result = await runTool(toolDeps(home), { recording: clip, from: "0:10" });
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure.message).toMatch(
      /^("from" 0:10 is past the end: the recording is 0:03 long\.|No frames there — .*)$/,
    );
  });

  it("downloads a Drive recording once into the cache, with its events, and reuses it", async () => {
    const home = tempDir("rf-home-");
    const source = tempDir("rf-drive-");
    const clip = makeClip(source);
    const ext = path.extname(clip);
    const key = `Recordings/Screen recording 2026-10-28 at 14.42.54${ext}`;
    const eventsKey = eventsKeyFor(key);
    writeFileSync(
      path.join(source, "events.json"),
      JSON.stringify({
        version: 1,
        durationMs: 3000,
        events: [{ t: 500, kind: "click", x: 0.5, y: 0.5 }],
      }),
    );
    const copies: Array<{ keys: ReadonlyArray<string>; destinationPath: string }> = [];
    const deps = toolDeps(home, {
      driveState: Effect.succeed({ available: true, bucketId: 9 } as never),
      cloudCopyToComputer: (input) =>
        Effect.suspend(() => {
          copies.push(input);
          const wanted = input.keys[0]!;
          const from =
            wanted === key ? clip : wanted === eventsKey ? path.join(source, "events.json") : null;
          if (!from) {
            return Effect.fail({
              message: `Downloading “${wanted}” failed (storage answered 404).`,
            });
          }
          const landed = path.join(input.destinationPath, path.posix.basename(wanted));
          copyFileSync(from, landed);
          return Effect.succeed({ files: 1, bytes: 1, skipped: [], paths: [landed] });
        }),
    });
    // A stale cache entry from long ago is cleaned away.
    const cacheDir = path.join(home, ".uno-recordings", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const stale = path.join(cacheDir, "old.webm");
    writeFileSync(stale, "old");
    const longAgo = new Date(Date.now() - RECORDING_FRAMES.keepMs - 60_000);
    utimesSync(stale, longAgo, longAgo);

    const first = await runTool(deps, { recording: key, from: "0:00", to: "0:01" });
    expect(first._tag, first._tag === "Failure" ? first.failure.message : "").toBe("Success");
    expect(copies.map((copy) => copy.keys[0])).toEqual([key, eventsKey]);
    expect(existsSync(stale)).toBe(false);
    const base = cacheBaseName(key);
    expect(readdirSync(cacheDir).toSorted()).toEqual(
      [`${base}${ext}`, `${base}.events.json`, `${base}.meta.json`].toSorted(),
    );
    if (first._tag === "Success") {
      const json = summary(first.success as McpContent);
      expect(json.recording).toBe(key);
      expect(json.frames.map((frame) => frame.t)).toEqual(["0:00", "0:00.5"]);
      expect(json.frames[1]!.clicks).toEqual([{ t: "0:00.5", x: 0.5, y: 0.5 }]);
      expect(json.frames[0]!.path).toMatch(
        /^~\/\.uno-recordings\/frames\/screen-recording-2026-10-28-at-14-42-54-0s-1s\/f-001\.jpg$/,
      );
    }

    // Second call: from the cache, no download.
    const second = await runTool(deps, { recording: key, from: "0:01", to: "0:02" });
    expect(second._tag).toBe("Success");
    expect(copies).toHaveLength(2);

    // A recording without an events file still works.
    const other = `Recordings/other${ext}`;
    const withOther = toolDeps(home, {
      driveState: Effect.succeed({ available: true, bucketId: 9 } as never),
      cloudCopyToComputer: (input) =>
        Effect.suspend(() => {
          if (input.keys[0] !== other) {
            return Effect.fail({ message: "Downloading failed (storage answered 404)." });
          }
          const landed = path.join(input.destinationPath, path.posix.basename(other));
          copyFileSync(clip, landed);
          return Effect.succeed({ files: 1, bytes: 1, skipped: [], paths: [landed] });
        }),
    });
    const third = await runTool(withOther, { recording: other, from: "0:00" });
    expect(third._tag).toBe("Success");
    if (third._tag === "Success") {
      const json = summary(third.success as McpContent);
      expect(json.frames.every((frame) => frame.clicks.length === 0 && frame.cursor === null)).toBe(
        true,
      );
    }
    // No staging folders left behind.
    expect(readdirSync(cacheDir).filter((name) => name.startsWith(".dl-"))).toEqual([]);
  });
});
