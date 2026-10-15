import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { homeAttachmentsFromFiles } from "./homeAttachments";

const preview = (file: File) => `blob:${file.name}`;
const png = (name = "shot.png") => new File(["x"], name, { type: "image/png" });

describe("homeAttachmentsFromFiles", () => {
  it("takes pictures and names an unnamed paste", () => {
    const result = homeAttachmentsFromFiles([png(""), png("b.png")], 0, preview);
    expect(result.error).toBeNull();
    expect(result.images.map((image) => image.name)).toEqual(["image", "b.png"]);
    expect(result.images[0]?.previewUrl).toBe("blob:");
  });

  it("takes other files as files (they go to Uploads)", () => {
    const pdf = new File(["x"], "a.pdf", { type: "application/pdf" });
    const result = homeAttachmentsFromFiles([pdf, png()], 0, preview);
    expect(result.error).toBeNull();
    expect(result.images).toHaveLength(1);
    expect(result.files.map((file) => file.name)).toEqual(["a.pdf"]);
  });

  it("takes documents, archives and code from Home too", () => {
    const names = ["a.docx", "b.xlsx", "c.pptx", "d.zip", "e.py", "f.csv", "g.json", "h.exe"];
    const result = homeAttachmentsFromFiles(
      names.map((name) => new File(["x"], name)),
      0,
      preview,
    );
    expect(result.error).toBeNull();
    expect(result.images).toHaveLength(0);
    expect(result.files.map((file) => file.name)).toEqual(names);
  });

  it("sends a picture too big to inline as a file", () => {
    const big = new File(["x"], "huge.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1 });
    const result = homeAttachmentsFromFiles([big], 0, preview);
    expect(result.images).toHaveLength(0);
    expect(result.files.map((file) => file.name)).toEqual(["huge.png"]);
  });

  it("stops at the per-message limit", () => {
    const result = homeAttachmentsFromFiles(
      [png("a.png"), new File(["x"], "b.pdf")],
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
      preview,
    );
    expect(result.images).toHaveLength(1);
    expect(result.files).toHaveLength(0);
    expect(result.error).toContain(String(PROVIDER_SEND_TURN_MAX_ATTACHMENTS));
  });
});
