import fsPromises from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  parseDescribeResponse,
  parseTimeline,
  postDescribe,
  postDescribeDrive,
  resolveRecordingPath,
} from "./unoVideoDescribe.ts";

describe("parseDescribeResponse", () => {
  it("reads speech and visual, trims them", () => {
    expect(parseDescribeResponse({ speech: " hi ", visual: "a page", model: "x" })).toEqual({
      speech: "hi",
      visual: "a page",
    });
  });
  it("one of them is enough", () => {
    expect(parseDescribeResponse({ speech: "", visual: "screen" })).toEqual({
      speech: "",
      visual: "screen",
    });
  });
  it("nothing at all is null", () => {
    expect(parseDescribeResponse({ speech: "", visual: "" })).toBeNull();
    expect(parseDescribeResponse(null)).toBeNull();
    expect(parseDescribeResponse("text")).toBeNull();
  });
});

describe("postDescribe", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  it("posts multipart file + duration with the key to {gateway}/video/describe", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const result = await postDescribe({
      baseUrl: "https://api.getuno.xyz/v1/",
      apiKey: "k",
      bytes,
      fileName: "agent-copy.webm",
      mimeType: "video/webm",
      durationSec: 41.6,
      fetchImpl: async (url, init) => {
        seen = { url, ...(init ? { init } : {}) };
        return new Response(JSON.stringify({ speech: "do it", visual: "page" }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(result).toEqual({ speech: "do it", visual: "page" });
    expect(seen!.url).toBe("https://api.getuno.xyz/v1/video/describe");
    expect((seen!.init!.headers as Record<string, string>).authorization).toBe("Bearer k");
    const form = seen!.init!.body as FormData;
    expect(form.get("duration_sec")).toBe("42");
    expect((form.get("file") as File).name).toBe("agent-copy.webm");
  });

  it("the gateway's own sentence comes through (limits, too long)", async () => {
    const error = await postDescribe({
      baseUrl: "https://g/v1",
      apiKey: "k",
      bytes,
      fileName: "a.mp4",
      mimeType: "video/mp4",
      durationSec: 700,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: { code: "video_too_long", message: "Videos up to 10 minutes can be described" },
          }),
          { status: 400 },
        ),
    }).catch((e: unknown) => e as { message: string; reason: string });
    expect(error).toMatchObject({
      message: "Videos up to 10 minutes can be described",
      reason: "gateway",
    });
  });

  it("an older gateway without the route is 'unsupported'", async () => {
    const error = await postDescribe({
      baseUrl: "https://g/v1",
      apiKey: "k",
      bytes,
      fileName: "a.mp4",
      mimeType: "video/mp4",
      durationSec: 5,
      fetchImpl: async () => new Response("not found", { status: 404 }),
    }).catch((e: unknown) => e as { reason: string });
    expect(error).toMatchObject({ reason: "unsupported" });
  });
});

describe("postDescribeDrive (recordings over 10 minutes)", () => {
  const parts = [
    { key: "Recordings/.agent-r1/part-01.webm", durationSec: 300 },
    { key: "Recordings/.agent-r1/part-02.webm", durationSec: 149.6 },
  ];
  it("posts the parts' Drive keys as JSON to {gateway}/video/describe/drive", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const result = await postDescribeDrive({
      baseUrl: "https://api.getuno.xyz/v1",
      apiKey: "k",
      parts,
      fetchImpl: async (url, init) => {
        seen = { url, ...(init ? { init } : {}) };
        return new Response(JSON.stringify({ speech: "[0:00] a\n\n[5:00] b", visual: "x" }));
      },
    });
    expect(result.speech).toContain("[5:00] b");
    expect(seen!.url).toBe("https://api.getuno.xyz/v1/video/describe/drive");
    const headers = seen!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer k");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(seen!.init!.body as string)).toEqual({
      parts: [
        { key: "Recordings/.agent-r1/part-01.webm", duration_sec: 300 },
        { key: "Recordings/.agent-r1/part-02.webm", duration_sec: 150 },
      ],
    });
  });

  it("a console without the route says so plainly", async () => {
    const error = await postDescribeDrive({
      baseUrl: "https://g/v1",
      apiKey: "k",
      parts,
      fetchImpl: async () => new Response("404 page not found", { status: 404 }),
    }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ reason: "unsupported" });
    expect((error as Error).message).toContain("longer than 10 minutes");
  });

  it("the gateway's sentence (which part failed) comes through", async () => {
    const error = await postDescribeDrive({
      baseUrl: "https://g/v1",
      apiKey: "k",
      parts,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { message: "Part 2 of the recording isn't in Uno Drive." } }),
          { status: 404 },
        ),
    }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ reason: "gateway" });
    expect((error as Error).message).toContain("Part 2");
  });
});

