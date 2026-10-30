import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_INLINE_IMAGE_TOTAL_BYTES,
  PROVIDER_SEND_TURN_MAX_INLINE_IMAGES,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  chatFileRejection,
  chatUploadIncomingRelativePath,
  displayUploadPath,
  routeComposerFiles,
} from "./chatUploads";
import { PROJECT_UPLOAD_MAX_FILE_BYTES } from "./projectUpload";

const entry = (name: string, type: string, size = 10) => ({ name, type, size });
const isVideo = (file: { type: string }) => file.type.startsWith("video/");

describe("routeComposerFiles", () => {
  it("sends pictures past what one message carries inline as files", () => {
    const pictures = Array.from({ length: 3 }, (_, index) =>
      entry(`p${index}.png`, "image/png", 1024),
    );
    const byCount = routeComposerFiles(pictures, {
      isVideo,
      imagesSupported: true,
      inlineImages: { count: PROVIDER_SEND_TURN_MAX_INLINE_IMAGES - 1, bytes: 0 },
    });
    expect(byCount.images.map((file) => file.name)).toEqual(["p0.png"]);
    expect(byCount.files.map((file) => file.name)).toEqual(["p1.png", "p2.png"]);

    const byBytes = routeComposerFiles(pictures, {
      isVideo,
      imagesSupported: true,
      inlineImages: { count: 0, bytes: PROVIDER_SEND_TURN_MAX_INLINE_IMAGE_TOTAL_BYTES - 1024 },
    });
    expect(byBytes.images).toHaveLength(1);
    expect(byBytes.files).toHaveLength(2);
  });

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
    expect(
      chatFileRejection({ name: "a.zip", size: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 }),
    ).toContain("a.zip");
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
