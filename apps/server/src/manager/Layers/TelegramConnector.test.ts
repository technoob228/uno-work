import { describe, expect, it } from "@effect/vitest";
import { TurnId } from "@t3tools/contracts";

import {
  resolveTurnReply,
  stripHandoffPreamble,
  type TurnReplyInputs,
} from "./TelegramConnector.ts";

const requestedAtIso = "2026-07-03T23:02:48.101Z";

const turnRow = (
  overrides: Partial<TurnReplyInputs["turns"][number]>,
): TurnReplyInputs["turns"][number] => ({
  turnId: TurnId.make("turn-1"),
  state: "completed",
  requestedAt: requestedAtIso,
  ...overrides,
});

const assistantMessage = (text: string, createdAt: string) => ({
  role: "assistant",
  text,
  streaming: false,
  createdAt,
});

describe("resolveTurnReply", () => {
  it("waits while the turn is still running", () => {
    expect(
      resolveTurnReply({
        turns: [turnRow({ state: "running" })],
        messages: [],
        sessionStatus: "ready",
        requestedAtIso,
      }),
    ).toBeNull();
  });

  it("waits while no concrete turn row exists yet (pending placeholder only)", () => {
    expect(
      resolveTurnReply({
        turns: [turnRow({ turnId: null, state: "pending" })],
        messages: [],
        sessionStatus: "ready",
        requestedAtIso,
      }),
    ).toBeNull();
  });

  it("sends the assistant answer once the turn row is terminal, even though the thread shell no longer points at it", () => {
    // Regression: `projection_threads.latest_turn_id` is nulled when the
    // session goes idle, so the reply must be derived from the turn rows.
    const reply = resolveTurnReply({
      turns: [turnRow({ state: "completed" })],
      messages: [
        assistantMessage("the answer", "2026-07-03T23:03:39.350Z"),
      ],
      sessionStatus: "ready",
      requestedAtIso,
    });
    expect(reply).toEqual({ text: "the answer", files: [] });
  });

  it("extracts [[send-file: …]] markers into the files list and strips them from the text", () => {
    const reply = resolveTurnReply({
      turns: [turnRow({ state: "completed" })],
      messages: [
        assistantMessage(
          "Here is the report.\n\n[[send-file: /tmp/report.pdf]]\n[[send-file: /tmp/chart.png]]",
          "2026-07-03T23:03:39.350Z",
        ),
      ],
      sessionStatus: "ready",
      requestedAtIso,
    });
    expect(reply).toEqual({
      text: "Here is the report.",
      files: ["/tmp/report.pdf", "/tmp/chart.png"],
    });
  });

  it("ignores turn rows and messages from before this request", () => {
    const reply = resolveTurnReply({
      turns: [
        turnRow({
          turnId: TurnId.make("turn-0"),
          state: "completed",
          requestedAt: "2026-07-03T22:51:55.930Z",
        }),
      ],
      messages: [assistantMessage("stale answer", "2026-07-03T22:52:13.378Z")],
      sessionStatus: "ready",
      requestedAtIso,
    });
    expect(reply).toBeNull();
  });

  it("reports a dead session mid-turn, forwarding partial output when present", () => {
    const partial = resolveTurnReply({
      turns: [turnRow({ state: "running" })],
      messages: [assistantMessage("partial answer", "2026-07-03T23:03:00.000Z")],
      sessionStatus: "stopped",
      requestedAtIso,
    });
    expect(partial).toEqual({ text: "partial answer", files: [] });

    const bare = resolveTurnReply({
      turns: [turnRow({ state: "running" })],
      messages: [],
      sessionStatus: "error",
      requestedAtIso,
    });
    expect(bare).toEqual({
      text: "The harness session ended before finishing this turn; check the app for details.",
      files: [],
    });
  });

  it("reports the terminal state when the turn produced no assistant text", () => {
    const reply = resolveTurnReply({
      turns: [turnRow({ state: "error" })],
      messages: [],
      sessionStatus: "ready",
      requestedAtIso,
    });
    expect(reply).toEqual({ text: "Turn finished with state: error.", files: [] });
  });

  it("strips an inherited handoff preamble so preambles never nest", () => {
    const preambled = [
      "[Context: this Telegram chat previously ran in another thread (the harness/model was switched). Recent history, oldest first:]",
      "User: earlier question",
      "Assistant: earlier answer",
      "[End of context. Reply to the message below.]",
      "",
      "the actual question",
    ].join("\n");
    expect(stripHandoffPreamble(preambled)).toBe("the actual question");
    expect(stripHandoffPreamble("plain message")).toBe("plain message");
  });

  it("truncates oversized answers to the Telegram limit", () => {
    const reply = resolveTurnReply({
      turns: [turnRow({ state: "completed" })],
      messages: [assistantMessage("x".repeat(5000), "2026-07-03T23:03:39.350Z")],
      sessionStatus: "ready",
      requestedAtIso,
    });
    expect(reply?.text).toHaveLength(4000);
  });
});
