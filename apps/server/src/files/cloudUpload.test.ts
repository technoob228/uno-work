import fsPromises from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { ControlPlaneHttpError } from "../workspaceRegistry/unoCloudParse.ts";
import { CloudError, cloudUpload } from "./cloudStorage.ts";
import {
  CloudUploadError,
  UPLOAD_PART_ATTEMPTS,
  bytesUploadSource,
  fileUploadSource,
  missingPartsFrom,
  streamUploadSource,
  uploadToBucket,
} from "./cloudUpload.ts";

/**
 * A fake console (presign) + storage. `partSize` > 0 makes it answer with
 * parts for files bigger than `singleMax`; storage keeps every PUT body.
 */
function fakeStorage(
  options: {
    partSize?: number;
    singleMax?: number;
    maxBytes?: boolean;
    /** Storage answer for a PUT: status, or undefined for 200. Called per try. */
    answer?: (url: string, tries: number) => number | undefined;
    /** Console error for a presign of this method (once each, by method). */
    consoleError?: Partial<Record<string, ControlPlaneHttpError | Error>>;
  } = {},
) {
  const presigns: Array<Record<string, unknown>> = [];
  const puts: Array<{ url: string; bytes: Uint8Array; headers: Record<string, string> }> = [];
  const tries = new Map<string, number>();
  const parts = new Map<number, Uint8Array>();
  let signRound = 0;
  let objectBytes: Uint8Array | null = null;
  let plan: { parts: number; partSize: number } | null = null;

  const partUrls = (first: number, last: number) =>
    Array.from(
      { length: last - first + 1 },
      (_, index) => `https://s3.test/part/${first + index}?round=${signRound}`,
    );

  const presign = async (body: Record<string, unknown>): Promise<unknown> => {
    presigns.push(body);
    const method = String(body["method"]);
    const error = options.consoleError?.[method];
    if (error) {
      delete options.consoleError![method];
      throw error;
    }
    if (method === "complete") {
      const assembled: Uint8Array[] = [];
      for (let n = 1; n <= plan!.parts; n += 1) assembled.push(parts.get(n)!);
      objectBytes = new Uint8Array(Buffer.concat(assembled));
      return { method: "complete", status: "completed" };
    }
    if (method === "abort") return { method: "abort", status: "aborted" };
    if (body["upload_id"]) {
      signRound += 1;
      const first = Number(body["first"]);
      const last = Number(body["last"]);
      return { multipart: true, upload_id: "up-1", first, part_urls: partUrls(first, last) };
    }
    const size = Number(body["size"]);
    if (options.partSize && size > (options.singleMax ?? 0)) {
      const count = Math.ceil(size / options.partSize);
      plan = { parts: count, partSize: options.partSize };
      return {
        method: "put",
        multipart: true,
        key: body["key"],
        upload_id: "up-1",
        size,
        part_size: options.partSize,
        parts: count,
        first: 1,
        part_urls: partUrls(1, count),
        expires_in: 3600,
      };
    }
    return options.maxBytes === false
      ? { url: "https://s3.test/single" }
      : { url: "https://s3.test/single", method: "put", max_bytes: 5_261_334_937 };
  };

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const count = (tries.get(url.replace(/\?.*$/, "")) ?? 0) + 1;
    tries.set(url.replace(/\?.*$/, ""), count);
    const bytes = new Uint8Array(
      await new Response(init?.body as ConstructorParameters<typeof Response>[0]).arrayBuffer(),
    );
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    puts.push({ url, bytes, headers });
    const status = options.answer?.(url, count);
    if (status !== undefined) {
      if (status === 0) throw new TypeError("fetch failed");
      return new Response("nope", { status });
    }
    const part = /^https:\/\/s3\.test\/part\/(\d+)/.exec(url);
    if (part) parts.set(Number(part[1]), bytes);
    else objectBytes = bytes;
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  return {
    presign,
    fetchImpl,
    presigns,
    puts,
    parts,
    object: () => objectBytes,
    methods: () => presigns.map((body) => String(body["method"])),
  };
}

