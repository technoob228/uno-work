import { describe, expect, it } from "vitest";

import {
  buildHermesHandoffPrompt,
  HERMES_HANDOFF_MAX_CONVERSATION_CHARS,
  selectHandoffHistory,
} from "./hermesHandoff.ts";

describe("hermes handoff", () => {
  it("returns the message unchanged when there is nothing to carry", () => {
    expect(
      buildHermesHandoffPrompt({
        currentText: "hello",
        contextMessages: [{ role: "user", text: "hello" }],
        notes: null,
      }),
    ).toBe("hello");
  });

  it("carries the visible chat and NOTES.md into the first prompt of a fresh session", () => {
    const prompt = buildHermesHandoffPrompt({
      currentText: "what did I ask you yesterday?",
      contextMessages: [
        { role: "user", text: "remind me to call Anna" },
        { role: "assistant", text: "Done — reminder set for 10:00." },
        { role: "system", text: "internal" },
        { role: "user", text: "what did I ask you yesterday?" },
      ],
      notes: "# Assistant notes\n- 2026-09-23: reminder for Anna",
    });
    expect(prompt).toContain("Person: remind me to call Anna");
    expect(prompt).toContain("You: Done — reminder set for 10:00.");
    expect(prompt).not.toContain("internal");
    expect(prompt).toContain("<notes_md>\n# Assistant notes");
    expect(prompt.endsWith("Current message:\nwhat did I ask you yesterday?")).toBe(true);
    // The current message is not repeated as history.
    expect(prompt.match(/what did I ask you yesterday\?/g)).toHaveLength(1);
  });

  it("keeps the newest messages within budget", () => {
    const long = "x".repeat(3_000);
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `${index} ${long}`,
    }));
    const history = selectHandoffHistory(messages, "now");
    const total = history.reduce((sum, entry) => sum + entry.text.length, 0);
    expect(total).toBeLessThanOrEqual(HERMES_HANDOFF_MAX_CONVERSATION_CHARS);
    expect(history.at(-1)?.text.startsWith("19 ")).toBe(true);
  });
});
