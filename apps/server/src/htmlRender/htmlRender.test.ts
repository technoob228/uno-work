import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findLocalImages,
  HTML_RENDER_MAX_IMAGE_BYTES,
  HtmlRenderProblem,
  inlineLocalImages,
  isImageBytes,
  preparePage,
  rejectViewportHeight,
  storePage,
  type HtmlRenderFiles,
} from "./htmlRender.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let root: string;
const files = (): HtmlRenderFiles => ({
  resolve: (reference) => (path.isAbsolute(reference) ? reference : path.join(root, reference)),
  denied: () => null,
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "html-render-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("rejectViewportHeight", () => {
  it("refuses viewport heights in styles and lets the rest through", () => {
    expect(() => rejectViewportHeight("<style>.a{height:100vh}</style>")).toThrow(
      HtmlRenderProblem,
    );
    expect(() => rejectViewportHeight('<div style="min-height: 50svh"></div>')).toThrow(/50svh/);
    expect(() => rejectViewportHeight("<style>.a{height:320px}</style><p>100vh</p>")).not.toThrow();
    expect(() => rejectViewportHeight("<!-- height:100vh --><p>x</p>")).not.toThrow();
  });
});

describe("findLocalImages", () => {
  it("finds absolute, home, file: and relative paths, and leaves addresses alone", () => {
    const html = [
      `<img src="/abs/a.png">`,
      `<img src='~/b.jpg'>`,
      `<img src="file:///abs/c%20d.png">`,
      `<img src="charts/e.webp">`,
      `<div style="background:url(/abs/f.png)"></div>`,
      `<div style="background:url('./g.svg')"></div>`,
      `<img src="https://example.com/h.png">`,
      `<img src="data:image/png;base64,AAAA.png">`,
      `<img src="//cdn.example.com/i.png">`,
      `<script>const j = "/abs/j.gif";</script>`,
    ].join("");
    expect(findLocalImages(html).map((entry) => entry.reference)).toEqual([
      "/abs/a.png",
      "~/b.jpg",
      "file:///abs/c%20d.png",
      "charts/e.webp",
      "/abs/f.png",
      "./g.svg",
      "/abs/j.gif",
    ]);
  });
});

describe("isImageBytes", () => {
  it("knows images by their bytes", () => {
    expect(isImageBytes(PNG)).toBe(true);
    expect(isImageBytes(Buffer.from('<?xml version="1.0"?><svg xmlns="x"></svg>'))).toBe(true);
    expect(isImageBytes(Buffer.from("OPENAI_API_KEY=sk-secret\n"))).toBe(false);
    expect(isImageBytes(Buffer.from("<html><svg></svg></html>"))).toBe(false);
  });
});

describe("inlineLocalImages", () => {
  it("embeds an image so the page outlives the file", async () => {
    const file = path.join(root, "shot.png");
    await writeFile(file, PNG);
    const page = await inlineLocalImages(`<img src="${file}"><img src="shot.png">`, files());
    await rm(file);
    expect(page.missing).toEqual([]);
    expect(page.html).not.toContain(root);
    expect(page.html.match(/data:image\/png;base64,/g)).toHaveLength(2);
  });

  it("reports what it couldn't read", async () => {
    const page = await inlineLocalImages(`<img src="${root}/no.png">`, files());
    expect(page.missing).toEqual([`${root}/no.png`]);
    expect(page.html).toContain(`${root}/no.png`);
  });

  it("won't lift a secret that only looks like a picture", async () => {
    const env = path.join(root, ".env");
    await writeFile(env, "OPENAI_API_KEY=sk-secret\n");
    await symlink(env, path.join(root, "logo.png"));
    const page = await inlineLocalImages(`<img src="${root}/logo.png">`, files());
    expect(page.missing).toEqual([`${root}/logo.png`]);
    expect(page.html).not.toContain(Buffer.from("OPENAI").toString("base64").slice(0, 6));
  });

  it("keeps an assistant inside its boundary, symlinks included", async () => {
    const inside = path.join(root, "project");
    const outside = path.join(root, "private");
    await mkdir(inside);
    await mkdir(outside);
    await writeFile(path.join(outside, "photo.png"), PNG);
    await symlink(path.join(outside, "photo.png"), path.join(inside, "photo.png"));
    const fenced: HtmlRenderFiles = {
      ...files(),
      denied: (absolute) =>
        absolute.startsWith(`${inside}${path.sep}`) ? null : "Ada works only in its projects.",
    };
    await expect(inlineLocalImages(`<img src="${inside}/photo.png">`, fenced)).rejects.toThrow(
      "Ada works only in its projects.",
    );
  });

  it("refuses an image over the limit", async () => {
    const file = path.join(root, "big.png");
    await writeFile(file, Buffer.alloc(HTML_RENDER_MAX_IMAGE_BYTES + 1));
    await expect(inlineLocalImages(`<img src="${file}">`, files())).rejects.toThrow(
      /at most 10\.0 MiB/,
    );
  });
});

describe("preparePage", () => {
  it("adds the bootstrap and keeps data out of its head scan", async () => {
    const file = path.join(root, "a.png");
    await writeFile(file, PNG);
    const page = await preparePage(
      `<!doctype html><html><head></head><body><img src="${file}"></body></html>`,
      files(),
    );
    expect(page.html.indexOf('<style id="t3-theme">')).toBeLessThan(page.html.indexOf("<img"));
    expect(page.html).toContain("data:image/png;base64,");
  });
});

describe("storePage", () => {
  it("keeps the page under an id tied to the thread, readable by its owner only", async () => {
    const stored = await storePage({
      attachmentsDir: root,
      threadId: "Thread 1",
      html: "<p>x</p>",
    });
    expect(stored.attachmentId).toMatch(/^thread-1-[0-9a-f-]{36}$/);
    expect(stored.path).toBe(path.join(root, `${stored.attachmentId}.html`));
    expect(await readFile(stored.path, "utf8")).toBe("<p>x</p>");
  });
});
