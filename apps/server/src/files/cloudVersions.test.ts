import { describe, expect, it } from "vitest";

import {
  CLOUD_KEEP_VERSIONS,
  CLOUD_VERSION_MAX_BYTES,
  CLOUD_VERSIONS_PER_TRANSFER,
  cloudVersionKey,
  cloudVersionSkipReason,
  cloudVersionsPrefix,
  isCloudVersionKey,
  staleCloudVersions,
} from "./cloudVersions.ts";
import { versionStampToIso } from "./officeVersions.ts";

const NOW = new Date("2026-10-16T09:08:07.006Z");

describe("cloud versions naming", () => {
  it("puts older copies in .versions/<name>/ next to the file", () => {
    expect(cloudVersionsPrefix("Reports/q3.pdf")).toBe("Reports/.versions/q3.pdf/");
    expect(cloudVersionsPrefix("notes.md")).toBe(".versions/notes.md/");
  });

  it("names a copy by when it was replaced, keeping the extension", () => {
    expect(cloudVersionKey("Reports/q3.pdf", NOW)).toBe(
      "Reports/.versions/q3.pdf/2026-10-16T09-08-07-006Z.pdf",
    );
    expect(cloudVersionKey("a/archive.tar.gz", NOW)).toBe(
      "a/.versions/archive.tar.gz/2026-10-16T09-08-07-006Z.gz",
    );
    expect(cloudVersionKey("Makefile", NOW)).toBe(".versions/Makefile/2026-10-16T09-08-07-006Z");
    expect(cloudVersionKey(".env", NOW)).toBe(".versions/.env/2026-10-16T09-08-07-006Z");
    // Office passes its own extension (same scheme it always wrote).
    expect(cloudVersionKey("Docs/plan.DOCX", NOW, "docx")).toBe(
      "Docs/.versions/plan.DOCX/2026-10-16T09-08-07-006Z.docx",
    );
  });

  it("is readable back as a time by Office → Versions", () => {
    const name = cloudVersionKey("x.txt", NOW).split("/").at(-1)!;
    expect(versionStampToIso(name)).toBe(NOW.toISOString());
  });

  it("tells older copies apart", () => {
    expect(isCloudVersionKey("a/.versions/b.txt/2026.txt")).toBe(true);
    expect(isCloudVersionKey("a/versions/b.txt")).toBe(false);
    expect(isCloudVersionKey("a/.versionsx/b.txt")).toBe(false);
  });
});

describe("cloud versions pruning", () => {
  const keys = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      cloudVersionKey("d/f.txt", new Date(Date.UTC(2026, 0, 1, 0, 0, i))),
    );

  it(`keeps the newest ${CLOUD_KEEP_VERSIONS}`, () => {
    const all = keys(CLOUD_KEEP_VERSIONS + 3);
    const stale = staleCloudVersions(all.toReversed());
    expect(stale).toEqual(all.slice(0, 3));
    expect(staleCloudVersions(keys(CLOUD_KEEP_VERSIONS))).toEqual([]);
    expect(staleCloudVersions(keys(3), 1)).toEqual(keys(3).slice(0, 2));
  });
});

describe("which replaced files are kept", () => {
  it("keeps ordinary files", () => {
    expect(cloudVersionSkipReason("a.txt", 10, 0)).toBeNull();
    expect(cloudVersionSkipReason("a.txt", CLOUD_VERSION_MAX_BYTES, 0)).toBeNull();
  });

  it("skips huge files, older copies and the tail of a bulk copy", () => {
    expect(cloudVersionSkipReason("a.mp4", CLOUD_VERSION_MAX_BYTES + 1, 0)).toMatch(/200 MB/);
    expect(cloudVersionSkipReason("a/.versions/b/x.txt", 1, 0)).toMatch(/older copy/);
    expect(cloudVersionSkipReason("a.txt", 1, CLOUD_VERSIONS_PER_TRANSFER)).toMatch(/first 50/);
  });
});
