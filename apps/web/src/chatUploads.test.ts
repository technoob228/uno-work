import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  chatFileRejection,
  chatUploadIncomingRelativePath,
  displayUploadPath,
  routeComposerFiles,
  stageChatFileUpload,
} from "./chatUploads";
import type { ComposerFileAttachment } from "./composerDraftStore";
import { ensureEnvironmentApi } from "./environmentApi";
import { PROJECT_UPLOAD_MAX_FILE_BYTES } from "./projectUpload";

vi.mock("./environmentApi", () => ({ ensureEnvironmentApi: vi.fn() }));

const entry = (name: string, type: string, size = 10) => ({ name, type, size });
const isVideo = (file: { type: string }) => file.type.startsWith("video/");

describe("routeComposerFiles", () => {
  it("sends pictures inline, videos as videos and the rest as files", () => {
    const routed = routeComposerFiles(
      [
        entry("a.png", "image/png"),
        entry("b.mp4", "video/mp4"),
        entry("c.pdf", "application/pdf"),
        entry("d", ""),
      ],
      { isVideo, imagesSupported: true },
    );
    expect(routed.images.map((file) => file.name)).toEqual(["a.png"]);
    expect(routed.videos.map((file) => file.name)).toEqual(["b.mp4"]);
    expect(routed.files.map((file) => file.name)).toEqual(["c.pdf", "d"]);
  });

  it("sends a picture as a file when it is too big or the model can't see it", () => {
    const big = entry("big.png", "image/png", PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);
    expect(routeComposerFiles([big], { isVideo, imagesSupported: true }).files).toEqual([big]);
    const small = entry("small.png", "image/png");
    expect(routeComposerFiles([small], { isVideo, imagesSupported: false }).files).toEqual([small]);
  });
});

describe("any safe file can be attached", () => {
  const kinds = [
    entry("Report.pdf", "application/pdf"),
    entry(
      "Contract.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    entry("Budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    entry("Deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    entry("notes.txt", "text/plain"),
    entry("README.md", "text/markdown"),
    entry("data.csv", "text/csv"),
    entry("config.json", "application/json"),
    entry("site.zip", "application/zip"),
    entry("backup.tar.gz", "application/gzip"),
    entry("script.py", "text/x-python"),
    entry("Setup.exe", "application/x-msdownload"),
    entry("Makefile", ""),
  ];

  it("takes every document, archive and code file as a file (never as a picture)", () => {
    const routed = routeComposerFiles(kinds, { isVideo, imagesSupported: true });
    expect(routed.files).toEqual(kinds);
    expect(routed.images).toEqual([]);
    for (const file of kinds) expect(chatFileRejection(file)).toBeNull();
  });

  it("has the same size limit as an upload to Files", () => {
    expect(PROVIDER_SEND_TURN_MAX_FILE_BYTES).toBe(PROJECT_UPLOAD_MAX_FILE_BYTES);
  });
});

describe("chatFileRejection", () => {
  it("only refuses files over the upload limit", () => {
    expect(chatFileRejection({ name: "a.zip", size: 1 })).toBeNull();
    expect(chatFileRejection({ name: "a.zip", size: 10 * 1024 ** 3 })).toBeNull();
    expect(
      chatFileRejection({ name: "a.zip", size: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 }),
    ).toContain("a.zip");
  });
});

describe("stageChatFileUpload", () => {
  const attachment = {
    type: "file",
    id: "file-1",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4,
    file: new File(["data"], "report.pdf"),
  } as ComposerFileAttachment;

  const writes: Array<{ contents: string; relativePath: string; mode?: string }> = [];
  const ensureSpace = vi.fn(async () => ({}));
  let failWrite: Error | null = null;

  beforeEach(() => {
    writes.length = 0;
    failWrite = null;
    ensureSpace.mockReset().mockResolvedValue({});
    vi.mocked(ensureEnvironmentApi).mockReturnValue({
      projects: {
        writeFile: async (input: (typeof writes)[number]) => {
          writes.push(input);
          if (failWrite && input.contents !== "") throw failWrite;
          return { relativePath: input.relativePath };
        },
      },
      files: { ensureSpace },
    } as unknown as ReturnType<typeof ensureEnvironmentApi>);
  });

  it("checks the disk, then stages into the hidden folder", async () => {
    const staged = await stageChatFileUpload("env" as never, attachment);
    expect(ensureSpace).toHaveBeenCalledWith({ path: "~", bytes: 4 });
    expect(writes[0]?.relativePath).toBe(chatUploadIncomingRelativePath(staged.uploadId));
  });

  it("says a full disk at once, without sending anything", async () => {
    const refusal = new Error("Not enough space on this computer: needs 4 B, 1 B free.");
    ensureSpace.mockRejectedValue(refusal);
    await expect(stageChatFileUpload("env" as never, attachment)).rejects.toBe(refusal);
    expect(writes.filter((write) => write.contents !== "")).toEqual([]);
  });

  it("gives back the room when the disk fills up on the way", async () => {
    failWrite = new Error("Not enough space on this computer. Free up space or pick fewer files.");
    await expect(stageChatFileUpload("env" as never, attachment)).rejects.toBe(failWrite);
    expect(writes.at(-1)?.contents).toBe("");
    expect(writes.at(-1)?.relativePath).toBe(writes[0]?.relativePath);
  });
});

describe("paths", () => {
  it("stages under the hidden incoming folder", () => {
    expect(chatUploadIncomingRelativePath("abc-123")).toBe("Uploads/.incoming/abc-123");
  });

  it("shows a saved file from the Uploads folder down", () => {
    expect(displayUploadPath("/Users/me/Uploads/2026-10/a.pdf")).toBe("Uploads/2026-10/a.pdf");
    expect(displayUploadPath("C:\\Users\\me\\Uploads\\2026-10\\a.pdf")).toBe(
      "Uploads/2026-10/a.pdf",
    );
    expect(displayUploadPath("/tmp/other.pdf")).toBe("/tmp/other.pdf");
  });
});
