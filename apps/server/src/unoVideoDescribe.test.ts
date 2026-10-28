import fsPromises from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseDescribeResponse, postDescribe, resolveRecordingPath } from "./unoVideoDescribe.ts";

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