const bytesOf = (length: number) =>
  Uint8Array.from({ length }, (_, index) => (index * 7 + 3) % 251);
const noSleep = async () => undefined;

let tmp: string | null = null;
afterEach(async () => {
  if (tmp) await fsPromises.rm(tmp, { recursive: true, force: true });
  tmp = null;
});
async function tempFile(bytes: Uint8Array): Promise<string> {
  tmp = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "cloud-upload-"));
  const path = nodePath.join(tmp, "big.bin");
  await fsPromises.writeFile(path, bytes);
  return path;
}

describe("uploadToBucket", () => {
  it("sends the size and puts a file the console takes in one link in one PUT", async () => {
    const fake = fakeStorage({ partSize: 10, singleMax: 100 });
    const data = bytesOf(42);
    const progress: number[] = [];
    const result = await uploadToBucket({
      ...fake,
      key: "docs/a.bin",
      source: fileUploadSource(await tempFile(data), data.length),
      contentType: "application/pdf",
      onProgress: (done) => progress.push(done),
      sleep: noSleep,
    });
    expect(result).toEqual({ multipart: false, parts: 1 });
    expect(fake.presigns[0]).toMatchObject({
      key: "docs/a.bin",
      method: "put",
      size: 42,
      content_type: "application/pdf",
    });
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0]!.headers["content-length"]).toBe("42");
    expect(fake.puts[0]!.headers["content-type"]).toBe("application/pdf");
    expect(fake.object()).toEqual(data);
    expect(progress).toEqual([42]);
  });

  it("retries one whole-file PUT only on a link with max_bytes", async () => {
    const vouched = fakeStorage({ answer: (_url, tries) => (tries === 1 ? 500 : undefined) });
    await uploadToBucket({
      ...vouched,
      key: "a.bin",
      source: bytesUploadSource(bytesOf(10)),
      sleep: noSleep,
    });
    expect(vouched.puts).toHaveLength(2);

    const old = fakeStorage({ maxBytes: false, answer: () => 500 });
    await expect(
      uploadToBucket({ ...old, key: "a.bin", source: bytesUploadSource(bytesOf(10)) }),
    ).rejects.toMatchObject({ code: "storage_refused", status: 500 });
    expect(old.puts).toHaveLength(1);
  });

  it("works with an old console that answers just {url} (no max_bytes)", async () => {
    const fake = fakeStorage({ maxBytes: false });
    const data = bytesOf(300);
    await uploadToBucket({ ...fake, key: "a.bin", source: bytesUploadSource(data) });
    expect(fake.methods()).toEqual(["put"]);
    expect(fake.object()).toEqual(data);
  });

  it("never caps the size itself: a file over 256 MB still asks the console", async () => {
    const fake = fakeStorage({ maxBytes: false });
    // A source that claims 300 MB; the console says one link, so one PUT goes out.
    const size = 300 * 1024 * 1024;
    await uploadToBucket({
      ...fake,
      key: "huge.bin",
      source: {
        size,
        rereadable: true,
        whole: () => () => ({ body: new Uint8Array(1), length: size }),
        range: async () => () => ({ body: new Uint8Array(1), length: 1 }),
      },
    });
    expect(fake.presigns[0]).toMatchObject({ size });
    expect(fake.puts).toHaveLength(1);
  });

  it("uploads in parts: right ranges, a shorter last part, then complete", async () => {
    const fake = fakeStorage({ partSize: 10, singleMax: 20 });
    const data = bytesOf(45);
    const progress: number[] = [];
    const result = await uploadToBucket({
      ...fake,
      key: "docs/big.bin",
      source: fileUploadSource(await tempFile(data), data.length),
      onProgress: (done, total) => {
        expect(total).toBe(45);
        progress.push(done);
      },
      sleep: noSleep,
    });
    expect(result).toEqual({ multipart: true, parts: 5 });
    expect([...fake.parts.keys()].toSorted()).toEqual([1, 2, 3, 4, 5]);
    for (let n = 1; n <= 5; n += 1) {
      expect(fake.parts.get(n)).toEqual(data.subarray((n - 1) * 10, Math.min(45, n * 10)));
    }
    expect(fake.parts.get(5)!.length).toBe(5);
    // Parts go with no extra headers, only their own length.
    expect(fake.puts.every((put) => Object.keys(put.headers).join() === "content-length")).toBe(
      true,
    );
    expect(fake.methods()).toEqual(["put", "complete"]);
    expect(fake.presigns[1]).toEqual({
      key: "docs/big.bin",
      method: "complete",
      upload_id: "up-1",
    });
    expect(fake.object()).toEqual(data);
    expect(progress.at(-1)).toBe(45);
    expect(progress).toEqual(progress.toSorted((a, b) => a - b));
  });

  it("cuts parts out of a stream (an app's request body) in order", async () => {
    const fake = fakeStorage({ partSize: 16, singleMax: 20 });
    const data = bytesOf(100);
    // Odd chunk sizes, so parts straddle chunks.
    const chunks: Buffer[] = [];
    for (let at = 0; at < data.length; at += 7) chunks.push(Buffer.from(data.subarray(at, at + 7)));
    await uploadToBucket({
      ...fake,
      key: "s.bin",
      source: streamUploadSource(Readable.from(chunks), data.length),
      concurrency: 3,
      sleep: noSleep,
    });
    expect(fake.parts.size).toBe(7);
    expect(fake.object()).toEqual(data);
  });

  it("retries a part that failed, with a pause", async () => {
    const pauses: number[] = [];
    const fake = fakeStorage({
      partSize: 10,
      singleMax: 0,
      answer: (url, tries) => (url.includes("/part/2?") && tries <= 2 ? 500 : undefined),
    });
    const data = bytesOf(30);
    await uploadToBucket({
      ...fake,
      key: "r.bin",
      source: bytesUploadSource(data),
      sleep: async (ms) => void pauses.push(ms),
    });
    expect(fake.puts.filter((put) => put.url.includes("/part/2?"))).toHaveLength(3);
    expect(pauses).toEqual([1000, 2000]);
    expect(fake.object()).toEqual(data);
  });

  it("re-signs a part whose link expired (403)", async () => {
    const fake = fakeStorage({
      partSize: 10,
      singleMax: 0,
      answer: (url) => (url === "https://s3.test/part/3?round=0" ? 403 : undefined),
    });
    const data = bytesOf(50);
    await uploadToBucket({
      ...fake,
      key: "x.bin",
      source: bytesUploadSource(data),
      sleep: noSleep,
    });
    const resign = fake.presigns.find((body) => body["upload_id"] && body["method"] === "put");
    expect(resign).toMatchObject({ key: "x.bin", upload_id: "up-1", first: 3, last: 5 });
    expect(fake.puts.some((put) => put.url === "https://s3.test/part/3?round=1")).toBe(true);
    expect(fake.object()).toEqual(data);
  });

  it("aborts the upload when a part keeps failing, and doesn't complete", async () => {
    const fake = fakeStorage({
      partSize: 10,
      singleMax: 0,
      answer: (url) => (url.includes("/part/2?") ? 503 : undefined),
    });
    const failure = await uploadToBucket({
      ...fake,
      key: "f.bin",
      source: bytesUploadSource(bytesOf(40)),
      sleep: noSleep,
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(CloudUploadError);
    expect(failure).toMatchObject({ code: "storage_refused", status: 503 });
    expect(fake.puts.filter((put) => put.url.includes("/part/2?"))).toHaveLength(
      UPLOAD_PART_ATTEMPTS,
    );
    expect(fake.methods()).toContain("abort");
    expect(fake.methods()).not.toContain("complete");
    expect(fake.presigns.find((body) => body["method"] === "abort")).toEqual({
      key: "f.bin",
      method: "abort",
      upload_id: "up-1",
    });
  });

  it("aborts at once on a refusal that another try won't fix", async () => {
    const fake = fakeStorage({
      partSize: 10,
      singleMax: 0,
      answer: (url) => (url.includes("/part/1?") ? 400 : undefined),
    });
    await expect(
      uploadToBucket({ ...fake, key: "f.bin", source: bytesUploadSource(bytesOf(25)) }),
    ).rejects.toMatchObject({ code: "storage_refused", status: 400 });
    expect(fake.puts.filter((put) => put.url.includes("/part/1?"))).toHaveLength(1);
    expect(fake.methods().at(-1)).toBe("abort");
  });

  it("aborts when an app's stream ends before its Content-Length", async () => {
    const fake = fakeStorage({ partSize: 10, singleMax: 0 });
    const failure = await uploadToBucket({
      ...fake,
      key: "s.bin",
      source: streamUploadSource(Readable.from([Buffer.from(bytesOf(25))]), 40),
      sleep: noSleep,
    }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: "source_failed" });
    expect(fake.methods().at(-1)).toBe("abort");
  });

  it("re-uploads parts the console says are missing, then completes", async () => {
    const fake = fakeStorage({
      partSize: 10,
      singleMax: 0,
      consoleError: {
        complete: new ControlPlaneHttpError(
          400,
          '400: {"error":"INVALID_UPLOAD","detail":"1 of 3 parts are not uploaded yet (or have the wrong size): 2"}',
        ),
      },
    });
    const data = bytesOf(30);
    await uploadToBucket({
      ...fake,
      key: "m.bin",
      source: bytesUploadSource(data),
      sleep: noSleep,
    });
    expect(fake.puts.filter((put) => put.url.includes("/part/2?"))).toHaveLength(2);
    expect(fake.methods().filter((method) => method === "complete")).toHaveLength(2);
    expect(fake.object()).toEqual(data);
  });

  it("leaves assembling to the console when complete doesn't answer", async () => {
    const fake = fakeStorage({
      partSize: 10,
      singleMax: 0,
      consoleError: { complete: new ControlPlaneHttpError(502, "502: bad gateway") },
    });
    await uploadToBucket({
      ...fake,
      key: "c.bin",
      source: bytesUploadSource(bytesOf(30)),
      sleep: noSleep,
    });
    expect(fake.methods()).toEqual(["put", "complete", "complete"]);
    expect(fake.methods()).not.toContain("abort");
  });

  it("reads missing part numbers from the console's message", () => {
    expect(
      missingPartsFrom(
        new Error("400: 3 of 9 parts are not uploaded yet (or have the wrong size): 3, 5, 7"),
      ),
    ).toEqual([3, 5, 7]);
    expect(missingPartsFrom(new Error("400: upload_id is required"))).toEqual([]);
  });
});

describe("cloudUpload (Files)", () => {
  it("says the cloud is full when the console answers 402", async () => {
    const deps = {
      token: "t",
      fetchJson: async () => {
        throw new ControlPlaneHttpError(402, "402: quota");
      },
      fetchImpl: (async () => new Response(null)) as unknown as typeof fetch,
    };
    const failure = await cloudUpload(deps, 7, "a.bin", bytesUploadSource(bytesOf(5))).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(CloudError);
    expect((failure as Error).message).toBe(
      "Cloud storage is full. Free up space or upgrade your plan.",
    );
  });

  it("names the file when storage refuses it", async () => {
    const deps = {
      token: "t",
      fetchJson: async () => ({ url: "https://s3.test/x" }),
      fetchImpl: (async () => new Response("no", { status: 400 })) as unknown as typeof fetch,
    };
    await expect(cloudUpload(deps, 7, "dir/a.bin", bytesUploadSource(bytesOf(5)))).rejects.toThrow(
      "Uploading “a.bin” failed (storage answered 400).",
    );
  });
});
