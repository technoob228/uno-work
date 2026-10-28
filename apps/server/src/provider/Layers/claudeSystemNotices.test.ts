import { describe, expect, it } from "vitest";

import {
  CLAUDE_QUIET_SYSTEM_SUBTYPES,
  describeClaudeSystemMessage,
} from "./claudeSystemNotices.ts";

/**
 * P11 (cap walkthrough 28.10): "Hi" in a project left four "Runtime warning"
 * rows. These are the subtypes a real Mac's Work log collected (state.sqlite,
 * 28.10) — none of them is for the person.
 */
describe("Claude Code status messages in the Work log", () => {
  it("keeps Claude Code's bookkeeping out of it", () => {
    for (const subtype of [
      "vcs_state_changed",
      "task_updated",
      "background_tasks_changed",
      "code_change_published",
      "commands_changed",
      "session_state_changed",
    ]) {
      expect(describeClaudeSystemMessage({ type: "system", subtype })).toEqual({
        kind: "quiet",
        known: true,
      });
      expect(CLAUDE_QUIET_SYSTEM_SUBTYPES.has(subtype)).toBe(true);
    }
  });

  it("keeps a subtype newer than Work out of it too", () => {
    expect(describeClaudeSystemMessage({ type: "system", subtype: "something_new" })).toEqual({
      kind: "quiet",
      known: false,
    });
  });

  it("says in plain words that Claude is retrying a busy API", () => {
    expect(
      describeClaudeSystemMessage({
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 1000,
        error_status: 529,
      }),
    ).toEqual({ kind: "notice", summary: "Claude's servers are busy — trying again (2 of 10)" });
  });

  it("names the model Claude fell back to", () => {
    expect(
      describeClaudeSystemMessage({
        type: "system",
        subtype: "model_refusal_fallback",
        original_model: "claude-opus-5-5",
        fallback_model: "claude-sonnet-5-5",
      }),
    ).toEqual({ kind: "notice", summary: "Claude answered this one with claude-sonnet-5-5" });
  });

  it("says which tool wasn't allowed, on one line", () => {
    const notice = describeClaudeSystemMessage({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      message: "rm -rf /\nwas blocked by the auto-mode classifier",
    });
    expect(notice).toEqual({
      kind: "notice",
      summary: "Not allowed to run Bash: rm -rf / was blocked by the auto-mode classifier",
    });
  });

  it("shows Claude's own warnings and loud notifications, not the rest", () => {
    expect(
      describeClaudeSystemMessage({
        type: "system",
        subtype: "informational",
        level: "warning",
        content: "Context is almost full",
      }),
    ).toEqual({ kind: "notice", summary: "Context is almost full" });
    expect(
      describeClaudeSystemMessage({
        type: "system",
        subtype: "informational",
        level: "suggestion",
        content: "Try /compact",
      }).kind,
    ).toBe("quiet");
    expect(
      describeClaudeSystemMessage({
        type: "system",
        subtype: "notification",
        priority: "low",
        text: "Synced",
      }).kind,
    ).toBe("quiet");
    expect(
      describeClaudeSystemMessage({
        type: "system",
        subtype: "notification",
        priority: "high",
        text: "Usage limit reached",
      }),
    ).toEqual({ kind: "notice", summary: "Usage limit reached" });
  });

  it("cuts a long line", () => {
    const notice = describeClaudeSystemMessage({
      type: "system",
      subtype: "informational",
      level: "warning",
      content: "x".repeat(400),
    });
    expect(notice.kind === "notice" && notice.summary.length).toBe(160);
  });
});
