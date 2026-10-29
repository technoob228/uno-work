import { describe, expect, it } from "vitest";

import { type WorkLogEntry } from "../../session-logic";
import {
  liveThoughtFromReasoningTail,
  liveThoughtLine,
  summarizeToolGroup,
  toolGroupAction,
} from "./workLogSummary";

let sequence = 0;
function entry(overrides: Partial<WorkLogEntry>): WorkLogEntry {
  sequence += 1;
  return {
    id: `entry-${sequence}`,
    createdAt: "2026-10-29T10:00:00.000Z",
    label: "Tool call",
    tone: "tool",
    ...overrides,
  };
}

const read = (path: string) =>
  entry({
    itemType: "dynamic_tool_call",
    toolName: "Read",
    detail: `Read: {"file_path":"${path}"}`,
  });
const command = (cmd: string) => entry({ itemType: "command_execution", command: cmd });
const edit = (...files: string[]) => entry({ itemType: "file_change", changedFiles: files });

describe("toolGroupAction", () => {
  it("knows the harnesses' read and search tools by name", () => {
    expect(toolGroupAction(read("a.ts"))).toBe("read");
    expect(toolGroupAction(entry({ itemType: "dynamic_tool_call", toolName: "read" }))).toBe(
      "read",
    );
    expect(toolGroupAction(entry({ itemType: "dynamic_tool_call", toolName: "grep" }))).toBe(
      "code-search",
    );
    expect(toolGroupAction(entry({ itemType: "dynamic_tool_call", toolName: "Glob" }))).toBe(
      "code-search",
    );
    // Claude: the name only in the detail.
    expect(
      toolGroupAction(entry({ itemType: "dynamic_tool_call", detail: 'Grep: {"pattern":"x"}' })),
    ).toBe("code-search");
  });

  it("reads approvals, commands, edits and web tools", () => {
    expect(toolGroupAction(entry({ requestKind: "file-read" }))).toBe("read");
    expect(toolGroupAction(command("npm test"))).toBe("command");
    expect(toolGroupAction(edit("a.ts"))).toBe("edit");
    expect(toolGroupAction(entry({ itemType: "web_search", toolName: "websearch" }))).toBe(
      "search",
    );
    expect(toolGroupAction(entry({ itemType: "web_search", toolName: "webfetch" }))).toBe("browse");
    expect(toolGroupAction(entry({ itemType: "collab_agent_tool_call" }))).toBe("delegate");
    expect(toolGroupAction(entry({ itemType: "mcp_tool_call", label: "Published the site" }))).toBe(
      "other",
    );
  });
});

describe("summarizeToolGroup", () => {
  it("joins the kinds in the order they first appear", () => {
    expect(
      summarizeToolGroup([
        read("a.ts"),
        command("npm test"),
        read("b.ts"),
        read("c.ts"),
        command("npm run lint"),
      ]).summary,
    ).toBe("Read 3 files and ran 2 commands");
  });

  it("uses a serial comma for three kinds", () => {
    expect(summarizeToolGroup([read("a.ts"), edit("a.ts"), command("bun test")]).summary).toBe(
      "Read 1 file, changed 1 file, and ran 1 command",
    );
  });

  it("counts changed files once across edits", () => {
    expect(summarizeToolGroup([edit("a.ts", "b.ts"), edit("a.ts"), edit()]).summary).toBe(
      "Changed 3 files",
    );
  });

  it("folds kinds past the third into other steps", () => {
    expect(
      summarizeToolGroup([
        read("a.ts"),
        edit("a.ts"),
        command("x"),
        entry({ itemType: "web_search", toolName: "websearch" }),
        entry({ itemType: "web_search", toolName: "websearch" }),
      ]).summary,
    ).toBe("Read 1 file, changed 1 file, ran 1 command, and 2 other steps");
  });

  it("names a lone plain-words tool call by its own line", () => {
    expect(
      summarizeToolGroup([
        read("a.ts"),
        entry({ itemType: "mcp_tool_call", label: "Published the site" }),
      ]).summary,
    ).toBe("Read 1 file and published the site");
    expect(
      summarizeToolGroup([
        entry({ itemType: "mcp_tool_call", label: "Published the site" }),
        entry({ itemType: "mcp_tool_call", label: "Listed your apps" }),
      ]).summary,
    ).toBe("Used 2 tools");
  });

  it("leaves reasoning rows out, and calls a run of only them a thought", () => {
    const thought = entry({ tone: "thinking", label: "Thinking it through" });
    expect(summarizeToolGroup([thought, read("a.ts")]).summary).toBe("Read 1 file");
    expect(summarizeToolGroup([thought])).toEqual({ summary: "Thought", hasFailure: false });
    // Notes about the run (an approval asked, context compacted) are not steps either.
    const note = entry({ tone: "info", label: "Waiting for your OK", requestKind: "command" });
    expect(summarizeToolGroup([read("a.ts"), note]).summary).toBe("Read 1 file");
  });

  it("marks a failed step", () => {
    expect(
      summarizeToolGroup([
        command("npm test"),
        entry({ itemType: "command_execution", command: "npm run build", tone: "error" }),
      ]),
    ).toEqual({ summary: "Ran 2 commands", hasFailure: true });
  });
});

// Upstream 95ccbf4066 presentation.test.ts, verbatim.
describe("liveThoughtLine", () => {
  it("keeps the first sentence, including a closing quote", () => {
    expect(
      liveThoughtLine(
        'Found the cause: the repo has no commits, so `git worktree add` fails with "invalid reference: main." Now checking the UI.',
      ),
    ).toBe(
      'Found the cause: the repo has no commits, so git worktree add fails with "invalid reference: main."',
    );
  });

  it("does not cut at dots inside file names or long dashes", () => {
    expect(liveThoughtLine("I read ThreadLaunchService.ts — it skips the fetch. Next step.")).toBe(
      "I read ThreadLaunchService.ts — it skips the fetch.",
    );
  });

  it("uses a bold-only opening line as the whole line", () => {
    expect(
      liveThoughtLine("**Narrowing dispatch files**\n\nI should check the adapter. Then more."),
    ).toBe("Narrowing dispatch files");
    expect(liveThoughtLine("**Narrowing dispatch files**\r\n\r\nI should check the adapter.")).toBe(
      "Narrowing dispatch files",
    );
  });

  it("returns unpunctuated text whole and flattens markdown", () => {
    expect(liveThoughtLine("- Checking [the docs](https://x.dev) for **limits**")).toBe(
      "Checking the docs for limits",
    );
    expect(liveThoughtLine("This is *really* ~~not~~ _fine_ in snake_case_names.")).toBe(
      "This is really not fine in snake_case_names.",
    );
    expect(liveThoughtLine("   ")).toBe("");
  });
});

describe("liveThoughtFromReasoningTail", () => {
  it("takes the last whole sentence of the reasoning's end", () => {
    expect(
      liveThoughtFromReasoningTail(
        "…of the signup form. The handler never calls sendMail. Now I check the mail settings.",
      ),
    ).toBe("Now I check the mail settings.");
  });

  it("skips an unfinished last sentence and the cut first one", () => {
    expect(
      liveThoughtFromReasoningTail(
        "…the form posts to /api/signup. The route exists but returns early. So the next thing to",
      ),
    ).toBe("The route exists but returns early.");
  });

  it("shows a tail with no sentence end as it is", () => {
    expect(liveThoughtFromReasoningTail("Looking at how the form submits its data")).toBe(
      "Looking at how the form submits its data",
    );
    expect(liveThoughtFromReasoningTail("  ")).toBe("");
  });
});
