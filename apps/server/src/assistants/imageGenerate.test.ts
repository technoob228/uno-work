import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  decodeGeneratedImage,
  imageExtension,
  imageFileStem,
  imageGatewayProblem,
  requestGatewayImage,
  saveGeneratedImage,
} from "./imageGenerate.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("image generation", () => {
  it("decodes b64_json and data URLs, with model and cost", () => {
    const fromB64 = decodeGeneratedImage({
      model: "google/gemini-flash-image",
      data: [{ b64_json: PNG.toString("base64") }],
      usage: { cost_usd: 0.04 },
    });
    expect(fromB64?.model).toBe("google/gemini-flash-image");
    expect(fromB64?.costUsd).toBe(0.04);
    expect(Buffer.from(fromB64!.bytes).equals(PNG)).toBe(true);
    const fromUrl = decodeGeneratedImage({
      data: [{ url: `data:image/jpeg;base64,${JPG.toString("base64")}` }],
    });
    expect(imageExtension(fromUrl!.bytes)).toBe("jpg");
    expect(decodeGeneratedImage({ data: [] })).toBeNull();
    expect(decodeGeneratedImage({ data: [{ url: "https://example.com/x.png" }] })).toBeNull();
  });

  it("explains the gateway's refusals for a person", () => {
    expect(
      imageGatewayProblem(403, { error: "images_not_available", detail: "Not on a trial." }),
    ).toContain("Not on a trial.");
    expect(imageGatewayProblem(402, { error: "images_need_balance" })).toContain("balance");
    expect(imageGatewayProblem(404, null)).toContain("isn't switched on");
  });

  it("names files from the prompt and never overwrites", async () => {
    const now = new Date(2026, 9, 2, 15, 30, 5);
    expect(imageFileStem("A red fox logo, flat style!", now)).toBe(
      "a-red-fox-logo-flat-20261002-153005",
    );
    expect(imageFileStem("Лиса", now)).toBe("image-20261002-153005");
    const folder = mkdtempSync(path.join(os.tmpdir(), "uno-images-"));
    dirs.push(folder);
    const image = { bytes: new Uint8Array(PNG), model: null, costUsd: null };
    const first = await saveGeneratedImage({ folder, prompt: "fox", image, now });
    const second = await saveGeneratedImage({ folder, prompt: "fox", image, now });
    expect(first).toBe(path.join(folder, "images", "fox-20261002-153005.png"));
    expect(second).toBe(path.join(folder, "images", "fox-20261002-153005-1.png"));
    expect(readdirSync(path.join(folder, "images"))).toHaveLength(2);
    expect(readFileSync(first).equals(PNG)).toBe(true);
  });

  it("calls the gateway with the harness key and the default model", async () => {
    const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const image = await requestGatewayImage({
      baseUrl: "https://api.getuno.xyz/v1",
      apiKey: "unollm_key",
      prompt: "fox",
      size: "1024x1024",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seen.push({
          url,
          auth: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
      }) as typeof fetch,
    });
    expect(image.bytes.length).toBe(PNG.length);
    expect(seen).toEqual([
      {
        url: "https://api.getuno.xyz/v1/images/generations",
        auth: "Bearer unollm_key",
        body: { model: "default", prompt: "fox", n: 1, size: "1024x1024" },
      },
    ]);
    await expect(
      requestGatewayImage({
        baseUrl: "https://api.getuno.xyz/v1",
        apiKey: "unollm_key",
        prompt: "fox",
        fetchImpl: (async () =>
          new Response(JSON.stringify({ error: "images_need_balance" }), {
            status: 402,
          })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/balance/);
    await expect(
      requestGatewayImage({ baseUrl: "https://x/v1", apiKey: "", prompt: "fox" }),
    ).rejects.toThrow(/no working Uno AI key/);
  });
});
