import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { makeOutsideThreads, parseOutsideThreads } from "./outsideThreads.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const file = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "outside-threads-"));
  dirs.push(dir);
  return path.join(dir, "marks.json");
};

describe("chats holding a stranger's text", () => {
  it("survive a restart: a run cut in half doesn't open the gate", async () => {
    const at = file();
    await Effect.runPromise(
      Effect.gen(function* () {
        const marks = yield* makeOutsideThreads(at);
        expect(yield* marks.has("t1")).toBe(false);
        yield* marks.mark("t1");
        expect(yield* marks.has("t1")).toBe(true);
      }),
    );
    const again = await Effect.runPromise(makeOutsideThreads(at));
    expect(await Effect.runPromise(again.has("t1"))).toBe(true);
    expect(statSync(at).mode & 0o777).toBe(0o600);
  });

  it("fails closed: a file it can't read gates every chat until the next write", async () => {
    const at = file();
    writeFileSync(at, "{ not json");
    const marks = await Effect.runPromise(makeOutsideThreads(at));
    expect(await Effect.runPromise(marks.has("any"))).toBe(true);
    await Effect.runPromise(marks.mark("t1"));
    expect(await Effect.runPromise(marks.has("any"))).toBe(false);
    expect(await Effect.runPromise(marks.has("t1"))).toBe(true);
  });

  it("a mark that can't be written stops the run", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "outside-threads-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "not-a-dir"), "");
    const marks = await Effect.runPromise(
      makeOutsideThreads(path.join(dir, "not-a-dir", "marks.json")),
    );
    await expect(Effect.runPromise(marks.mark("t1"))).rejects.toThrow();
  });

  it("keeps the last N and ignores junk", async () => {
    expect(parseOutsideThreads({ threads: ["a", 1, "", "b"] })).toEqual(["a", "b"]);
    expect(parseOutsideThreads(null)).toEqual([]);
    const marks = await Effect.runPromise(makeOutsideThreads(file(), 2));
    await Effect.runPromise(Effect.all([marks.mark("a"), marks.mark("b"), marks.mark("c")]));
    expect(await Effect.runPromise(marks.has("a"))).toBe(false);
    expect(await Effect.runPromise(marks.has("c"))).toBe(true);
  });
});
