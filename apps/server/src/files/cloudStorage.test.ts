import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeCloud } from "./cloudStorage.testkit.ts";
import {
  cloudList,
  cloudState,
  copyToCloud,
  copyToComputer,
  normalizeCloudPrefix,
} from "./cloudStorage.ts";

let home: string;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-cloud-")));
  fs.mkdirSync(nodePath.join(home, "Report", "img"), { recursive: true });
  fs.writeFileSync(nodePath.join(home, "Report", "index.html"), "<h1>hi</h1>");
  fs.writeFileSync(nodePath.join(home, "Report", "img", "a.png"), "png");
  fs.writeFileSync(nodePath.join(home, "Report", ".env"), "SECRET=1");
  fs.writeFileSync(nodePath.join(home, "notes.md"), "# notes");
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("cloud storage", () => {
  it("reports usage and buckets", async () => {
    const { deps } = fakeCloud();
    const state = await cloudState(deps);
    expect(state).toMatchObject({
      available: true,
      usedBytes: 5000,
      quotaBytes: 10_000,
      overQuota: false,
    });
    expect(state.buckets).toEqual([{ id: 7, name: "docs", usedBytes: 1234 }]);
  });

  it("turns console errors into sentences", async () => {
    const { deps } = fakeCloud();
    await expect(cloudState({ ...deps, token: "wrong" })).rejects.toThrow(
      /Reconnect it in Settings/,
    );
  });

  it("uploads files and folders, never dotfiles, and lists them back by folder", async () => {
    const { deps, objects } = fakeCloud();
    const result = await copyToCloud(deps, {
      paths: [nodePath.join(home, "Report"), nodePath.join(home, "notes.md")],
      bucketId: 7,
      prefix: "work",
    });
    expect(result.files).toBe(3);
    expect([...objects.keys()].toSorted()).toEqual([
      "work/Report/img/a.png",
      "work/Report/index.html",
      "work/notes.md",
    ]);
    const root = await cloudList(deps, { bucketId: 7, prefix: "work/" });
    expect(root.folders).toEqual([{ prefix: "work/Report/", name: "Report" }]);
    expect(root.objects.map((object) => object.name)).toEqual(["notes.md"]);
    expect(root.listingSupported).toBe(true);
  });

  it("downloads a whole folder next to what's already there", async () => {
    const { deps } = fakeCloud();
    await copyToCloud(deps, { paths: [nodePath.join(home, "Report")], bucketId: 7 });
    const target = nodePath.join(home, "Downloads");
    fs.mkdirSync(target);
    fs.mkdirSync(nodePath.join(target, "Report"));
    const result = await copyToComputer(deps, {
      bucketId: 7,
      keys: ["Report/"],
      destinationDir: target,
    });
    expect(result.files).toBe(2);
    expect(fs.readFileSync(nodePath.join(target, "Report (2)", "img", "a.png"), "utf8")).toBe(
      "png",
    );
    const single = await copyToComputer(deps, {
      bucketId: 7,
      keys: ["Report/index.html"],
      destinationDir: target,
    });
    expect(single.files).toBe(1);
    expect(fs.readFileSync(nodePath.join(target, "index.html"), "utf8")).toBe("<h1>hi</h1>");
  });

  it("works on a console that can't list objects yet", async () => {
    const { deps } = fakeCloud({ listing: false });
    const listing = await cloudList(deps, { bucketId: 7 });
    expect(listing.listingSupported).toBe(false);
    expect(listing.bucket.name).toBe("docs");
  });

  it("refuses folder names that walk out", () => {
    expect(normalizeCloudPrefix("")).toBe("");
    expect(normalizeCloudPrefix("a/b")).toBe("a/b/");
    for (const bad of ["../x", "a/../b", "a//b", "./a"]) {
      expect(() => normalizeCloudPrefix(bad), bad).toThrow();
    }
  });
});
