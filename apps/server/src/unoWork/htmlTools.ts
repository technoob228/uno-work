/**
 * `html_preview` and `html_render`: the agent answers with a page, not only
 * text. They are `uno-work` tools, so every harness (Claude, Codex, OpenCode,
 * Uno) gets the same thing, and the page reaches the chat from the daemon, not
 * from the harness's tool events. See `apps/server/src/htmlRender/`.
 *
 * Upstream's two tools, with `file` added: a page already written to disk is
 * not spelled out twice in the model's output, once per call.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_FIT_HEIGHT,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_TOOL_NAME,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import { Effect } from "effect";

import {
  HTML_RENDER_MAX_PAGE_BYTES,
  HtmlRenderProblem,
  preparePage,
  type HtmlRenderFiles,
} from "../htmlRender/htmlRender.ts";
import { McpContent } from "../mcp/mcpJsonRpc.ts";
import { boundaryDenial } from "./pathBoundary.ts";
import type { UnoWorkTool, UnoWorkToolDeps, UnoWorkToolError } from "./tools.ts";

type Deps = UnoWorkToolDeps;

/** What the tools need from tools.ts (passed in: no runtime import cycle). */
export interface HtmlToolKit {
  readonly resolvePath: (raw: string, deps: Deps) => string;
  readonly fail: (message: string) => UnoWorkToolError;
}

const HTML_MAX_CHARS = 512_000;
const MIN_PREVIEW_WIDTH = 240;
const MAX_PREVIEW_WIDTH = 1_600;
const DEFAULT_FRAME_HEIGHT = 400;

const PAGE_RULES =
  "One self-contained page: inline <style> and <script>. Local images by path (~/…, absolute, or relative to the page) are embedded, so the page outlives them. Scripts, styles and fonts may load from cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com and Google Fonts. Nothing else on the network works: no fetch to other hosts, no remote images (save one to a file first), no iframes.";

const PAGE_INPUT = {
  html: {
    type: "string",
    maxLength: HTML_MAX_CHARS,
    description: "A complete, self-contained HTML document.",
  },
  file: {
    type: "string",
    description:
      "Instead of html: an .html file on this computer (~/…, absolute, or relative to this chat's folder). Cheaper for a big page: it isn't spelled out twice.",
  },
} as const;

