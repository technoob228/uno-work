import { describe, expect, it } from "vitest";

import { kernelRandomBytes, uuidV4FromBytes } from "./cloneEntropy.ts";

describe("clone entropy", () => {
  it("differs between clones even when the process generator is the snapshot's copy", () => {
    // Two clones of one memory snapshot: OpenSSL hands both the same bytes.
    const snapshotCopy = (size: number) => new Uint8Array(size).fill(7);
    const cloneA = kernelRandomBytes(32, snapshotCopy);
    const cloneB = kernelRandomBytes(32, snapshotCopy);
    expect(cloneA).toHaveLength(32);
    expect(Buffer.from(cloneA).equals(Buffer.from(cloneB))).toBe(false);
    expect(Buffer.from(cloneA).equals(Buffer.from(snapshotCopy(32)))).toBe(false);
  });

  it("falls back to the process generator without /dev/urandom", () => {
    const bytes = kernelRandomBytes(4, () => Uint8Array.of(1, 2, 3, 4), "/nonexistent/urandom");
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it("formats a version 4 UUID", () => {
    const id = uuidV4FromBytes(new Uint8Array(16).fill(0xff));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidV4FromBytes(kernelRandomBytes(16))).not.toBe(uuidV4FromBytes(kernelRandomBytes(16)));
  });
});