describe("resolveRecordingPath", () => {
  let root = "";
  beforeAll(async () => {
    root = await fsPromises.realpath(await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "loom-")));
    await fsPromises.mkdir(nodePath.join(root, ".uno-recordings/r1"), { recursive: true });
    await fsPromises.writeFile(nodePath.join(root, ".uno-recordings/r1/agent-copy.mp4"), "x");
  });
  afterAll(async () => {
    await fsPromises.rm(root, { recursive: true, force: true });
  });

  it("takes ~/ and absolute paths inside the home", async () => {
    const expected = nodePath.join(root, ".uno-recordings/r1/agent-copy.mp4");
    expect(await resolveRecordingPath(root, "~/.uno-recordings/r1/agent-copy.mp4")).toBe(expected);
    expect(await resolveRecordingPath(root, expected)).toBe(expected);
  });

  it("refuses anything outside the home", async () => {
    await expect(resolveRecordingPath(root, "/etc/passwd")).rejects.toThrow();
    await expect(resolveRecordingPath(root, "~/../../etc/passwd")).rejects.toThrow();
    await expect(resolveRecordingPath(root, "relative/path")).rejects.toThrow();
  });
});

describe("timeline mode (28.10)", () => {
  it("parses the timeline: junk out, in order", () => {
    expect(
      parseTimeline([
        { t: 9, say: "b" },
        { t: 2, see: " cursor on Save " },
        { t: -1, say: "x" },
        { t: 3 },
        "x",
      ]),
    ).toEqual([
      { t: 2, say: "", see: "cursor on Save", do: "" },
      { t: 9, say: "b", see: "", do: "" },
    ]);
    expect(
      parseDescribeResponse({
        speech: "",
        visual: "",
        timeline: [{ t: 1, say: "", see: "", do: "click" }],
      }),
    ).toEqual({ speech: "", visual: "", timeline: [{ t: 1, say: "", see: "", do: "click" }] });
  });

  it("asks for the timeline with the clicks (rounded, bad places dropped)", async () => {
    let form: FormData | null = null;
    const result = await postDescribe({
      baseUrl: "https://api.getuno.xyz/v1",
      apiKey: "k",
      bytes: new Uint8Array([1]),
      fileName: "a.webm",
      mimeType: "video/webm",
      durationSec: 20,
      mode: "timeline",
      events: [
        { t: 12.44, kind: "click", x: 0.83333, y: 0.0812 },
        { t: 13, kind: "click", x: 2, y: 0.5 },
      ],
      fetchImpl: async (_url, init) => {
        form = init!.body as FormData;
        return new Response(
          JSON.stringify({
            speech: "вот тут",
            visual: "x",
            timeline: [{ t: 12.4, say: "вот тут", see: "cursor on Pricing", do: "" }],
          }),
        );
      },
    });
    expect(form!.get("mode")).toBe("timeline");
    expect(JSON.parse(form!.get("events") as string)).toEqual([
      { t: 12.4, kind: "click", x: 0.833, y: 0.081 },
      { t: 13, kind: "click" },
    ]);
    expect(result.timeline).toEqual([
      { t: 12.4, say: "вот тут", see: "cursor on Pricing", do: "" },
    ]);
  });

  it("the long path carries mode and events in the JSON", async () => {
    let body: unknown = null;
    await postDescribeDrive({
      baseUrl: "https://api.getuno.xyz/v1",
      apiKey: "k",
      parts: [{ key: "Recordings/.agent-r1/part-01.webm", durationSec: 300 }],
      mode: "timeline",
      events: [{ t: 301.2, kind: "click" }],
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ speech: "a", visual: "b" }));
      },
    });
    expect(body).toMatchObject({ mode: "timeline", events: [{ t: 301.2, kind: "click" }] });
  });

  it("without the mode nothing extra is sent (an older gateway sees the same request)", async () => {
    let form: FormData | null = null;
    await postDescribe({
      baseUrl: "https://x/v1",
      apiKey: "k",
      bytes: new Uint8Array([1]),
      fileName: "a.webm",
      mimeType: "video/webm",
      durationSec: 5,
      events: [{ t: 1, kind: "click" }],
      fetchImpl: async (_url, init) => {
        form = init!.body as FormData;
        return new Response(JSON.stringify({ speech: "a", visual: "b" }));
      },
    });
    expect(form!.get("mode")).toBeNull();
    expect(form!.get("events")).toBeNull();
  });
});
