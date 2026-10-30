import { describe, expect, it } from "vitest";

import {
  blobUploadSource,
  CloudUploadError,
  type FetchLike,
  UPLOAD_PART_ATTEMPTS,
  uploadToBucket,
} from "./cloudUpload.ts";
import { ControlPlaneHttpError } from "./unoCloud.ts";

const parts = (size: number, partSize: number) => ({
  multipart: true,
  upload_id: "u1",
  part_size: partSize,
  parts: Math.ceil(size / partSize),
  first: 1,
  part_urls: Array.from(
    { length: Math.ceil(size / partSize) },
    (_, index) => `https://s3.test/${index + 1}`,
  ),
});

const noPause = async () => undefined;

describe("blobUploadSource", () => {
  it("slices without reading, and a slice brings no content type", async () => {
    const source = blobUploadSource(new Blob(["abcdef"], { type: "video/mp4" }));
    const made = (await source.range(2, 5))();
    expect(made.length).toBe(3);
    expect((made.body as Blob).type).toBe("");
    expect(await (made.body as Blob).text()).toBe("cde");
    expect(source.rereadable).toBe(true);
  });
});

describe("uploadToBucket", () => {
  it("drops an upload in parts when it's cancelled", async () => {
    const steps: string[] = [];
    const controller = new AbortController();
    const fetchImpl: FetchLike = async (_url, init) => {
      controller.abort();
      expect(init?.signal).toBe(controller.signal);
      throw new Error("aborted");
    };
    const failure = await uploadToBucket({
      presign: async (body) => {
        steps.push(String(body["method"]));
        return parts(8, 4);
      },
      fetchImpl,
      key: "a",
      source: blobUploadSource(new Blob(["aaaabbbb"])),
      signal: controller.signal,
      sleep: noPause,
    }).catch((error: unknown) => error);
    expect((failure as CloudUploadError).code).toBe("cancelled");
    expect(steps).toEqual(["put", "abort"]);
  });

  it("rides out more drops once part of the file is stored", async () => {
    let drops = UPLOAD_PART_ATTEMPTS + 1;
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).endsWith("/2") && drops > 0) {
        drops -= 1;
        throw new Error("connection reset");
      }
      return new Response(null, { status: 200 });
    };
    const result = await uploadToBucket({
      presign: async (body) => (body["method"] === "put" ? parts(8, 4) : {}),
      fetchImpl,
      key: "a",
      source: blobUploadSource(new Blob(["aaaabbbb"])),
      concurrency: 1,
      patientPartAttempts: UPLOAD_PART_ATTEMPTS + 2,
      sleep: noPause,
    });
    expect(result.parts).toBe(2);
  });

  it("fails fast while nothing is stored, however patient it is later", async () => {
    let tries = 0;
    const fetchImpl: FetchLike = async () => {
      tries += 1;
      throw new Error("blocked");
    };
    const failure = await uploadToBucket({
      presign: async (body) => (body["method"] === "put" ? parts(4, 4) : {}),
      fetchImpl,
      key: "a",
      source: blobUploadSource(new Blob(["aaaa"])),
      patientPartAttempts: 50,
      sleep: noPause,
    }).catch((error: unknown) => error);
    expect((failure as CloudUploadError).code).toBe("storage_unreachable");
    expect(tries).toBe(UPLOAD_PART_ATTEMPTS);
  });

  it("signs links again through a blip on the way to the console", async () => {
    let blips = 1;
    const presign = async (body: Record<string, unknown>) => {
      if (body["first"] !== undefined && blips > 0) {
        blips -= 1;
        throw new ControlPlaneHttpError(503, "503: console restarting");
      }
      if (body["first"] !== undefined) {
        return { first: body["first"], part_urls: ["https://s3.test/2"] };
      }
      if (body["method"] === "put") return { ...parts(8, 4), part_urls: ["https://s3.test/1"] };
      return {};
    };
    const result = await uploadToBucket({
      presign,
      fetchImpl: async () => new Response(null, { status: 200 }),
      key: "a",
      source: blobUploadSource(new Blob(["aaaabbbb"])),
      concurrency: 1,
      sleep: noPause,
    });
    expect(result.parts).toBe(2);
  });
});
