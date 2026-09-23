import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ControlPlaneHttpError } from "../workspaceRegistry/unoCloudParse.ts";
import type { AppApiCaller, AppApiCore } from "./appApiHttp.ts";
import { makeAppApiHandler } from "./appApiHttp.ts";
import {
  APP_STORAGE_BUCKET,
  AppStorageError,
  appFolder,
  appStorageComputerKey,
  makeAppStorage,
  validateStorageKey,
  validateStoragePrefix,
} from "./appStorage.ts";

// The SDK the daemon installs on every machine (a plain .mjs, no types here),
// exercised against the real handler.
const SDK_PATH = "../../../../packages/app-sdk/src/uno-app.mjs";
const { UnoAppError, createClient } = (await import(new URL(SDK_PATH, import.meta.url).href)) as {
  UnoAppError: new (...args: never[]) => Error;
  createClient: (options: { url: string; token: string }) => any;
};

// ── fake S3: objects by full key; presigned URLs are http://s3/<key>?sig=<method>
const objects = new Map<string, { body: Buffer; type: string }>();
let s3: http.Server;
let s3Url = "";

// ── fake console (the machine's token): buckets, presign, list, delete
const buckets: Array<{ id: number; name: string }> = [];
const consoleCalls: Array<{ path: string; method: string; token: string }> = [];
let consoleQuotaFull = false;

async function fakeConsole(token: string, path: string, init?: RequestInit): Promise<unknown> {
  const method = init?.method ?? "GET";
  consoleCalls.push({ path, method, token });
  if (token !== "uno_machine") throw new ControlPlaneHttpError(401, "401");
  const url = new URL(path, "http://console");
  if (url.pathname === "/api/v1/buckets" && method === "GET") {
    return {
      buckets: buckets.map((b) => ({ ...b, used_bytes: 0 })),
      storage: { used_bytes: 0, quota_bytes: 10 * 2 ** 30 },
    };
  }
  if (url.pathname === "/api/v1/buckets" && method === "POST") {
    const { name } = JSON.parse(String(init?.body)) as { name: string };
    const bucket = { id: 40 + buckets.length, name };
    buckets.push(bucket);
    return { ...bucket, used_bytes: 0 };
  }
  const match = /^\/api\/v1\/buckets\/(\d+)\/(presign|objects)$/.exec(url.pathname);
  if (!match || !buckets.some((b) => b.id === Number(match[1]))) {
    throw new ControlPlaneHttpError(404, "404");
  }
  if (match[2] === "presign") {
    const { key, method: m } = JSON.parse(String(init?.body)) as { key: string; method: string };
    if (m === "put" && consoleQuotaFull) throw new ControlPlaneHttpError(402, "402");
    return { url: `${s3Url}/${encodeURIComponent(key)}?sig=${m}` };
  }
  if (method === "DELETE") {
    const key = url.searchParams.get("key") ?? "";
    let deleted = 0;
    for (const full of objects.keys()) {
      if (key.endsWith("/") ? full.startsWith(key) : full === key) {
        objects.delete(full);
        deleted += 1;
      }
    }
    return { deleted };
  }
  // One folder level under prefix (keys relative to the bucket, like the console).
  const prefix = url.searchParams.get("prefix") ?? "";
  const folders = new Set<string>();
  const files: Array<{ key: string; size: number; last_modified: string }> = [];
  for (const [full, object] of objects) {
    if (!full.startsWith(prefix)) continue;
    const rest = full.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) folders.add(prefix + rest.slice(0, slash + 1));
    else files.push({ key: full, size: object.body.length, last_modified: "2026-09-23T00:00:00Z" });
  }
  return { prefix, folders: [...folders], objects: files, truncated: false };
}

