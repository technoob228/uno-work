import { describe, expect, it } from "@effect/vitest";

import { buildWakeMessages, parseWakeDecision } from "./wakeClassifier.ts";

describe("parseWakeDecision", () => {
  it("treats an explicit yes as addressed", () => {
    expect(parseWakeDecision({ choices: [{ message: { content: "yes" } }] })).toBe(true);
    expect(parseWakeDecision({ choices: [{ message: { content: "Yes." } }] })).toBe(true);
  });

  it("treats anything else as not addressed", () => {
    expect(parseWakeDecision({ choices: [{ message: { content: "no" } }] })).toBe(false);
    expect(parseWakeDecision({ choices: [{ message: { content: "maybe" } }] })).toBe(false);
    expect(parseWakeDecision({ choices: [] })).toBe(false);
    expect(parseWakeDecision({})).toBe(false);
    expect(parseWakeDecision(null)).toBe(false);
  });
});

describe("buildWakeMessages", () => {
  it("fences the message and lists the wake names", () => {
    const messages = buildWakeMessages({ names: ["Антоха", "Антон"], text: "кто глянет логи?" });
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("Антоха, Антон");
    expect(messages[1]?.content).toContain("кто глянет логи?");
    expect(messages[1]?.content).toContain("<<<");
  });

  it("includes recent context only when provided", () => {
    expect(buildWakeMessages({ names: [], text: "x" })[1]?.content).not.toContain("Recent context");
    expect(
      buildWakeMessages({ names: [], text: "x", recentContext: "User: hi" })[1]?.content,
    ).toContain("Recent context");
  });
});
