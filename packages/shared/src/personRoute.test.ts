import { describe, expect, it } from "vitest";

import { personRoute, tableRoute } from "./assistantMemory.ts";

const table = (rows: string) =>
  `# Routing\n\n| Task type | Harness | Model | Effort | Source | Why |\n|---|---|---|---|---|---|\n${rows}\n`;

describe("personRoute", () => {
  it("no rows of the person's: no rule", () => {
    expect(
      personRoute(
        table("| Simple tasks | claudeAgent | claude-sonnet-5-5 | medium | default | x |"),
      ),
    ).toBeNull();
  });

  it("Claude everywhere: the one harness, model and thinking they agree on", () => {
    const content = table(
      [
        "| Quick questions | self | — | — | you | answer |",
        "| Simple tasks | claudeAgent | claude-opus-5-5 | high | you | |",
        "| Anything with UI | claudeAgent | claude-opus-5-5 | high | you | |",
      ].join("\n"),
    );
    expect(personRoute(content)).toEqual({
      harness: "claudeAgent",
      model: "claude-opus-5-5",
      thinking: "high",
      taskType: null,
    });
  });

  it("same harness, different models: the harness only", () => {
    const content = table(
      [
        "| Simple tasks | claudeAgent | claude-sonnet-5-5 | medium | you | |",
        "| Hard bugs | claudeAgent | claude-opus-5-5 | max | you | |",
      ].join("\n"),
    );
    expect(personRoute(content)).toMatchObject({
      harness: "claudeAgent",
      model: null,
      thinking: null,
    });
  });

  it("mixed harnesses without a task type: no rule; a task type picks its row", () => {
    const content = table(
      [
        "| Simple tasks | codex | gpt-5.5 | medium | you | |",
        "| Hard bugs | claudeAgent | claude-opus-5-5 | max | you | |",
        "| Reading code | claudeAgent | claude-haiku-4-5 | low | default | |",
      ].join("\n"),
    );
    expect(personRoute(content)).toBeNull();
    expect(personRoute(content, "hard bugs")).toEqual({
      harness: "claudeAgent",
      model: "claude-opus-5-5",
      thinking: "max",
      taskType: "Hard bugs",
    });
    // A default row is not the person's: the task type falls back.
    expect(personRoute(content, "Reading code")).toBeNull();
  });
});

describe("catch-all row (Who does the work)", () => {
  const content = table(
    [
      "| Everything else | codex | gpt-5.6-terra | high | you | |",
      "| Anything with UI | claudeAgent | claude-opus-5-5 | high | you | |",
      "| Reading code | claudeAgent | claude-haiku-4-5 | low | default | |",
    ].join("\n"),
  );

  it("decides work no row of the person's names, even with mixed harnesses", () => {
    expect(personRoute(content)).toMatchObject({ harness: "codex", model: "gpt-5.6-terra" });
    expect(personRoute(content, "Reading code")).toMatchObject({
      harness: "codex",
      taskType: "Everything else",
    });
  });

  it("a row for the task type wins over it", () => {
    expect(personRoute(content, "anything with UI")).toMatchObject({
      harness: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });
});

describe("tableRoute (rows Uno or the assistant set)", () => {
  const content = table(
    [
      "| Quick questions | self | — | — | default | |",
      "| Hard bugs | claudeAgent | claude-opus-5-5 | max | default | |",
      "| Simple tasks | codex | gpt-5.5 | medium | learned | |",
      "| Anything with UI | claudeAgent | claude-opus-5-5 | high | you | |",
    ].join("\n"),
  );

  it("the row the task type names, default or learned", () => {
    expect(tableRoute(content, "hard bugs")).toEqual({
      harness: "claudeAgent",
      model: "claude-opus-5-5",
      thinking: "max",
      taskType: "Hard bugs",
    });
    expect(tableRoute(content, "Simple tasks")).toMatchObject({ harness: "codex" });
  });

  it("no task type, `self` rows and the person's rows: nothing", () => {
    expect(tableRoute(content)).toBeNull();
    expect(tableRoute(content, "Quick questions")).toBeNull();
    expect(tableRoute(content, "Anything with UI")).toBeNull();
  });
});