// ── the App API with two apps: one with storage, one without
const CALLERS: Record<string, AppApiCaller> = {
  uno_app_album: {
    appId: "album",
    appName: "Album",
    chat: false,
    tasks: false,
    limitUsd: 0,
    spentUsd: 0,
    manifestCwd: null,
    taskToolsCap: "edit",
    storage: { limitBytes: 1000, folder: "album/" },
  },
  // The same app on a computer where the person chose "Only this computer".
  uno_app_album_here: {
    appId: "album",
    appName: "Album",
    chat: false,
    tasks: false,
    limitUsd: 0,
    spentUsd: 0,
    manifestCwd: null,
    taskToolsCap: "edit",
    storage: { limitBytes: 1000, folder: "album@computer-7/" },
  },
  uno_app_other: {
    appId: "other",
    appName: "Other",
    chat: true,
    tasks: false,
    limitUsd: 10,
    spentUsd: 0,
    manifestCwd: null,
    taskToolsCap: "edit",
    storage: { limitBytes: 1000, folder: "other/" },
  },
  uno_app_nostorage: {
    appId: "nostorage",
    appName: "No storage",
    chat: true,
    tasks: false,
    limitUsd: 10,
    spentUsd: 0,
    manifestCwd: null,
    taskToolsCap: "edit",
    storage: null,
  },
};

let machineToken = "uno_machine";
const storage = makeAppStorage({ token: async () => machineToken, fetchJson: fakeConsole });
const core = {
  home: "/home/unowork",
  authenticate: async (token: string) => CALLERS[token] ?? null,
  gateway: async () => null,
  defaults: async () => ({ chatModel: "m", taskHarness: null }),
  prices: async () => new Map(),
  charge: async () => undefined,
  storage,
} as unknown as AppApiCore;

let api: http.Server;
let apiUrl = "";
const album = () => createClient({ url: apiUrl, token: "uno_app_album" });

beforeAll(async () => {
  s3 = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://s3");
    const key = decodeURIComponent(u.pathname.slice(1));
    const sig = u.searchParams.get("sig");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "PUT" && sig === "put") {
        objects.set(key, {
          body: Buffer.concat(chunks),
          type: req.headers["content-type"] ?? "binary/octet-stream",
        });
        res.writeHead(200).end();
        return;
      }
      if (req.method === "GET" && sig === "get") {
        const object = objects.get(key);
        if (!object) return void res.writeHead(404).end("NoSuchKey");
        const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers["range"] ?? ""));
        if (range) {
          const part = object.body.subarray(Number(range[1]), Number(range[2]) + 1);
          res.writeHead(206, {
            "content-type": object.type,
            "content-length": String(part.length),
            "content-range": `bytes ${range[1]}-${range[2]}/${object.body.length}`,
          });
          return void res.end(part);
        }
        res.writeHead(200, {
          "content-type": object.type,
          "content-length": String(object.body.length),
        });
        return void res.end(object.body);
      }
      res.writeHead(403).end("SignatureDoesNotMatch");
    });
  });
  await new Promise<void>((resolve) => s3.listen(0, "127.0.0.1", resolve));
  s3Url = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;

  const handler = makeAppApiHandler(core);
  api = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => api.close(resolve));
  await new Promise((resolve) => s3.close(resolve));
});

beforeEach(() => {
  consoleQuotaFull = false;
  machineToken = "uno_machine";
});

describe("storage keys", () => {
  it("accepts relative keys and rejects escapes", () => {
    expect(validateStorageKey("photos/2026/cat.jpg", "file")).toBe("photos/2026/cat.jpg");
    expect(validateStorageKey("Фото/кот.jpg", "file")).toBe("Фото/кот.jpg");
    for (const bad of [
      "",
      "/etc/passwd",
      "../other/x",
      "a/../../b",
      "a//b",
      "a/./b",
      "a\\b",
      "a\u0000b",
    ]) {
      expect(validateStorageKey(bad, "file")).toBeNull();
    }
    expect(validateStorageKey("photos/", "file")).toBeNull();
    expect(validateStorageKey("photos/", "folder")).toBe("photos/");
    expect(validateStoragePrefix("photos")).toBe("photos/");
    expect(validateStoragePrefix("")).toBe("");
    expect(validateStoragePrefix("../")).toBeNull();
  });
});

