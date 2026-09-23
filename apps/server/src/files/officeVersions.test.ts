import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cloudList } from "./cloudStorage.ts";
import { fakeCloud } from "./cloudStorage.testkit.ts";
import {
  listCloudOfficeVersions,
  listShareOfficeVersions,
  resolveShareOfficeVersion,
  versionStampToIso,
} from "./officeVersions.ts";

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-office-versions-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("Office versions", () => {
  it("reads the time back from a stamped name", () => {
    expect(versionStampToIso("2026-09-24T10-05-07-123Z.docx")).toBe("2026-09-24T10:05:07.123Z");
    expect(versionStampToIso("2026-09-24T10-05-07-123Z--plan.docx")).toBe(
      "2026-09-24T10:05:07.123Z",
    );
    expect(versionStampToIso("plan.docx")).toBeNull();
  });

  it("Cloud: lists the .versions copies newest first, and Files doesn't show the folder", async () => {
    const { deps, objects } = fakeCloud();
    objects.set("Work/plan.docx", new Uint8Array(3));
    objects.set("Work/.versions/plan.docx/2026-09-24T10-00-00-000Z.docx", new Uint8Array(1));
    objects.set("Work/.versions/plan.docx/2026-09-24T11-00-00-000Z.docx", new Uint8Array(2));
    objects.set("Work/.versions/other.docx/2026-09-24T12-00-00-000Z.docx", new Uint8Array(9));
    const versions = await listCloudOfficeVersions(deps, { bucketId: 7, key: "Work/plan.docx" });
    expect(versions).toEqual([
      {
        id: "Work/.versions/plan.docx/2026-09-24T11-00-00-000Z.docx",
        createdAt: "2026-09-24T11:00:00.000Z",
        size: 2,
      },
      {
        id: "Work/.versions/plan.docx/2026-09-24T10-00-00-000Z.docx",
        createdAt: "2026-09-24T10:00:00.000Z",
        size: 1,
      },
    ]);
    const listing = await cloudList(deps, { bucketId: 7, prefix: "Work/" });
    expect(listing.folders).toEqual([]);
    expect(listing.objects.map((object) => object.name)).toEqual(["plan.docx"]);
  });

  it("computer: only the copies of this file's own links, never a path outside them", async () => {
    fs.mkdirSync(nodePath.join(dir, "share-a"));
    fs.mkdirSync(nodePath.join(dir, "share-b"));
    fs.mkdirSync(nodePath.join(dir, "share-other"));
    fs.writeFileSync(nodePath.join(dir, "share-a", "2026-09-24T10-00-00-000Z--plan.docx"), "a");
    fs.writeFileSync(nodePath.join(dir, "share-b", "2026-09-24T12-00-00-000Z--plan.docx"), "bb");
    fs.writeFileSync(nodePath.join(dir, "share-b", "notes.txt"), "not ours");
    fs.writeFileSync(nodePath.join(dir, "share-other", "2026-09-24T13-00-00-000Z--x.docx"), "x");
    const shareIds = ["share-a", "share-b", "share-missing"];
    const versions = await listShareOfficeVersions({ versionsDir: dir, shareIds });
    expect(versions.map((version) => [version.id, version.size])).toEqual([
      ["share-b/2026-09-24T12-00-00-000Z--plan.docx", 2],
      ["share-a/2026-09-24T10-00-00-000Z--plan.docx", 1],
    ]);
    expect(resolveShareOfficeVersion({ versionsDir: dir, shareIds, id: versions[0]!.id })).toBe(
      nodePath.join(dir, "share-b", "2026-09-24T12-00-00-000Z--plan.docx"),
    );
    for (const id of [
      "share-other/2026-09-24T13-00-00-000Z--x.docx",
      "share-a/../share-other/2026-09-24T13-00-00-000Z--x.docx",
      "share-a/notes.txt",
      "share-a",
      "/etc/passwd",
    ]) {
      expect(resolveShareOfficeVersion({ versionsDir: dir, shareIds, id }), id).toBeNull();
    }
  });
});
