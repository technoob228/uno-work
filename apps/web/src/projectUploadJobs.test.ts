import { describe, expect, it, vi } from "vitest";

import { uploadErrorText } from "./projectUploadJobs";

vi.mock("./environmentApi", () => ({ ensureEnvironmentApi: vi.fn() }));

describe("uploadErrorText", () => {
  it("passes on what the computer says about its disk, with the sizes", () => {
    const refusal = new Error(
      "Not enough space on this computer: needs 12 GB, 3.0 GB free. Free up space or pick fewer files.",
    );
    expect(uploadErrorText(refusal)).toBe(`${refusal.message} Then Resume.`);
  });

  it("still names a lost connection", () => {
    expect(uploadErrorText(new Error("WebSocket closed"))).toMatch(/^Lost the connection/);
  });
});
