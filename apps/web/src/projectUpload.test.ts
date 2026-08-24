import { describe, expect, it } from "vitest";

import {
  PROJECT_UPLOAD_CHUNK_BYTES,
  PROJECT_UPLOAD_MAX_FILE_BYTES,
  planProjectUpload,
  uploadFilesIntoDirectory,
  type ProjectUploadFile,
  type ProjectUploadWriteInput,
} from "./projectUpload";

function makeFile(relativePath: string, size: number): ProjectUploadFile {
  return { relativePath, size, blob: new Blob([new Uint8Array(size)]) };
}

describe("planProjectUpload", () => {
  it("accepts files that the onboarding limits would reject", () => {
    const plan = planProjectUpload([makeFile("video.mp4", 200 * 1024 * 1024)], {
      filterIgnored: true,
    });
    expect(plan.accepted).toEqual([{ relativePath: "video.mp4", size: 200 * 1024 * 1024 }]);
    expect(plan.skipped).toEqual([]);
  });

  it("still rejects files above the project-upload cap", () => {
    const plan = planProjectUpload([makeFile("huge.bin", PROJECT_UPLOAD_MAX_FILE_BYTES + 1)], {
      filterIgnored: true,
    });
    expect(plan.accepted).toEqual([]);
    expect(plan.skipped).toEqual([{ relativePath: "huge.bin", reason: "too-large" }]);
  });

  it("keeps explicitly picked files even when their names look ignorable", () => {
    const files = [makeFile(".DS_Store", 12), makeFile("node_modules/keep.js", 5)];
    const filtered = planProjectUpload(files, { filterIgnored: true });
    expect(filtered.accepted).toEqual([]);
    const kept = planProjectUpload(files, { filterIgnored: false });
    expect(kept.accepted.map((entry) => entry.relativePath)).toEqual([
      ".DS_Store",
      "node_modules/keep.js",
    ]);
  });

  it("always drops unsafe paths regardless of options", () => {
    const plan = planProjectUpload([makeFile("../escape.txt", 1)], { filterIgnored: false });
    expect(plan.accepted).toEqual([]);
    expect(plan.skipped).toEqual([{ relativePath: "../escape.txt", reason: "unsafe-path" }]);
  });
});

describe("uploadFilesIntoDirectory", () => {
  it("splits large files into replace-then-append chunks", async () => {
    const writes: ProjectUploadWriteInput[] = [];
    const size = PROJECT_UPLOAD_CHUNK_BYTES * 2 + 10;

    const result = await uploadFilesIntoDirectory(
      {
        writeFile: async (input) => {
          writes.push(input);
        },
        readChunkBase64: async (chunk) => `<${chunk.size}>`,
      },
      {
        targetDir: "~/projects/demo",
        files: [makeFile("assets/model.bin", size)],
        filterIgnored: true,
      },
    );

    expect(result.uploadedFiles).toBe(1);
    expect(writes).toEqual([
      {
        cwd: "~/projects/demo",
        relativePath: "assets/model.bin",
        contents: `<${PROJECT_UPLOAD_CHUNK_BYTES}>`,
        encoding: "base64",
      },
      {
        cwd: "~/projects/demo",
        relativePath: "assets/model.bin",
        contents: `<${PROJECT_UPLOAD_CHUNK_BYTES}>`,
        encoding: "base64",
        mode: "append",
      },
      {
        cwd: "~/projects/demo",
        relativePath: "assets/model.bin",
        contents: "<10>",
        encoding: "base64",
        mode: "append",
      },
    ]);
  });

  it("writes empty files with a single empty replace", async () => {
    const writes: ProjectUploadWriteInput[] = [];
    await uploadFilesIntoDirectory(
      {
        writeFile: async (input) => {
          writes.push(input);
        },
        readChunkBase64: async () => "unused",
      },
      {
        targetDir: "~/p",
        files: [makeFile("empty.txt", 0)],
        filterIgnored: true,
      },
    );
    expect(writes).toEqual([
      { cwd: "~/p", relativePath: "empty.txt", contents: "", encoding: "base64" },
    ]);
  });

  it("reports byte progress and stops on abort", async () => {
    const controller = new AbortController();
    const progressBytes: number[] = [];
    let writeCount = 0;

    await expect(
      uploadFilesIntoDirectory(
        {
          writeFile: async () => {
            writeCount += 1;
            if (writeCount === 2) controller.abort();
          },
          readChunkBase64: async () => "x",
        },
        {
          targetDir: "~/p",
          files: [makeFile("big.bin", PROJECT_UPLOAD_CHUNK_BYTES * 3)],
          filterIgnored: true,
          signal: controller.signal,
          onProgress: (progress) => progressBytes.push(progress.sentBytes),
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(writeCount).toBe(2);
    expect(progressBytes.at(-1)).toBe(PROJECT_UPLOAD_CHUNK_BYTES * 2);
  });

  it("skips files rejected by the plan but uploads the rest", async () => {
    const writes: ProjectUploadWriteInput[] = [];
    const result = await uploadFilesIntoDirectory(
      {
        writeFile: async (input) => {
          writes.push(input);
        },
        readChunkBase64: async () => "data",
      },
      {
        targetDir: "~/p",
        files: [makeFile("node_modules/junk.js", 5), makeFile("src/app.ts", 5)],
        filterIgnored: true,
      },
    );
    expect(result.uploadedFiles).toBe(1);
    expect(result.plan.skipped).toEqual([
      { relativePath: "node_modules/junk.js", reason: "ignored" },
    ]);
    expect(writes.map((write) => write.relativePath)).toEqual(["src/app.ts"]);
  });
});
