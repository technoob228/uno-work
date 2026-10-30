import { describe, expect, it } from "vitest";

import {
  PROJECT_UPLOAD_CHUNK_BYTES,
  PROJECT_UPLOAD_MAX_FILE_BYTES,
  computerUploadDeps,
  isFolderOrZipDrop,
  isNotEnoughSpaceError,
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
    const plan = planProjectUpload(
      [{ relativePath: "huge.bin", size: PROJECT_UPLOAD_MAX_FILE_BYTES + 1 }],
      { filterIgnored: true },
    );
    expect(plan.accepted).toEqual([]);
    expect(plan.skipped).toEqual([{ relativePath: "huge.bin", reason: "too-large" }]);
  });

  it("takes a 10 GB file, alone or among others", () => {
    const big = { relativePath: "film.mov", size: 10 * 1024 ** 3 };
    const plan = planProjectUpload([big, { relativePath: "notes.md", size: 5 }], {
      filterIgnored: true,
    });
    expect(plan.accepted.map((entry) => entry.relativePath).toSorted()).toEqual([
      "film.mov",
      "notes.md",
    ]);
    expect(plan.skipped).toEqual([]);
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

describe("the space check before an upload", () => {
  const upload = (
    ensureSpace: (targetDir: string, bytes: number) => Promise<unknown>,
    alreadyUploaded?: ReadonlySet<string>,
  ) => {
    const writes: ProjectUploadWriteInput[] = [];
    const run = uploadFilesIntoDirectory(
      {
        ensureSpace,
        writeFile: async (input) => {
          writes.push(input);
        },
        readChunkBase64: async () => "AA==",
      },
      {
        targetDir: "~/projects/a",
        files: [makeFile("a.bin", 10), makeFile("b.bin", 20)],
        filterIgnored: false,
        ...(alreadyUploaded ? { alreadyUploaded } : {}),
      },
    );
    return { run, writes };
  };

  it("asks once for everything that goes", async () => {
    const asked: Array<[string, number]> = [];
    const { run } = upload(async (targetDir, bytes) => asked.push([targetDir, bytes]));
    await run;
    expect(asked).toEqual([["~/projects/a", 30]]);
  });

  it("counts only what a resume still has to send", async () => {
    const asked: number[] = [];
    const { run } = upload(async (_, bytes) => asked.push(bytes), new Set(["a.bin"]));
    await run;
    expect(asked).toEqual([20]);
  });

  it("sends nothing when the disk can't take it", async () => {
    const refusal = new Error("Not enough space on this computer: needs 30 B, 1 B free.");
    const { run, writes } = upload(async () => {
      throw refusal;
    });
    await expect(run).rejects.toBe(refusal);
    expect(writes).toEqual([]);
  });

  it("isn't asked when there's nothing left to send", async () => {
    const asked: number[] = [];
    const { run } = upload(async (_, bytes) => asked.push(bytes), new Set(["a.bin", "b.bin"]));
    await run;
    expect(asked).toEqual([]);
  });
});

describe("computerUploadDeps", () => {
  const depsWith = (ensureSpace: () => Promise<unknown>) =>
    computerUploadDeps({
      projects: { writeFile: async () => ({ relativePath: "a" }) },
      files: { ensureSpace },
    } as unknown as Parameters<typeof computerUploadDeps>[0]);

  it("stops the upload on a real refusal", async () => {
    const refusal = new Error("Not enough space on this computer: needs 3 GB, 1 GB free.");
    const deps = depsWith(async () => {
      throw refusal;
    });
    await expect(deps.ensureSpace!("~", 1)).rejects.toBe(refusal);
    expect(isNotEnoughSpaceError(refusal)).toBe(true);
  });

  it("goes on with a computer too old to know the question", async () => {
    const deps = depsWith(async () => {
      throw new Error("Unknown request files.ensureSpace");
    });
    await expect(deps.ensureSpace!("~", 1)).resolves.toBeUndefined();
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
      { relativePath: "node_modules/junk.js", reason: "ignored", folder: "node_modules" },
    ]);
    expect(writes.map((write) => write.relativePath)).toEqual(["src/app.ts"]);
  });
});

