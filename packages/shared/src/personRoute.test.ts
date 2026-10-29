import { describe, expect, it } from "vitest";

import { personRoute } from "./assistantMemory.ts";

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
