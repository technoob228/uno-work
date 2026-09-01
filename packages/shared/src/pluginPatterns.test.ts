import { describe, expect, it } from "vitest";

import { anyHookMatches, hookMatches } from "./pluginPatterns.ts";

describe("hookMatches", () => {
  it("matches exact types, prefixes and the wildcard", () => {
    expect(hookMatches("thread.created", "thread.created")).toBe(true);
    expect(hookMatches("thread.created", "thread.deleted")).toBe(false);
    expect(hookMatches("*", "project.created")).toBe(true);
    expect(hookMatches("thread.*", "thread.turn-diff-completed")).toBe(true);
    expect(hookMatches("thread.*", "project.created")).toBe(false);
    // Префикс без точки — не паттерн, а обычная строка.
    expect(hookMatches("thread*", "thread.created")).toBe(false);
  });
});

describe("anyHookMatches", () => {
  it("is true when at least one pattern matches", () => {
    expect(anyHookMatches(["project.*", "thread.created"], "thread.created")).toBe(true);
    expect(anyHookMatches(["project.*"], "thread.created")).toBe(false);
    expect(anyHookMatches([], "thread.created")).toBe(false);
  });
});
