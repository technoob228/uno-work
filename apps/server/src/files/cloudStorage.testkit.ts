/**
 * A fake Uno console + S3 for Cloud storage tests (not a test file itself).
 *
 * @module files/cloudStorage.testkit
 */
import { ControlPlaneHttpError } from "../workspaceRegistry/unoCloudParse.ts";
import type { CloudDeps } from "./cloudStorage.ts";

/** A fake console + S3: buckets, a key/value object store, presigned URLs. */
export function fakeCloud(options: { listing?: boolean } = {}) {
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
    const deleteMatch = /^\/api\/v1\/buckets\/7\/objects\?key=(.*)$/.exec(path);
    if (deleteMatch && init?.method === "DELETE") {
      const key = decodeURIComponent(deleteMatch[1]!);
      return { deleted: objects.delete(key) ? 1 : 0 };
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
      objects.set(
        key,
        new Uint8Array(
          await new Response(init?.body as ConstructorParameters<typeof Response>[0]).arrayBuffer(),
        ),
      );
      return new Response(null, { status: 200 });
    }
    const bytes = objects.get(key);
    return bytes ? new Response(bytes) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  const deps: CloudDeps = { token: "machine-token", fetchJson, fetchImpl };
  return { deps, objects, calls };
}