const str = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const num = (args: Record<string, unknown>, key: string): number | undefined => {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

/** A problem the agent should read (a thrown boundary refusal is one); else `fallback`. */
const problemText = (cause: unknown, fallback: string): string =>
  cause instanceof HtmlRenderProblem ||
  (cause as { readonly _tag?: unknown } | null)?._tag === "UnoWorkToolError"
    ? (cause as Error).message
    : fallback;

const filesOf = (deps: Deps, kit: HtmlToolKit, pageFile: string | null): HtmlRenderFiles => ({
  resolve: (reference) =>
    !path.isAbsolute(reference) && !reference.startsWith("~") && pageFile !== null
      ? path.resolve(path.dirname(pageFile), reference)
      : kit.resolvePath(reference, deps),
  denied: (absolute) => boundaryDenial(absolute, deps.caller.boundary, deps.home),
});

const pageSource = (deps: Deps, args: Record<string, unknown>, kit: HtmlToolKit) =>
  Effect.gen(function* () {
    const html = str(args, "html");
    const file = str(args, "file");
    if ((html === undefined) === (file === undefined)) {
      return yield* Effect.fail(kit.fail("Give exactly one of html or file."));
    }
    if (html !== undefined) return { html, pageFile: null };
    const absolute = yield* Effect.try({
      try: () => kit.resolvePath(file ?? "", deps),
      catch: (cause) => kit.fail(problemText(cause, `Couldn't read ${file}.`)),
    });
    if (!/\.html?$/i.test(absolute)) {
      return yield* Effect.fail(kit.fail(`${file} is not an .html file.`));
    }
    const text = yield* Effect.tryPromise({
      try: async () => {
        const info = await fsp.stat(absolute);
        if (info.size > HTML_RENDER_MAX_PAGE_BYTES) {
          throw new HtmlRenderProblem(`${file} is too big for a page in the chat.`);
        }
        return fsp.readFile(absolute, "utf8");
      },
      catch: (cause) => kit.fail(problemText(cause, `Couldn't read ${file}.`)),
    });
    return { html: text, pageFile: absolute };
  });

const prepare = (deps: Deps, args: Record<string, unknown>, kit: HtmlToolKit) =>
  Effect.gen(function* () {
    const source = yield* pageSource(deps, args, kit);
    return yield* Effect.tryPromise({
      try: () => preparePage(source.html, filesOf(deps, kit, source.pageFile)),
      catch: (cause) => kit.fail(problemText(cause, "The page could not be prepared.")),
    });
  });

export const htmlRenderTools = (kit: HtmlToolKit): ReadonlyArray<UnoWorkTool> => [
  {
    name: "html_preview",
    group: "person",
    description: `Check a page before html_render: a screenshot, contentHeight, the console and what was blocked. ${PAGE_RULES} Theme and layout rules are in html_render.`,
    inputSchema: {
      type: "object",
      properties: {
        ...PAGE_INPUT,
        width: {
          type: "integer",
          minimum: MIN_PREVIEW_WIDTH,
          maximum: MAX_PREVIEW_WIDTH,
          description: `CSS pixels. Default ${HTML_RENDER_COLUMN_WIDTH}. About 390 for a phone.`,
        },
        appearance: { type: "string", enum: ["dark", "light"], description: "Default dark." },
      },
      additionalProperties: false,
    },
    level: "safe",
    run: (deps, args) =>
      Effect.gen(function* () {
        if (!deps.htmlRender) {
          return yield* Effect.fail(kit.fail("Pages aren't available on this computer."));
        }
        const prepared = yield* prepare(deps, args, kit);
        const appearance = str(args, "appearance") === "light" ? "light" : "dark";
        const width = Math.min(
          MAX_PREVIEW_WIDTH,
          Math.max(MIN_PREVIEW_WIDTH, Math.round(num(args, "width") ?? HTML_RENDER_COLUMN_WIDTH)),
        );
        const shot = yield* deps.htmlRender.capture({ html: prepared.html, width, appearance });
        const { png, ...report } = shot;
        return new McpContent([
          { type: "image", mimeType: "image/png", data: png },
          {
            type: "text",
            text: JSON.stringify({
              ...report,
              width,
              ...(prepared.missing.length > 0 ? { missingImages: prepared.missing } : {}),
            }),
          },
        ]);
      }),
  },
  {
    name: HTML_RENDER_TOOL_NAME,
    group: "person",
    description: `Show a finished HTML page (chart, table, diagram, report, mockup) inline in this chat, above your final reply. Do not announce or restate the page. ${PAGE_RULES} The frame fits the page's height up to ${HTML_RENDER_MAX_FIT_HEIGHT}px. ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`,
    inputSchema: {
      type: "object",
      properties: {
        ...PAGE_INPUT,
        title: { type: "string", maxLength: HTML_RENDER_MAX_TITLE_LENGTH },
        height: {
          type: "integer",
          description: `Frame height before the page loads, ${HTML_RENDER_MIN_HEIGHT} to ${HTML_RENDER_MAX_HEIGHT}. Use the contentHeight from html_preview. Default ${DEFAULT_FRAME_HEIGHT}.`,
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    level: "safe",
    run: (deps, args) =>
      Effect.gen(function* () {
        if (!deps.htmlRender) {
          return yield* Effect.fail(kit.fail("Pages aren't available on this computer."));
        }
        const title = str(args, "title")?.trim();
        if (!title) return yield* Effect.fail(kit.fail("Give the page a title."));
        const prepared = yield* prepare(deps, args, kit);
        if (prepared.missing.length > 0) {
          return yield* Effect.fail(
            kit.fail(
              `These local images could not be read: ${prepared.missing.join(", ")}. Use paths to existing image files, or remove them.`,
            ),
          );
        }
        const reference: HtmlRenderReference = yield* deps.htmlRender.publish({
          html: prepared.html,
          title,
          height: num(args, "height") ?? DEFAULT_FRAME_HEIGHT,
        });
        return {
          ok: true,
          title: reference.title,
          message:
            "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
        };
      }),
  },
];
