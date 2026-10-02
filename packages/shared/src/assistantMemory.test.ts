import { describe, expect, it } from "vitest";

import {
  addNote,
  editNote,
  parseNotes,
  parseRouting,
  rebaseEdit,
  removeLine,
  ROUTING_PERSON_RULE,
  thinkingOf,
  thinkingOption,
  writeRouting,
  type RoutingRule,
} from "./assistantMemory.ts";

const NOTES = [
  "# Assistant notes",
  "",
  "- 2026-10-02 Ship assistants in 0.0.106 (you)",
  "- 2026-10-02 14:05 — CSV export: thread abc running",
  "* plain line without a date",
  "not a bullet",
  "",
].join("\n");

describe("notes", () => {
  it("parses dated lines, the (you) mark and plain bullets", () => {
    expect(parseNotes(NOTES)).toEqual([
      { line: 2, text: "Ship assistants in 0.0.106", date: "2026-10-02", fromPerson: true },
      { line: 3, text: "CSV export: thread abc running", date: "2026-10-02", fromPerson: false },
      { line: 4, text: "plain line without a date", date: null, fromPerson: false },
    ]);
  });

  it("adds a note from the person as one dated line", () => {
    const next = addNote(NOTES, "No colored\nstripes (you)", "2026-10-03");
    expect(next.endsWith("- 2026-10-03 No colored stripes (you)\n")).toBe(true);
    expect(addNote("", "x", "2026-10-03")).toBe("# Assistant notes\n- 2026-10-03 x (you)\n");
    expect(addNote(NOTES, "   ", "2026-10-03")).toBe(NOTES);
  });

  it("edits a note: keeps its date, marks it as the person's; empty removes it", () => {
    const edited = editNote(NOTES, 3, "CSV export is done", "2026-10-03");
    expect(edited.split("\n")[3]).toBe("- 2026-10-02 CSV export is done (you)");
    expect(editNote(NOTES, 4, "dated now", "2026-10-03").split("\n")[4]).toBe(
      "- 2026-10-03 dated now (you)",
    );
    expect(editNote(NOTES, 5, "x", "2026-10-03")).toBe(NOTES);
    expect(editNote(NOTES, 2, "", "2026-10-03")).toBe(removeLine(NOTES, 2));
  });
});

describe("rebaseEdit", () => {
  const base = "# Notes\n- a\n- b\n";

  it("returns mine when nobody else wrote, theirs when I changed nothing", () => {
    expect(rebaseEdit(base, "# Notes\n- a\n", base)).toBe("# Notes\n- a\n");
    expect(rebaseEdit(base, base, "# Notes\n- a\n- b\n- c\n")).toBe("# Notes\n- a\n- b\n- c\n");
  });

  it("keeps the assistant's new line when the person removes another", () => {
    const mine = "# Notes\n- a\n";
    const theirs = "# Notes\n- a\n- b\n- c (assistant)\n";
    expect(rebaseEdit(base, mine, theirs)).toBe("# Notes\n- a\n- c (assistant)\n");
  });

  it("keeps both appended lines", () => {
    const mine = "# Notes\n- a\n- b\n- mine\n";
    const theirs = "# Notes\n- a\n- b\n- theirs\n";
    expect(rebaseEdit(base, mine, theirs)).toBe("# Notes\n- a\n- b\n- mine\n- theirs\n");
  });

  it("an edited line replaces the old one and keeps its place", () => {
    const mine = "# Notes\n- a!\n- b\n";
    const theirs = "# Notes\n- a\n- b\n- c\n";
    expect(rebaseEdit(base, mine, theirs)).toBe("# Notes\n- a!\n- b\n- c\n");
  });

  it("a line both changed ends up twice rather than lost", () => {
    const mine = "# Notes\n- a (mine)\n- b\n";
    const theirs = "# Notes\n- a (theirs)\n- b\n";
    expect(rebaseEdit(base, mine, theirs)).toBe("# Notes\n- a (mine)\n- a (theirs)\n- b\n");
  });
});

const ROUTING = `# Routing table — which harness/model for which task

Starting point, hand-tuned.

| Task type | Harness (instanceId) | Model | Effort | Why |
|---|---|---|---|---|
| Architecture | claudeAgent | claude-opus-5-5 | high | strongest |
| Routine fixes | codex | gpt-5.4 | reasoningEffort: low | cheap |

Notes:
- Effort keys differ per harness.

## Outcomes log

<!-- date | task type | harness/model/effort | ok/failed/escalated | evidence/note -->
- 2026-10-02 | Routine fixes | codex/gpt-5.4/low | ok | tests pass
2026-10-02 | UI | claudeAgent/sonnet/medium | failed | redone on opus
`;

describe("routing", () => {
  it("reads an old five-column table (no Source) and the outcomes log", () => {
    const parsed = parseRouting(ROUTING);
    expect(parsed.hasTable).toBe(true);
    expect(parsed.rules).toEqual([
      {
        taskType: "Architecture",
        harness: "claudeAgent",
        model: "claude-opus-5-5",
        effort: "high",
        source: "default",
        note: "strongest",
      },
      {
        taskType: "Routine fixes",
        harness: "codex",
        model: "gpt-5.4",
        effort: "reasoningEffort: low",
        source: "default",
        note: "cheap",
      },
    ]);
    expect(parsed.outcomes).toEqual([
      { text: "2026-10-02 · Routine fixes · codex/gpt-5.4/low · ok · tests pass", ok: true },
      {
        text: "2026-10-02 · UI · claudeAgent/sonnet/medium · failed · redone on opus",
        ok: false,
      },
    ]);
  });

  it("writes the six-column table in place, keeps the rest, adds the person rule once", () => {
    const rules: RoutingRule[] = [
      {
        taskType: "Anything with UI",
        harness: "claudeAgent",
        model: "claude-opus-5-5",
        effort: "high",
        source: "you",
        note: "a | pipe",
      },
    ];
    const next = writeRouting(ROUTING, rules);
    expect(next).toContain("| Task type | Harness | Model | Effort | Source | Why |");
    expect(next).toContain(
      "| Anything with UI | claudeAgent | claude-opus-5-5 | high | you | a / pipe |",
    );
    expect(next).not.toContain("| Architecture |");
    expect(next).toContain("## Outcomes log");
    expect(next).toContain("- Effort keys differ per harness.");
    expect(next.split(ROUTING_PERSON_RULE).length).toBe(2);
    expect(writeRouting(next, rules)).toBe(next);
    expect(parseRouting(next).rules).toEqual([{ ...rules[0], note: "a / pipe" }]);
  });

  it("adds a table to a file without one", () => {
    const next = writeRouting("# Routing\n\nfree text\n", [
      { taskType: "x", harness: "self", model: "", effort: "", source: "you", note: "" },
    ]);
    expect(parseRouting(next).rules).toHaveLength(1);
    expect(next.startsWith("# Routing\n")).toBe(true);
    expect(next).toContain("free text");
  });

  it("maps thinking words to harness options", () => {
    expect(thinkingOf("reasoningEffort: low")).toBe("low");
    expect(thinkingOf("xhigh")).toBe("max");
    expect(thinkingOf("high")).toBe("high");
    expect(thinkingOf("default")).toBeNull();
    expect(thinkingOption("claudeAgent", "max")).toEqual({ id: "effort", value: "max" });
    expect(thinkingOption("codex", "max")).toEqual({ id: "reasoningEffort", value: "xhigh" });
    expect(thinkingOption("uno", "high")).toBeNull();
  });
});
