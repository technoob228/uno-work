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
import { CLOUD_KEEP_VERSIONS, cloudVersionsPrefix } from "./cloudVersions.ts";
import { NotEnoughSpaceError } from "./diskSpace.ts";

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
    expect(result.paths).toEqual([nodePath.join(target, "Report (2)")]);
    expect(fs.readFileSync(nodePath.join(target, "Report (2)", "img", "a.png"), "utf8")).toBe(
      "png",
    );
    const single = await copyToComputer(deps, {
      bucketId: 7,
      keys: ["Report/index.html"],
      destinationDir: target,
    });
    expect(single.files).toBe(1);
    expect(single.paths).toEqual([nodePath.join(target, "index.html")]);
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

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const versionsOf = (objects: Map<string, Uint8Array>, key: string) =>
  [...objects.keys()].filter((k) => k.startsWith(cloudVersionsPrefix(key))).toSorted();
/** A clock that ticks one second per call. */
const clock = () => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 9, 16, 9, 0, tick++));
};

describe("saving over a cloud file", () => {
  it("keeps the replaced file as an older copy that Files doesn't show", async () => {
    const { deps, objects } = fakeCloud();
    const notes = nodePath.join(home, "notes.md");
    const now = clock();
    const first = await copyToCloud(deps, { paths: [notes], bucketId: 7, prefix: "work", now });
    expect(first.overwritten).toEqual([]);
    fs.writeFileSync(notes, "# notes v2");
    const second = await copyToCloud(deps, { paths: [notes], bucketId: 7, prefix: "work", now });
    expect(second.overwritten).toEqual([{ key: "work/notes.md", versionKept: true }]);
    expect(text(objects.get("work/notes.md"))).toBe("# notes v2");
    const versions = versionsOf(objects, "work/notes.md");
    expect(versions).toEqual(["work/.versions/notes.md/2026-10-16T09-00-00-000Z.md"]);
    expect(text(objects.get(versions[0]!))).toBe("# notes");
    const listing = await cloudList(deps, { bucketId: 7, prefix: "work/" });
    expect(listing.folders).toEqual([]);
    expect(listing.objects.map((object) => object.name)).toEqual(["notes.md"]);
  });

  it(`keeps the newest ${CLOUD_KEEP_VERSIONS} copies`, async () => {
    const { deps, objects } = fakeCloud();
    const notes = nodePath.join(home, "notes.md");
    const now = clock();
    for (let n = 0; n <= CLOUD_KEEP_VERSIONS + 2; n += 1) {
      fs.writeFileSync(notes, `v${n}`);
      await copyToCloud(deps, { paths: [notes], bucketId: 7, now });
    }
    const versions = versionsOf(objects, "notes.md");
    expect(versions).toHaveLength(CLOUD_KEEP_VERSIONS);
    expect(text(objects.get(versions[0]!))).toBe("v2");
    expect(text(objects.get(versions.at(-1)!))).toBe(`v${CLOUD_KEEP_VERSIONS + 1}`);
  });

  it("lists a fresh folder's destination once", async () => {
    const { deps, calls } = fakeCloud();
    await copyToCloud(deps, {
      paths: [nodePath.join(home, "Report"), nodePath.join(home, "notes.md")],
      bucketId: 7,
      prefix: "work",
    });
    expect(calls.filter((call) => call.includes("/objects?prefix="))).toEqual([
      "GET /api/v1/buckets/7/objects?prefix=",
    ]);
  });

  it("doesn't replace a file whose old copy couldn't be kept", async () => {
    const cloud = fakeCloud();
    const notes = nodePath.join(home, "notes.md");
    await copyToCloud(cloud.deps, { paths: [notes], bucketId: 7 });
    fs.writeFileSync(notes, "# notes v2");
    const fetchImpl = (async (url: string, init?: RequestInit) =>
      url.includes("/put/") && decodeURIComponent(url).includes("/.versions/")
        ? new Response("no", { status: 500 })
        : cloud.deps.fetchImpl!(url, init)) as typeof fetch;
    await expect(
      copyToCloud({ ...cloud.deps, fetchImpl }, { paths: [notes], bucketId: 7 }),
    ).rejects.toThrow(/previous version of “notes.md”.*Nothing was replaced/);
    expect(text(cloud.objects.get("notes.md"))).toBe("# notes");
  });
});

describe("copying from the cloud onto the computer", () => {
  it("refuses before the first byte when the disk would be almost full", async () => {
    const { deps } = fakeCloud();
    await copyToCloud(deps, { paths: [nodePath.join(home, "Report")], bucketId: 7 });
    const target = nodePath.join(home, "Downloads");
    fs.mkdirSync(target);
    const measured: Array<string> = [];
    const refusal = await copyToComputer(deps, {
      bucketId: 7,
      keys: ["Report/", "Report/index.html"],
      destinationDir: target,
      measureDisk: async (path) => {
        measured.push(path);
        return { freeBytes: 1024 ** 3 + 20, totalBytes: 10 * 1024 ** 3 };
      },
    }).catch((error) => error);
    expect(refusal).toBeInstanceOf(NotEnoughSpaceError);
    // The folder (index.html + a.png) and the file again: 11 + 3 + 11 bytes.
    expect(refusal.needBytes).toBe(25);
    expect(measured).toEqual([target]);
    expect(fs.readdirSync(target)).toEqual([]);
  });
});
