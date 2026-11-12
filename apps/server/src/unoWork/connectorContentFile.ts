/**
 * `content_file` for connected-app tools that take a whole document as
 * `content` (gdrive_create, gdrive_append, notion_append…): the agent builds
 * a long document in a file, part by part, and sends it with one small call.
 * Without it the model had to write ~30k tokens inside one tool call; the
 * stream stalled and the request died, again and again (12.11).
 *
 * The file is read on this computer with the same rules as a mail
 * attachment: the caller's folder boundary, no hidden or key files.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

import { formatBytes } from "../computerResources/ComputerResourcesService.ts";
import { attachmentRefusal } from "./mailTools.ts";
import { boundaryDenial, isWithinRoot, type PathBoundary } from "./pathBoundary.ts";

export const CONTENT_FILE_ARG = "content_file";
/** The console takes `content` up to 5 MB. */
export const CONTENT_FILE_MAX_BYTES = 5 * 1024 * 1024;

const CONTENT_FILE_PROPERTY = {
  type: "string",
  minLength: 1,
  description:
    "Path to a text file on this computer to send as `content` (use it for long documents: write the file in parts first, then send it with one call).",
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isStringProperty = (value: unknown): boolean =>
  isRecord(value) &&
  (value["type"] === "string" ||
    (Array.isArray(value["type"]) && (value["type"] as unknown[]).includes("string")));

/** The tool takes its document as a string `content` (so `content_file` is offered). */
export function takesContent(schema: Record<string, unknown>): boolean {
  const properties = schema["properties"];
  return (
    isRecord(properties) &&
    isStringProperty(properties["content"]) &&
    !(CONTENT_FILE_ARG in properties)
  );
}

/**
 * The schema with an optional `content_file` next to `content`, and `content`
 * no longer required. A new object: the console's schema is shared.
 */
export function withContentFile(schema: Record<string, unknown>): Record<string, unknown> {
  if (!takesContent(schema)) return schema;
  const properties = schema["properties"] as Record<string, unknown>;
  const required = schema["required"];
  return {
    ...schema,
    properties: { ...properties, [CONTENT_FILE_ARG]: CONTENT_FILE_PROPERTY },
    ...(Array.isArray(required) ? { required: required.filter((name) => name !== "content") } : {}),
  };
}

export interface ContentFile {
  /** The file's name, for the approval card. */
  readonly name: string;
  readonly size: number;
  readonly text: string;
}

export interface ContentFileContext {
  readonly home: string;
  readonly cwd: string | undefined;
  readonly boundary: PathBoundary | null | undefined;
  /** tools.ts `resolveUserPath`: `~/x`, `/abs`, relative to the chat's folder; throws past the boundary. */
  readonly resolve: (raw: string) => string;
  /** `~/projects/x` for messages. */
  readonly display: (absolute: string) => string;
}

const realOrNull = (target: string) => fsp.realpath(target).catch(() => null);

/**
 * Reads `content_file`: a UTF-8 text file up to 5 MB inside what the caller
 * may reach. Throws an Error whose message is meant for the model.
 */
export async function readContentFile(
  raw: string,
  context: ContentFileContext,
): Promise<ContentFile> {
  const resolved = context.resolve(raw);
  const shown = context.display(resolved);
  const real = await realOrNull(resolved);
  if (real === null) {
    throw new Error(`There is no file ${shown}. Write the document there first, then send it.`);
  }
  // A link may point past the boundary: check where it really leads (against
  // the roots as given and as they really are — a project may be a link too).
  const boundary = context.boundary;
  const denial = boundaryDenial(real, boundary, context.home);
  if (denial !== null && boundary) {
    const realRoots = await Promise.all(
      boundary.roots.map(async (root) => (await realOrNull(root)) ?? root),
    );
    if (boundaryDenial(real, { ...boundary, roots: realRoots }, context.home) !== null) {
      throw new Error(denial);
    }
  }
  // Hidden folders above the chat's own folder (a chat copy lives in one) or
  // above home don't count; everything below them does.
  const chatFolder = context.cwd ? await realOrNull(context.cwd) : null;
  const home = (await realOrNull(context.home)) ?? context.home;
  const refusal = attachmentRefusal(
    real,
    chatFolder !== null && isWithinRoot(real, chatFolder) ? chatFolder : home,
  );
  if (refusal !== null) {
    throw new Error(
      `${shown} can't be sent to a connected app: ${refusal}. Don't try to get around this (copying, renaming, pasting its content).`,
    );
  }
  const stat = await fsp.stat(real);
  if (!stat.isFile()) throw new Error(`${shown} is not a file.`);
  if (stat.size > CONTENT_FILE_MAX_BYTES) {
    throw new Error(
      `${shown} is ${formatBytes(stat.size)}; a connected app takes up to ${formatBytes(CONTENT_FILE_MAX_BYTES)} at once. Send the first part, then add the rest in more calls (e.g. gdrive_append).`,
    );
  }
  if (stat.size === 0) throw new Error(`${shown} is empty: write the document into it first.`);
  const bytes = await fsp.readFile(real);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      `${shown} is not UTF-8 text. content_file takes a text file (Markdown, HTML, plain text).`,
    );
  }
  if (text.includes("\u0000")) {
    throw new Error(
      `${shown} is not a text file. content_file takes a text file (Markdown, HTML, plain text).`,
    );
  }
  return { name: path.basename(resolved), size: stat.size, text };
}

/** "content from report.md (48 KB)" for the approval card. */
export function describeContentFile(file: Pick<ContentFile, "name" | "size">): string {
  return `content from ${file.name} (${formatBytes(file.size)})`;
}
