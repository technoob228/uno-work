import type { EnvironmentId, FilesResolveMentionsInput } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFileMentionStore } from "./fileMentionStore";

const env = "env-a" as EnvironmentId;
const other = "env-b" as EnvironmentId;

function setup(known: Record<string, string> = {}) {
  const resolve = vi.fn(async (_env: EnvironmentId, input: FilesResolveMentionsInput) => ({
    results: input.mentions.map((mention) => ({
      mention,
      path: known[mention] ?? null,
      kind: known[mention] ? ("file" as const) : null,
    })),
  }));
  let clock = 1_000;
  const store = createFileMentionStore(resolve, () => clock);
  return { resolve, store, advance: (ms: number) => (clock += ms) };
}

const settle = async () => {
  await vi.advanceTimersByTimeAsync(50);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("fileMentionStore", () => {
  it("asks once for everything a chat's rows want at the same moment", async () => {
    const { resolve, store } = setup({ "a.md": "/h/a.md" });
    store.request(env, "/h", "a.md");
    store.request(env, "/h", "b.md");
    store.request(env, "/h", "a.md");
    await settle();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(env, { cwd: "/h", mentions: ["a.md", "b.md"] });
    expect(store.get(env, "/h", "a.md")).toEqual({
      status: "found",
      path: "/h/a.md",
      kind: "file",
    });
    expect(store.get(env, "/h", "b.md")).toEqual({ status: "missing" });
  });

  it("asks each computer about its own files", async () => {
    const { resolve, store } = setup();
    store.request(env, "/h", "a.md");
    store.request(other, "/h", "a.md");
    await settle();
    expect(resolve.mock.calls.map((call) => call[0]).toSorted()).toEqual([env, other]);
  });

  it("splits a long list into calls the computer accepts", async () => {
    const { resolve, store } = setup();
    for (let index = 0; index < 70; index += 1) store.request(env, "/h", `f${index}.md`);
    await settle();
    expect(resolve.mock.calls.map((call) => call[1].mentions.length)).toEqual([64, 6]);
  });

  it("doesn't ask again while the answer is fresh", async () => {
    const { resolve, store, advance } = setup({ "a.md": "/h/a.md" });
    store.request(env, "/h", "a.md");
    await settle();
    advance(60_000);
    store.request(env, "/h", "a.md");
    await settle();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("looks again soon for a file that wasn't there", async () => {
    const { resolve, store, advance } = setup();
    store.request(env, "/h", "new.md");
    await settle();
    advance(30_000);
    store.request(env, "/h", "new.md");
    await settle();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("keeps the same answer object, so nothing redraws, and tells only on a change", async () => {
    const known: Record<string, string> = { "a.md": "/h/a.md" };
    const { store, advance } = setup(known);
    const listener = vi.fn();
    store.subscribe(env, "/h", "a.md", listener);
    store.request(env, "/h", "a.md");
    await settle();
    const first = store.get(env, "/h", "a.md");
    expect(listener).toHaveBeenCalledTimes(1);
    advance(10 * 60_000);
    store.request(env, "/h", "a.md");
    await settle();
    expect(store.get(env, "/h", "a.md")).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("says unknown when the computer can't answer", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("unknown method");
    });
    const store = createFileMentionStore(resolve, () => 1);
    store.request(env, undefined, "a.md");
    await settle();
    expect(store.get(env, undefined, "a.md")).toEqual({ status: "unknown" });
  });

  it("has no answers for a chat with no computer", () => {
    const { store } = setup();
    expect(store.get(undefined, "/h", "a.md")).toBeNull();
  });
});
