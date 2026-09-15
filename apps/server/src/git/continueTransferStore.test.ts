import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeContinueTransferStore } from "./continueTransferStore.ts";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

let root: string;

beforeEach(async () => {
  root = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "continue-transfer-store-"));
});

afterEach(async () => {
  await fsPromises.rm(root, { recursive: true, force: true });
});

const b64 = (text: string) => Buffer.from(text).toString("base64");
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const flip = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

describe("makeContinueTransferStore", () => {
  it("moves a bundle chunk by chunk and both sides agree on size and hash", async () => {
    const source = makeContinueTransferStore({ rootDir: nodePath.join(root, "a"), chunkBytes: 4 });
    const target = makeContinueTransferStore({ rootDir: nodePath.join(root, "b"), chunkBytes: 4 });
    const payload = Buffer.from("0123456789abcdefXYZ");
    const outgoing = await run(source.prepareOutgoing(ID));
    await fsPromises.writeFile(outgoing, payload);

    const digest = await run(source.digest("outgoing", ID));
    expect(digest).toEqual({
      sizeBytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    });

    const chunkCount = Math.ceil(digest.sizeBytes / 4);
    let received = 0;
    for (let index = 0; index < chunkCount; index += 1) {
      const data = await run(source.readChunk({ transferId: ID, index }));
      received = await run(target.writeChunk({ transferId: ID, offset: index * 4, data }));
    }
    expect(received).toBe(payload.length);
    expect(await run(target.digest("incoming", ID))).toEqual(digest);
    expect(await fsPromises.readFile(await run(target.incomingPath(ID)))).toEqual(payload);
  });

  it("accepts a re-sent chunk, restarts at offset 0 and refuses a gap", async () => {
    const store = makeContinueTransferStore({ rootDir: root });
    await run(store.writeChunk({ transferId: ID, offset: 0, data: b64("aaaa") }));
    await run(store.writeChunk({ transferId: ID, offset: 4, data: b64("bbbb") }));
    // The client retried the second chunk after a dropped response.
    expect(await run(store.writeChunk({ transferId: ID, offset: 4, data: b64("cccc") }))).toBe(8);
    const path = await run(store.incomingPath(ID));
    expect(await fsPromises.readFile(path, "utf8")).toBe("aaaacccc");

    const gap = await flip(store.writeChunk({ transferId: ID, offset: 20, data: b64("dddd") }));
    expect(gap.reason).toBe("transfer_incomplete");

    await run(store.writeChunk({ transferId: ID, offset: 0, data: b64("zz") }));
    expect(await fsPromises.readFile(path, "utf8")).toBe("zz");
  });

  it("refuses ids that are not transfer ids and bundles above the limit", async () => {
    const store = makeContinueTransferStore({ rootDir: root, maxBundleBytes: 6 });
    const traversal = await flip(
      store.writeChunk({ transferId: "../../etc/passwd", offset: 0, data: "" }),
    );
    expect(traversal.reason).toBe("invalid_request");
    expect(await run(store.discard("../x"))).toBe(false);

    const tooLarge = await flip(
      store.writeChunk({
        transferId: ID,
        offset: 4,
        data: Buffer.from("abcd").toString("base64"),
      }),
    );
    expect(tooLarge.reason).toBe("too_large");
  });

  it("reports a missing bundle as transfer_not_found", async () => {
    const store = makeContinueTransferStore({ rootDir: root });
    expect((await flip(store.readChunk({ transferId: ID, index: 0 }))).reason).toBe(
      "transfer_not_found",
    );
    expect((await flip(store.digest("incoming", ID))).reason).toBe("transfer_not_found");
  });

  it("discards both sides and sweeps only bundles past the TTL", async () => {
    let now = Date.now();
    const store = makeContinueTransferStore({ rootDir: root, ttlMs: 60_000, now: () => now });
    const outgoing = await run(store.prepareOutgoing(ID));
    await fsPromises.writeFile(outgoing, "x");
    expect(await run(store.discard(ID))).toBe(true);
    expect(await run(store.discard(ID))).toBe(false);

    const fresh = await run(store.prepareOutgoing(ID));
    await fsPromises.writeFile(fresh, "x");
    await run(store.sweep);
    await expect(fsPromises.stat(fresh)).resolves.toBeTruthy();
    now += 120_000;
    await run(store.sweep);
    await expect(fsPromises.stat(fresh)).rejects.toThrow();
  });
});
