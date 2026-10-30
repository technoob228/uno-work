import type { FilesCloudUploadStepInput, FilesCloudUploadStepResult } from "@t3tools/contracts";
import { CLOUD_VERSION_MAX_BYTES } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ProjectUploadFile } from "../../projectUpload";
import {
  CLOUD_DISK_FALLBACK_MAX_BYTES,
  splitCloudUpload,
  uploadFilesDirect,
  type XhrLike,
} from "./cloudDirectUpload";

const GB = 1024 ** 3;

function file(relativePath: string, text: string): ProjectUploadFile {
  const blob = new Blob([text]);
  return { relativePath, size: blob.size, blob };
}

/** A file that is big on paper: nothing is allocated. */
function bigFile(relativePath: string, size: number): ProjectUploadFile {
  const blob = { size, slice: () => new Blob(["x"]) } as unknown as Blob;
  return { relativePath, size, blob };
}

type Answer = number | "network" | "hang";

class FakeXhr implements XhrLike {
  status = 0;
  private sending: ((event: { readonly loaded: number }) => void) | null = null;
  private readonly listeners = new Map<string, () => void>();
  readonly upload: XhrLike["upload"] = {
    addEventListener: (_type, listener) => {
      this.sending = listener;
    },
  };
  url = "";
  aborted = false;
  readonly headers = new Map<string, string>();

  constructor(private readonly storage: ReturnType<typeof fakeStorage>) {}

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }
  send(body: Blob) {
    const answer = this.storage.answer(this.url);
    this.storage.requests.push(this);
    void body.text().then((text) => {
      this.sending?.({ loaded: body.size / 2 });
      if (answer === "hang") return;
      if (answer === "network") {
        this.listeners.get("error")?.();
        return;
      }
      if (answer < 300) this.storage.stored.set(this.url, text);
      this.status = answer;
      this.listeners.get("load")?.();
    });
  }
  abort() {
    this.aborted = true;
    this.listeners.get("abort")?.();
  }
}

function fakeStorage(answer: (url: string) => Answer = () => 200) {
  const storage = {
    answer,
    stored: new Map<string, string>(),
    requests: [] as FakeXhr[],
    makeXhr: () => new FakeXhr(storage),
  };
  return storage;
}

/** The console through the daemon: `plan` answers the first `put` of a file. */
function fakeConsole(plan: (input: FilesCloudUploadStepInput) => unknown) {
  const steps: FilesCloudUploadStepInput[] = [];
  const step = async (input: FilesCloudUploadStepInput): Promise<FilesCloudUploadStepResult> => {
    steps.push(input);
    if (input.method === "put" && input.upload_id !== undefined) {
      const urls: string[] = [];
      for (let part = input.first!; part <= input.last!; part += 1) {
        urls.push(`https://s3.test/part/${part}`);
      }
      return { answer: { first: input.first, part_urls: urls } };
    }
    if (input.method === "put") return { answer: plan(input) };
    return { answer: {} };
  };
  return { step, steps };
}

const onePut = (input: FilesCloudUploadStepInput) => ({
  url: `https://s3.test/put/${input.key}`,
  max_bytes: 5 * GB,
});

const inParts =
  (partSize: number, signedUpFront: number) => (input: FilesCloudUploadStepInput) => ({
    multipart: true,
    upload_id: "u1",
    part_size: partSize,
    parts: Math.ceil(input.size! / partSize),
    first: 1,
    part_urls: Array.from(
      { length: signedUpFront },
      (_, index) => `https://s3.test/part/${index + 1}`,
    ),
  });

const noPause = async () => undefined;

describe("splitCloudUpload", () => {
  const over = CLOUD_VERSION_MAX_BYTES + 1;

  it("keeps files up to the old limit on the old way", () => {
    const small = bigFile("a.bin", CLOUD_VERSION_MAX_BYTES);
    const big = bigFile("b.bin", over);
    const split = splitCloudUpload([small, big]);
    expect(split.staged).toEqual([small]);
    expect(split.direct).toEqual([big]);
    expect(split.leftOut).toEqual([]);
  });

  it("sends a hidden file only when it was picked itself", () => {
    const picked = bigFile(".backup.tar", over);
    const nested = bigFile("project/.git/pack.bin", over);
    const split = splitCloudUpload([picked, nested]);
    expect(split.direct).toEqual([picked]);
    expect(split.leftOut).toEqual([nested]);
  });

  it("leaves an unsafe path to the old way, which refuses it", () => {
    const unsafe = bigFile("../escape.bin", over);
    expect(splitCloudUpload([unsafe]).staged).toEqual([unsafe]);
  });
});