describe("App API cloud storage", () => {
  it("puts, reads, lists and deletes inside the app's own folder", async () => {
    const client = album();
    const saved = await client.storage.put("photos/cat.txt", "meow");
    expect(saved).toEqual({ key: "photos/cat.txt", size: 4 });
    // Lives in the shared "apps" bucket, under the app's folder only.
    expect(buckets.map((b) => b.name)).toEqual([APP_STORAGE_BUCKET]);
    expect(objects.get("album/photos/cat.txt")?.body.toString()).toBe("meow");
    expect(objects.get("album/photos/cat.txt")?.type).toBe("text/plain; charset=utf-8");

    expect(await client.storage.getText("photos/cat.txt")).toBe("meow");
    expect(await client.storage.exists("photos/cat.txt")).toBe(true);
    expect(await client.storage.exists("photos/dog.txt")).toBe(false);

    await client.storage.put("notes.json", JSON.stringify({ a: 1 }));
    expect(objects.get("album/notes.json")?.type).toBe("application/json");
    expect(await client.storage.getJson("notes.json")).toEqual({ a: 1 });

    const root = await client.storage.list();
    expect(root.folders).toEqual(["photos/"]);
    expect(root.files.map((f: { key: string }) => f.key)).toEqual(["notes.json"]);
    const all = await client.storage.listAll();
    expect(all.map((f: { key: string }) => f.key).toSorted()).toEqual([
      "notes.json",
      "photos/cat.txt",
    ]);

    const partial = await client.storage.open("photos/cat.txt", { range: "bytes=1-2" });
    expect(partial.status).toBe(206);
    expect(await partial.text()).toBe("eo");

    const link = await client.storage.url("photos/cat.txt");
    expect(link.startsWith(s3Url)).toBe(true);
    expect(link).toContain(encodeURIComponent("album/photos/cat.txt"));

    expect(await client.storage.delete("photos/")).toEqual({ deleted: 1 });
    expect(objects.has("album/photos/cat.txt")).toBe(false);
    expect(objects.has("album/notes.json")).toBe(true);

    // Every console call went with the machine's token, never the app's.
    expect(new Set(consoleCalls.map((c) => c.token))).toEqual(new Set(["uno_machine"]));
  });

  it("never reaches another app's folder", async () => {
    await createClient({ url: apiUrl, token: "uno_app_other" }).storage.put("secret.txt", "x");
    const client = album();
    await expect(client.storage.get("../other/secret.txt")).rejects.toMatchObject({
      status: 400,
      code: "invalid_key",
    });
    // A literal "%2e%2e" folder is just a strange name inside the app's own folder.
    await expect(client.storage.get("%2e%2e/other/secret.txt")).rejects.toMatchObject({
      status: 404,
    });
    const res = await fetch(`${apiUrl}/v1/storage/files/..%2Fother%2Fsecret.txt`, {
      headers: { authorization: "Bearer uno_app_album" },
    });
    expect(res.status).toBe(400);
    await expect(client.storage.list("../")).rejects.toMatchObject({ code: "invalid_key" });
    await expect(client.storage.getText("secret.txt")).rejects.toMatchObject({
      status: 404,
      code: "file_not_found",
    });
    expect(
      (await client.storage.listAll()).some((f: { key: string }) => f.key === "secret.txt"),
    ).toBe(false);
  });

  it("keeps the app within its limit and reports usage", async () => {
    const client = album();
    await client.storage.delete("notes.json").catch(() => undefined);
    await client.storage.put("big.bin", new Uint8Array(600));
    const usage = await client.storage.usage();
    expect(usage).toMatchObject({ limitBytes: 1000, folder: "Cloud storage → apps/album/" });
    expect(usage.usedBytes).toBeGreaterThanOrEqual(600);
    await expect(client.storage.put("big2.bin", new Uint8Array(600))).rejects.toMatchObject({
      status: 507,
      code: "app_storage_full",
    });
    expect(objects.has("album/big2.bin")).toBe(false);
    await client.storage.delete("big.bin");
  });

  it("passes the account's full cloud through as cloud_full", async () => {
    consoleQuotaFull = true;
    await expect(album().storage.put("x.txt", "x")).rejects.toMatchObject({
      status: 402,
      code: "cloud_full",
    });
  });

  it("says so when the computer isn't linked to an account", async () => {
    machineToken = "";
    await expect(album().storage.put("x.txt", "x")).rejects.toMatchObject({
      status: 503,
      code: "storage_not_connected",
    });
  });

  it("refuses an app whose manifest doesn't ask for storage", async () => {
    const error = await createClient({ url: apiUrl, token: "uno_app_nostorage" })
      .storage.put("x.txt", "x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnoAppError);
    expect(error).toMatchObject({ status: 403, code: "storage_not_allowed" });
  });

  it("keeps this computer's own folder apart from the shared one, both ways", async () => {
    const shared = album();
    const here = createClient({ url: apiUrl, token: "uno_app_album_here" });
    await shared.storage.put("shared.txt", "s");
    await here.storage.put("mine.txt", "m");
    expect(objects.get("album@computer-7/mine.txt")?.body.toString()).toBe("m");
    expect(
      (await shared.storage.listAll()).map((f: { key: string }) => f.key).includes("mine.txt"),
    ).toBe(false);
    expect((await here.storage.listAll()).map((f: { key: string }) => f.key)).toEqual(["mine.txt"]);
    await expect(here.storage.getText("shared.txt")).rejects.toMatchObject({ status: 404 });
    // The limit counts the folder the app uses now.
    await here.storage.put("big.bin", new Uint8Array(900));
    await expect(here.storage.put("more.bin", new Uint8Array(200))).rejects.toMatchObject({
      code: "app_storage_full",
    });
    await shared.storage.put("more.bin", new Uint8Array(200));
    expect((await here.storage.usage()).folder).toBe("Cloud storage → apps/album@computer-7/");
  });

  it("deletes one whole app folder, and only that folder", async () => {
    await album().storage.put("keep.txt", "k");
    await createClient({ url: apiUrl, token: "uno_app_album_here" }).storage.put("x.txt", "x");
    const before = [...objects.keys()].filter((key) => key.startsWith("album@computer-7/")).length;
    expect(before).toBeGreaterThan(0);
    expect(await storage.deleteFolder("album@computer-7/")).toBe(before);
    expect([...objects.keys()].some((key) => key.startsWith("album@computer-7/"))).toBe(false);
    expect(objects.has("album/keep.txt")).toBe(true);
    expect(objects.has("other/secret.txt")).toBe(true);
    // Never the bucket root or a folder inside an app's folder.
    await expect(storage.deleteFolder("")).rejects.toBeInstanceOf(AppStorageError);
    await expect(storage.deleteFolder("album/photos/")).rejects.toBeInstanceOf(AppStorageError);
    await expect(storage.deleteFolder("../")).rejects.toBeInstanceOf(AppStorageError);
    machineToken = "";
    await expect(storage.deleteFolder("album/")).rejects.toThrow(/Sign in to Uno/);
  });

  it("names folders: shared, an Uno computer's own, a computer off Uno", () => {
    expect(appFolder("notes")).toBe("notes/");
    expect(appFolder("notes", appStorageComputerKey(1920, "abc123abc123"))).toBe(
      "notes@computer-1920/",
    );
    expect(appStorageComputerKey(null, "abc123abc123")).toBe("local-abc123abc123");
    expect(appStorageComputerKey(0, "abc123abc123")).toBe("local-abc123abc123");
  });

  it("requires a length for uploads", async () => {
    const res = await fetch(`${apiUrl}/v1/storage/files/a.txt`, {
      method: "PUT",
      headers: { authorization: "Bearer uno_app_album" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("abc"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(411);
  });
});
