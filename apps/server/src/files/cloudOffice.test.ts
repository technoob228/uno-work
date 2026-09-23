/**
 * Office documents in Cloud storage: open → stage → save back with a
 * version check, older copies kept (and capped), conflicts never overwrite.
 */
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLOUD_OFFICE_KEEP_VERSIONS,
  CLOUD_OFFICE_STAGING_DIR,
  cloudVersionsPrefix,
  openCloudOffice,
  saveCloudOffice,
  sweepCloudOfficeStaging,
} from "./cloudOffice.ts";
import { fakeCloud } from "./cloudStorage.testkit.ts";
import { contentVersion } from "./shareOffice.ts";

const doc = (label: string) => new Uint8Array(Buffer.from(`PK\u0003\u0004 ${label}`));
const KEY = "Work/plan.docx";

let home: string;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-cloud-office-")));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const versionsOf = (objects: Map<string, Uint8Array>) =>
  [...objects.keys()].filter((key) => key.startsWith(cloudVersionsPrefix(KEY))).toSorted();

describe("Cloud documents in Office", () => {
  it("opens into the hidden staging folder with the content version", async () => {
    const { deps, objects } = fakeCloud();
    objects.set(KEY, doc("v1"));
    const opened = await openCloudOffice(deps, { bucketId: 7, key: KEY, homeDir: home });
    expect(opened.name).toBe("plan.docx");
    expect(opened.writable).toBe(true);
    expect(opened.version).toBe(contentVersion(doc("v1")));
    expect(opened.stagedPath.startsWith(nodePath.join(home, CLOUD_OFFICE_STAGING_DIR))).toBe(true);
    expect(new Uint8Array(fs.readFileSync(opened.stagedPath))).toEqual(doc("v1"));

    await expect(
      openCloudOffice(deps, { bucketId: 7, key: "Work/missing.docx", homeDir: home }),
    ).rejects.toThrow("isn't in Cloud storage");
    await expect(
      openCloudOffice(deps, { bucketId: 7, key: "Work/notes.txt", homeDir: home }),
    ).rejects.toThrow("Office can't open");
  });

  it("saves back, keeping the previous content as an older copy", async () => {
    const { deps, objects } = fakeCloud();
    objects.set(KEY, doc("v1"));
    const base = contentVersion(doc("v1"));
    const saved = await saveCloudOffice(deps, {
      bucketId: 7,
      key: KEY,
      bytes: doc("v2"),
      baseVersion: base,
      force: false,
      now: new Date("2026-09-24T10:00:00Z"),
    });
    expect(saved).toEqual({ kind: "saved", version: contentVersion(doc("v2")) });
    expect(objects.get(KEY)).toEqual(doc("v2"));
    expect(versionsOf(objects)).toEqual(["Work/.versions/plan.docx/2026-09-24T10-00-00-000Z.docx"]);
    expect(objects.get(versionsOf(objects)[0]!)).toEqual(doc("v1"));
  });

  it("someone saved in between: a conflict, nothing overwritten — unless replaced on purpose", async () => {
    const { deps, objects } = fakeCloud();
    objects.set(KEY, doc("theirs"));
    const opened = contentVersion(doc("v1"));
    const conflict = await saveCloudOffice(deps, {
      bucketId: 7,
      key: KEY,
      bytes: doc("mine"),
      baseVersion: opened,
      force: false,
    });
    expect(conflict).toEqual({ kind: "conflict", currentVersion: contentVersion(doc("theirs")) });
    expect(objects.get(KEY)).toEqual(doc("theirs"));
    expect(versionsOf(objects)).toEqual([]);

    const forced = await saveCloudOffice(deps, {
      bucketId: 7,
      key: KEY,
      bytes: doc("mine"),
      baseVersion: opened,
      force: true,
    });
    expect(forced.kind).toBe("saved");
    expect(objects.get(KEY)).toEqual(doc("mine"));
    // Their version isn't lost: it's the older copy.
    expect(objects.get(versionsOf(objects)[0]!)).toEqual(doc("theirs"));

    // Deleted from the cloud meanwhile: also a conflict.
    objects.delete(KEY);
    const gone = await saveCloudOffice(deps, {
      bucketId: 7,
      key: KEY,
      bytes: doc("again"),
      baseVersion: contentVersion(doc("mine")),
      force: false,
    });
    expect(gone).toEqual({ kind: "conflict", currentVersion: null });
  });

  it(`keeps at most ${CLOUD_OFFICE_KEEP_VERSIONS} older copies`, async () => {
    const { deps, objects } = fakeCloud();
    objects.set(KEY, doc("0"));
    for (let n = 1; n <= CLOUD_OFFICE_KEEP_VERSIONS + 3; n += 1) {
      const result = await saveCloudOffice(deps, {
        bucketId: 7,
        key: KEY,
        bytes: doc(String(n)),
        baseVersion: contentVersion(doc(String(n - 1))),
        force: false,
        now: new Date(Date.UTC(2026, 8, 24, 10, n)),
      });
      expect(result.kind).toBe("saved");
    }
    const kept = versionsOf(objects);
    expect(kept).toHaveLength(CLOUD_OFFICE_KEEP_VERSIONS);
    // The newest older copy is the one before the last save.
    expect(objects.get(kept.at(-1)!)).toEqual(doc(String(CLOUD_OFFICE_KEEP_VERSIONS + 2)));
  });

  it("refuses junk, older copies and formats it can't write back", async () => {
    const { deps, objects } = fakeCloud();
    objects.set(KEY, doc("v1"));
    const base = contentVersion(doc("v1"));
    const save = (key: string, bytes: Uint8Array) =>
      saveCloudOffice(deps, { bucketId: 7, key, bytes, baseVersion: base, force: false });
    await expect(save(KEY, new Uint8Array(Buffer.from("not a zip")))).rejects.toThrow(
      "isn't a document",
    );
    await expect(save("Work/old.doc", doc("x"))).rejects.toThrow("can't be saved back");
    await expect(
      save(`${cloudVersionsPrefix(KEY)}2026-09-24T10-00-00-000Z.docx`, doc("x")),
    ).rejects.toThrow("older copy");
    expect(objects.get(KEY)).toEqual(doc("v1"));
  });

  it("sweeps staging left over by closed tabs", async () => {
    const stale = nodePath.join(home, CLOUD_OFFICE_STAGING_DIR, "old");
    const fresh = nodePath.join(home, CLOUD_OFFICE_STAGING_DIR, "new");
    fs.mkdirSync(stale, { recursive: true });
    fs.mkdirSync(fresh, { recursive: true });
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, past, past);
    await sweepCloudOfficeStaging(home);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