describe("a drop on a new chat", () => {
  it("takes a folder or a .zip as a folder to work in", () => {
    expect(isFolderOrZipDrop([{ isDirectory: true, name: "site" }])).toBe(true);
    expect(isFolderOrZipDrop([{ isDirectory: false, name: "Shop.ZIP" }])).toBe(true);
    expect(
      isFolderOrZipDrop([
        { isDirectory: false, name: "photo.png" },
        { isDirectory: false, name: "site.zip" },
      ]),
    ).toBe(true);
  });

  it("leaves images, videos and other files as attachments", () => {
    expect(isFolderOrZipDrop([{ isDirectory: false, name: "photo.png" }])).toBe(false);
    expect(isFolderOrZipDrop([{ isDirectory: false, name: "clip.mp4" }])).toBe(false);
    expect(isFolderOrZipDrop([{ isDirectory: false, name: "notes.zip.txt" }])).toBe(false);
    expect(isFolderOrZipDrop([])).toBe(false);
  });
});

describe("uploadFilesIntoDirectory — a big folder", () => {
  const instantChunk = async (chunk: Blob) => `b64:${chunk.size}`;

  it("keeps several files in flight, and each file's chunks in order", async () => {
    let inFlight = 0;
    let peak = 0;
    const writes: ProjectUploadWriteInput[] = [];
    const files = [
      ...Array.from({ length: 30 }, (_, index) => makeFile(`src/f${index}.ts`, 10)),
      makeFile("big.bin", PROJECT_UPLOAD_CHUNK_BYTES * 3),
    ];
    await uploadFilesIntoDirectory(
      {
        writeFile: async (input) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          writes.push(input);
          inFlight -= 1;
        },
        readChunkBase64: instantChunk,
      },
      { targetDir: "/p", files, filterIgnored: true, concurrency: 8 },
    );
    expect(peak).toBe(8);
    expect(writes).toHaveLength(30 + 3);
    const big = writes.filter((write) => write.relativePath === "big.bin");
    expect(big.map((write) => write.mode ?? "replace")).toEqual(["replace", "append", "append"]);
  });

  it("resumes: files already on the computer are counted, not sent", async () => {
    const sent: string[] = [];
    const progress: Array<{ completedFiles: number; sentBytes: number }> = [];
    const result = await uploadFilesIntoDirectory(
      {
        writeFile: async (input) => void sent.push(input.relativePath),
        readChunkBase64: instantChunk,
      },
      {
        targetDir: "/p",
        files: [makeFile("a.txt", 5), makeFile("b.txt", 7), makeFile("c.txt", 9)],
        filterIgnored: true,
        alreadyUploaded: new Set(["a.txt", "c.txt"]),
        onProgress: (next) => progress.push(next),
      },
    );
    expect(sent).toEqual(["b.txt"]);
    expect(result.uploadedFiles).toBe(3);
    expect(progress[0]).toMatchObject({ completedFiles: 2, sentBytes: 14 });
    expect(progress.at(-1)).toMatchObject({ completedFiles: 3, sentBytes: 21 });
  });

  it("stops every worker on the first failure and reports what finished", async () => {
    const done: string[] = [];
    let calls = 0;
    await expect(
      uploadFilesIntoDirectory(
        {
          writeFile: async (input) => {
            calls += 1;
            if (input.relativePath === "f3.txt") throw new Error("socket closed");
            await new Promise((resolve) => setTimeout(resolve, 2));
          },
          readChunkBase64: instantChunk,
        },
        {
          targetDir: "/p",
          files: Array.from({ length: 50 }, (_, index) => makeFile(`f${index}.txt`, 1)),
          filterIgnored: true,
          concurrency: 4,
          onFileUploaded: (path) => done.push(path),
        },
      ),
    ).rejects.toThrow("socket closed");
    expect(calls).toBeLessThan(12);
    expect(done).not.toContain("f3.txt");
  });
});
