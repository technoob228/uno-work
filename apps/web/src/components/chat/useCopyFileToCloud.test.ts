import { describe, expect, it } from "vitest";

import { chatFileEntry } from "./useCopyFileToCloud";

describe("chatFileEntry", () => {
  it("names a chip's file by its path", () => {
    const entry = chatFileEntry({ path: "/home/uno/report.pdf", kind: "file" });
    expect(entry.name).toBe("report.pdf");
    expect(entry.path).toBe("/home/uno/report.pdf");
  });

  it("keeps a folder's last part, trailing slash or not", () => {
    expect(chatFileEntry({ path: "/home/uno/site/", kind: "directory" }).name).toBe("site");
  });

  it("keeps the name of an attachment", () => {
    const entry = chatFileEntry({
      path: "/home/uno/Uploads/2026-10/a1b2.csv",
      kind: "file",
      name: "sales.csv",
      sizeBytes: 12,
    });
    expect(entry.name).toBe("sales.csv");
    expect(entry.size).toBe(12);
  });
});
