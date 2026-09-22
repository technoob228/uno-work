import fs from "node:fs";
import os from "node:os";

import { describe, expect, it } from "vitest";

import { guardNodeStatsPrototype } from "./nodeStatsGuard.ts";

describe("guardNodeStatsPrototype", () => {
  it("reading a date on the prototype no longer poisons every Stats object", () => {
    guardNodeStatsPrototype();
    const proto = fs.Stats.prototype as unknown as Record<string, unknown>;
    // What Effect's Cause.pretty did while formatting a failed span.
    expect(proto.mtime).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(proto, "mtime")?.get).toBeTypeOf("function");
    const stats = fs.statSync(os.tmpdir());
    expect(Number.isNaN(stats.mtime.getTime())).toBe(false);
    expect(stats.mtime.toISOString()).toBe(new Date(Math.round(stats.mtimeMs)).toISOString());
  });

  it("is idempotent", () => {
    guardNodeStatsPrototype();
    guardNodeStatsPrototype();
    expect(Number.isNaN(fs.statSync(os.tmpdir()).birthtime.getTime())).toBe(false);
  });
});
