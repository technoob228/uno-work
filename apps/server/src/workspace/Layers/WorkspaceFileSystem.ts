import * as OS from "node:os";
import fsPromises from "node:fs/promises";

import { Effect, FileSystem, Layer, Path } from "effect";

import { FILESYSTEM_READ_FILE_DEFAULT_MAX_BYTES } from "@t3tools/contracts";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  WorkspaceReadFileError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".log",
  ".csv",
  ".tsv",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".html",
  ".htm",
  ".xml",
  ".svg",
  ".css",
  ".scss",
  ".less",
  ".js",
  ".cjs",
  ".mjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".sql",
  ".graphql",
  ".vue",
  ".svelte",
  ".dockerfile",
  ".gitignore",
  ".editorconfig",
]);

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".txt": "text/plain",
};

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(OS.homedir(), input.slice(2));
  }
  return input;
}

function detectEncoding(buffer: Buffer, ext: string): "utf8" | "base64" {
  if (TEXT_EXTENSIONS.has(ext)) {
    return "utf8";
  }
  if (ext in MIME_BY_EXT) {
    return MIME_BY_EXT[ext]!.startsWith("text/") ? "utf8" : "base64";
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) {
      return "base64";
    }
  }
  return "utf8";
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const expanded = expandHomePath(input.path, path);
      const absolutePath = path.resolve(expanded);
      const maxBytes = input.maxBytes ?? FILESYSTEM_READ_FILE_DEFAULT_MAX_BYTES;

      const stat = yield* Effect.tryPromise({
        try: () => fsPromises.stat(absolutePath),
        catch: (cause) =>
          new WorkspaceReadFileError({
            path: absolutePath,
            operation: "workspaceFileSystem.readFile.stat",
            detail: `Unable to stat '${absolutePath}': ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });

      if (!stat.isFile()) {
        return yield* new WorkspaceReadFileError({
          path: absolutePath,
          operation: "workspaceFileSystem.readFile.notFile",
          detail: `Path '${absolutePath}' is not a file.`,
        });
      }

      const size = stat.size;
      const truncated = size > maxBytes;
      const bytesToRead = truncated ? maxBytes : size;

      const buffer = yield* Effect.tryPromise({
        try: async () => {
          const handle = await fsPromises.open(absolutePath, "r");
          try {
            const target = Buffer.alloc(bytesToRead);
            const { bytesRead } = await handle.read(target, 0, bytesToRead, 0);
            return bytesRead === bytesToRead ? target : target.subarray(0, bytesRead);
          } finally {
            await handle.close();
          }
        },
        catch: (cause) =>
          new WorkspaceReadFileError({
            path: absolutePath,
            operation: "workspaceFileSystem.readFile.read",
            detail: `Unable to read '${absolutePath}': ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });

      const ext = path.extname(absolutePath).toLowerCase();
      const encoding = detectEncoding(buffer, ext);
      const content = encoding === "utf8" ? buffer.toString("utf8") : buffer.toString("base64");
      const mimeType = MIME_BY_EXT[ext];

      return {
        content,
        encoding,
        size,
        truncated,
        ...(mimeType ? { mimeType } : {}),
      };
    },
  );

  return { writeFile, readFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
