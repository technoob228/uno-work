import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ControlPlaneHttpError } from "../workspaceRegistry/unoCloudParse.ts";
import { fakeCloud } from "./cloudStorage.testkit.ts";
import {
  cloudDelete,
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

  it("replaces the file anyway when its old copy can't be kept, and says why", async () => {
    const cloud = fakeCloud();
    const notes = nodePath.join(home, "notes.md");
    await copyToCloud(cloud.deps, { paths: [notes], bucketId: 7 });
    fs.writeFileSync(notes, "# notes v2");
    const fetchImpl = (async (url: string, init?: RequestInit) =>
      url.includes("/put/") && decodeURIComponent(url).includes("/.versions/")
        ? new Response("full", { status: 402 })
        : cloud.deps.fetchImpl!(url, init)) as typeof fetch;
    const result = await copyToCloud({ ...cloud.deps, fetchImpl }, { paths: [notes], bucketId: 7 });
    expect(result.overwritten).toEqual([
      {
        key: "notes.md",
        versionKept: false,
        reason: "no room in cloud storage for the older copy",
      },
    ]);
    expect(text(cloud.objects.get("notes.md"))).toBe("# notes v2");
    expect(versionsOf(cloud.objects, "notes.md")).toEqual([]);
  });

  it("keeps no copy when the same bytes are saved again", async () => {
    const { deps, objects, gets } = fakeCloud();
    const notes = nodePath.join(home, "notes.md");
    await copyToCloud(deps, { paths: [notes], bucketId: 7 });
    const again = await copyToCloud(deps, { paths: [notes], bucketId: 7 });
    expect(again.files).toBe(1);
    expect(again.overwritten).toEqual([
      { key: "notes.md", versionKept: false, reason: "unchanged" },
    ]);
    expect(versionsOf(objects, "notes.md")).toEqual([]);
    expect(gets.at(-1)!.get("accept-encoding")).toBe("identity");
  });

  it("keeps a copy when the ETag can't vouch for the content (multipart)", async () => {
    const cloud = fakeCloud();
    const notes = nodePath.join(home, "notes.md");
    await copyToCloud(cloud.deps, { paths: [notes], bucketId: 7 });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const response = await cloud.deps.fetchImpl!(url, init);
      if (!url.includes("/get/")) return response;
      const headers = new Headers(response.headers);
      headers.set("etag", '"0123456789abcdef0123456789abcdef-2"');
      return new Response(response.body, { status: response.status, headers });
    }) as typeof fetch;
    const again = await copyToCloud({ ...cloud.deps, fetchImpl }, { paths: [notes], bucketId: 7 });
    expect(again.overwritten).toEqual([{ key: "notes.md", versionKept: true }]);
  });

  it("deletes a file's older copies with it; a folder takes its own", async () => {
    const { deps, objects } = fakeCloud();
    const notes = nodePath.join(home, "notes.md");
    const now = clock();
    await copyToCloud(deps, { paths: [notes], bucketId: 7, prefix: "a", now });
    fs.writeFileSync(notes, "v2");
    await copyToCloud(deps, { paths: [notes], bucketId: 7, prefix: "a", now });
    await copyToCloud(deps, { paths: [notes], bucketId: 7, prefix: "b", now });
    fs.writeFileSync(notes, "v3");
    await copyToCloud(deps, { paths: [notes], bucketId: 7, prefix: "b", now });
    expect(versionsOf(objects, "a/notes.md")).toHaveLength(1);
    expect(await cloudDelete(deps, 7, "a/notes.md")).toBe(1);
    expect([...objects.keys()].filter((key) => key.startsWith("a/"))).toEqual([]);
    expect(await cloudDelete(deps, 7, "b/")).toBe(2);
    expect([...objects.keys()]).toEqual([]);
  });
});

describe("copying from the cloud onto the computer", () => {
  it("refuses before the first byte when it wouldn't fit", async () => {
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
        return { freeBytes: 20, totalBytes: 10 * 1024 ** 3 };
      },
    }).catch((error) => error);
    expect(refusal).toBeInstanceOf(NotEnoughSpaceError);
    // The folder (index.html + a.png) and the file again: 11 + 3 + 11 bytes.
    expect(refusal.needBytes).toBe(25);
    expect(measured).toEqual([target]);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it("copies anyway when a file's size can't be told", async () => {
    const cloud = fakeCloud();
    await copyToCloud(cloud.deps, { paths: [nodePath.join(home, "notes.md")], bucketId: 7 });
    const fetchJson: typeof cloud.deps.fetchJson = async (token, path, init) => {
      if (path.includes("/objects?prefix=")) throw new ControlPlaneHttpError(500, "500: down");
      return cloud.deps.fetchJson!(token, path, init);
    };
    const target = nodePath.join(home, "Downloads");
    fs.mkdirSync(target);
    const result = await copyToComputer(
      { ...cloud.deps, fetchJson },
      { bucketId: 7, keys: ["notes.md"], destinationDir: target },
    );
    expect(result.files).toBe(1);
  });
});
