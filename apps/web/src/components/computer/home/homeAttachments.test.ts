import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { homeImagesFromFiles } from "./homeAttachments";

const preview = (file: File) => `blob:${file.name}`;
const png = (name = "shot.png") => new File(["x"], name, { type: "image/png" });

describe("homeImagesFromFiles", () => {
  it("takes pictures and names an unnamed paste", () => {
    const result = homeImagesFromFiles([png(""), png("b.png")], 0, preview);
    expect(result.error).toBeNull();
    expect(result.images.map((image) => image.name)).toEqual(["image", "b.png"]);
    expect(result.images[0]?.previewUrl).toBe("blob:");
  });

  it("skips other files and says so", () => {
    const pdf = new File(["x"], "a.pdf", { type: "application/pdf" });
    const result = homeImagesFromFiles([pdf, png()], 0, preview);
    expect(result.images).toHaveLength(1);
    expect(result.error).toContain("a.pdf");
  });

  it("stops at the per-message limit", () => {
    const result = homeImagesFromFiles(
      [png("a.png"), png("b.png")],
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
      preview,
    );
    expect(result.images).toHaveLength(1);
    expect(result.error).toContain(String(PROVIDER_SEND_TURN_MAX_ATTACHMENTS));
  });
});
