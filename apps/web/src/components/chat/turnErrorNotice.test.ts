import { describe, expect, it } from "vitest";

import { BUSY_DEFAULT_RETRY_SECONDS, classifyTurnError } from "./turnErrorNotice";

describe("classifyTurnError", () => {
  it("knows the gateway's 'AI is busy' in its new and old wording", () => {
    expect(
      classifyTurnError(
        "Uno AI is busy for you: 6 AI requests are already running. Retry after 10 s (Retry-After header), or run fewer agents in parallel.",
      ),
    ).toEqual({ kind: "busy", retryAfterSeconds: 10 });
    expect(
      classifyTurnError(
        "Too many AI requests are running on this account at once. Wait a moment and retry, or run fewer agents in parallel.",
      ),
    ).toEqual({ kind: "busy", retryAfterSeconds: BUSY_DEFAULT_RETRY_SECONDS });
    expect(classifyTurnError('{"error":{"code":"ai_busy","retry_after":25}}')).toEqual({
      kind: "busy",
      retryAfterSeconds: 25,
    });
    expect(classifyTurnError("429 Too Many Requests").kind).toBe("busy");
    expect(classifyTurnError("Provider returned error: overloaded_error").kind).toBe("busy");
  });

  it("caps a silly wait", () => {
    expect(classifyTurnError("Uno AI is busy for you. Retry after 999 s").retryAfterSeconds).toBe(
      120,
    );
  });

  it("knows 'the model didn't answer'", () => {
    expect(classifyTurnError("Uno AI didn't answer in time — try again.").kind).toBe("no-answer");
    expect(classifyTurnError("upstream timed out").kind).toBe("no-answer");
    expect(classifyTurnError("502 Bad Gateway").kind).toBe("no-answer");
  });

  it("tells the person's own subscription limit apart from 'busy'", () => {
    const codex = classifyTurnError(
      "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:42 PM.",
    );
    expect(codex).toEqual({
      kind: "subscription-limit",
      retryAfterSeconds: 0,
      resetsAt: "3:42 PM",
    });
    expect(classifyTurnError("5-hour limit reached ∙ resets 3pm")).toMatchObject({
      kind: "subscription-limit",
      resetsAt: "3pm",
    });
    expect(
      classifyTurnError(
        "Claude usage limit reached. Your limit will reset at 3pm (America/Buenos_Aires).",
      ),
    ).toMatchObject({ kind: "subscription-limit", resetsAt: "3pm" });
    expect(classifyTurnError("You've hit your limit · resets Oct 9, 5pm").resetsAt).toBe(
      "Oct 9, 5pm",
    );
    const epoch = classifyTurnError("Claude AI usage limit reached|1760032800");
    expect(epoch.kind).toBe("subscription-limit");
    expect(epoch.resetsAt).toMatch(/\d/);
    expect(classifyTurnError('{"type":"usage_limit_reached"}')).toEqual({
      kind: "subscription-limit",
      retryAfterSeconds: 0,
    });
    // Uno's own busy line and a plain 429 stay "busy".
    expect(classifyTurnError("Rate limit exceeded, try again in 20 s").kind).toBe("busy");
  });

  it("leaves everything else alone", () => {
    expect(classifyTurnError("Provider session did not survive a server restart.").kind).toBe(
      "other",
    );
    expect(classifyTurnError("Port 4290 is busy").kind).toBe("other");
    expect(classifyTurnError("ENOENT: no such file or directory").kind).toBe("other");
  });
});
