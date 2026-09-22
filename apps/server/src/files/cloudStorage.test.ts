import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ControlPlaneHttpError } from "../workspaceRegistry/unoCloudParse.ts";
import {
  cloudList,
  cloudState,
  copyToCloud,
  copyToComputer,
  normalizeCloudPrefix,
  type CloudDeps,
} from "./cloudStorage.ts";

/** A fake console + S3: buckets, a key/value object store, presigned URLs. */
function fakeCloud(options: { listing?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const bucket = { id: 7, name: "docs", used_bytes: 1234 };
  const fetchJson = async (token: string, path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (token !== "machine-token") throw new ControlPlaneHttpError(401, "401: nope");
    if (path === "/api/v1/buckets") {
      return {
        buckets: [bucket],
        storage: { used_bytes: 5_000, quota_bytes: 10_000, over_quota: false },
      };
    }
    const objectsMatch = /^\/api\/v1\/buckets\/7\/objects\?prefix=(.*)$/.exec(path);
    if (objectsMatch) {
      if (options.listing === false) throw new ControlPlaneHttpError(404, "404: not found");
      const prefix = decodeURIComponent(objectsMatch[1]!);
      const folders = new Set<string>();
      const files = [];
      for (const [key, bytes] of objects) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash >= 0) folders.add(prefix + rest.slice(0, slash + 1));
        else files.push({ key, size: bytes.length, last_modified: "2026-09-22T12:00:00Z" });
      }
      return { prefix, objects: files, folders: [...folders], truncated: false };
    }
    if (path === "/api/v1/buckets/7/presign") {
      const body = JSON.parse(String(init?.body)) as { key: string; method: string };
      return { url: `https://s3.test/${body.method}/${encodeURIComponent(body.key)}` };
    }
    throw new ControlPlaneHttpError(404, "404");
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const match = /^https:\/\/s3\.test\/(get|put)\/(.+)$/.exec(url);
    if (!match) return new Response("bad", { status: 400 });
    const key = decodeURIComponent(match[2]!);
    if (match[1] === "put") {
      objects.set(key, new Uint8Array(await new Response(init?.body as ConstructorParameters<typeof Response>[0]).arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    const bytes = objects.get(key);
    return bytes ? new Response(bytes) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  const deps: CloudDeps = { token: "machine-token", fetchJson, fetchImpl };
  return { deps, objects, calls };
}

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
