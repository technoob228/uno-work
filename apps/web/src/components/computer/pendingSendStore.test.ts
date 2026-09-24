import { describe, expect, it } from "vitest";

import type { DraftId } from "../../composerDraftStore";
import { PENDING_SEND_TTL_MS, pendingSendDecision, type PendingSend } from "./pendingSendStore";

const draft = "draft-1" as DraftId;
const NOW = 1_000_000;
const pending: PendingSend = { draftId: draft, prompt: "Sort my inbox", requestedAt: NOW };

describe("pendingSendDecision", () => {
  const base = { draftId: draft, composerPrompt: "Sort my inbox", ready: true, now: NOW + 100 };

  it("sends its own fresh request once the composer holds the text", () => {
    expect(pendingSendDecision(pending, base)).toBe("send");
    expect(pendingSendDecision(pending, { ...base, composerPrompt: "  Sort my inbox\n" })).toBe(
      "send",
    );
  });

  it("ignores other chats and no request", () => {
    expect(pendingSendDecision(null, base)).toBe("ignore");
    expect(pendingSendDecision(pending, { ...base, draftId: "other" as DraftId })).toBe("ignore");
    expect(pendingSendDecision(pending, { ...base, draftId: null })).toBe("ignore");
  });

  it("waits while the chat isn't ready or the text hasn't arrived", () => {
    expect(pendingSendDecision(pending, { ...base, ready: false })).toBe("wait");
    expect(pendingSendDecision(pending, { ...base, composerPrompt: "" })).toBe("wait");
  });

  it("drops a stale request or one the person edited", () => {
    expect(pendingSendDecision(pending, { ...base, now: NOW + PENDING_SEND_TTL_MS + 1 })).toBe(
      "drop",
    );
    expect(pendingSendDecision(pending, { ...base, composerPrompt: "Sort my inbox today" })).toBe(
      "drop",
    );
  });
});
