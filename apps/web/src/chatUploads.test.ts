import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  chatFileRejection,
  chatUploadIncomingRelativePath,
  displayUploadPath,
  routeComposerFiles,
} from "./chatUploads";

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
