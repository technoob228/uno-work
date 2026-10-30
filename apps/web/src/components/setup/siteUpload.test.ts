import { describe, expect, it, vi } from "vitest";

import { ZIP_UNPACK_MAX_BYTES, expandZips } from "./siteUpload";

vi.mock("../../environmentApi", () => ({ ensureEnvironmentApi: vi.fn() }));

describe("expandZips", () => {
  it("leaves a zip too big for a tab's memory as a file, unread", async () => {
    const arrayBuffer = vi.fn();
    const big = {
      relativePath: "backup.zip",
      size: ZIP_UNPACK_MAX_BYTES + 1,
      blob: { size: ZIP_UNPACK_MAX_BYTES + 1, arrayBuffer } as unknown as Blob,
    };
    await expect(expandZips([big])).resolves.toEqual([big]);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