describe("uploadFilesDirect", () => {
  it("puts a file under prefix + relative path, in one PUT when the console says so", async () => {
    const storage = fakeStorage();
    const { step, steps } = fakeConsole(onePut);
    const seen: number[] = [];
    const result = await uploadFilesDirect({
      step,
      bucketId: 7,
      prefix: "work/",
      files: [file("album/film.mov", "abcdef")],
      makeXhr: storage.makeXhr,
      onProgress: (progress) => seen.push(progress.sentBytes),
    });
    expect(result).toEqual({ uploaded: 1, fallback: [] });
    expect(steps).toMatchObject([
      { bucketId: 7, key: "work/album/film.mov", method: "put", size: 6 },
    ]);
    expect(storage.stored.get("https://s3.test/put/work/album/film.mov")).toBe("abcdef");
    // The browser sets the length itself; anything else would need CORS rules.
    expect(storage.requests[0]!.headers.size).toBe(0);
    expect(seen).toContain(3); // half of it, while the request is going
    expect(seen.at(-1)).toBe(6);
  });

  it("sends each part's own bytes, signs the rest, and finishes the upload", async () => {
    const storage = fakeStorage();
    const { step, steps } = fakeConsole(inParts(4, 1));
    await uploadFilesDirect({
      step,
      bucketId: 7,
      prefix: "",
      files: [file("film.mov", "aaaabbbbcc")],
      makeXhr: storage.makeXhr,
    });
    expect(Object.fromEntries(storage.stored)).toEqual({
      "https://s3.test/part/1": "aaaa",
      "https://s3.test/part/2": "bbbb",
      "https://s3.test/part/3": "cc",
    });
    expect(steps.at(-1)).toEqual({
      bucketId: 7,
      key: "film.mov",
      method: "complete",
      upload_id: "u1",
    });
    expect(steps.some((entry) => entry.first === 2)).toBe(true);
  });

  it("shows the console's refusal as it is, and uploads nothing", async () => {
    const storage = fakeStorage();
    const message = "Cloud storage is full. Free up space or upgrade your plan.";
    await expect(
      uploadFilesDirect({
        step: async () => ({ refusal: { status: 402, message, detail: "402: over quota" } }),
        bucketId: 7,
        prefix: "",
        files: [file("film.mov", "abc")],
        makeXhr: storage.makeXhr,
      }),
    ).rejects.toThrow(message);
    expect(storage.requests).toEqual([]);
  });

  it("says when the console's answer makes no sense", async () => {
    await expect(
      uploadFilesDirect({
        step: fakeConsole(() => ({})).step,
        bucketId: 7,
        prefix: "",
        files: [file("film.mov", "abc")],
        makeXhr: fakeStorage().makeXhr,
      }),
    ).rejects.toThrow("The console didn't return an upload address.");
  });

  it("goes back to the old way when storage can't be reached from this page", async () => {
    const storage = fakeStorage(() => "network");
    const { step } = fakeConsole(onePut);
    const blocked = file("film.mov", "abc");
    const fine = bigFile("other.mov", CLOUD_DISK_FALLBACK_MAX_BYTES);
    const result = await uploadFilesDirect({
      step,
      bucketId: 7,
      prefix: "",
      files: [blocked, fine],
      makeXhr: storage.makeXhr,
      sleep: noPause,
    });
    expect(result).toEqual({ uploaded: 0, fallback: [blocked, fine] });
  });

  it("goes back to the old way on a computer that doesn't know the step yet", async () => {
    const old = file("film.mov", "abc");
    const result = await uploadFilesDirect({
      step: async () => {
        throw new Error("Unknown request files.cloud.uploadStep");
      },
      bucketId: 7,
      prefix: "",
      files: [old],
      makeXhr: fakeStorage().makeXhr,
    });
    expect(result.fallback).toEqual([old]);
  });

  it("fails with a reason when the file is too big for the old way", async () => {
    const storage = fakeStorage(() => "network");
    await expect(
      uploadFilesDirect({
        step: fakeConsole(onePut).step,
        bucketId: 7,
        prefix: "",
        files: [bigFile("film.mov", CLOUD_DISK_FALLBACK_MAX_BYTES + 1)],
        makeXhr: storage.makeXhr,
        sleep: noPause,
      }),
    ).rejects.toThrow("Uploading “film.mov” failed (couldn't reach storage).");
  });

  it("doesn't start over once part of the file is stored", async () => {
    const storage = fakeStorage((url) => (url.endsWith("/1") ? 200 : "network"));
    const { step, steps } = fakeConsole(inParts(4, 3));
    await expect(
      uploadFilesDirect({
        step,
        bucketId: 7,
        prefix: "",
        files: [file("film.mov", "aaaabbbbcc")],
        makeXhr: storage.makeXhr,
        sleep: noPause,
      }),
    ).rejects.toThrow("Uploading “film.mov” failed");
    expect(steps.at(-1)?.method).toBe("abort");
  });

  it("gets through a dropped connection in the middle of a file", async () => {
    let drops = 6; // past the tries a file gets before anything is stored
    const storage = fakeStorage((url) => {
      if (url.endsWith("/2") && drops > 0) {
        drops -= 1;
        return "network";
      }
      return 200;
    });
    const result = await uploadFilesDirect({
      step: fakeConsole(inParts(4, 3)).step,
      bucketId: 7,
      prefix: "",
      files: [file("film.mov", "aaaabbbbcc")],
      makeXhr: storage.makeXhr,
      sleep: noPause,
    });
    expect(result.uploaded).toBe(1);
    expect(storage.stored.get("https://s3.test/part/2")).toBe("bbbb");
  });

  it("stops at once on Cancel and drops the unfinished upload", async () => {
    const storage = fakeStorage(() => "hang");
    const { step, steps } = fakeConsole(inParts(4, 3));
    const controller = new AbortController();
    const upload = uploadFilesDirect({
      step,
      bucketId: 7,
      prefix: "",
      files: [file("film.mov", "aaaabbbbcc"), file("next.mov", "dd")],
      signal: controller.signal,
      makeXhr: storage.makeXhr,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(storage.requests.length).toBeGreaterThan(0);
    controller.abort();
    await expect(upload).rejects.toMatchObject({ name: "AbortError" });
    expect(storage.requests.every((request) => request.aborted)).toBe(true);
    expect(steps.at(-1)?.method).toBe("abort");
    expect(steps.some((entry) => entry.key === "next.mov")).toBe(false);
  });
});
