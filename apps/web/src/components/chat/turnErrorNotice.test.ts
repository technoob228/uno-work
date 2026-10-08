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

  it("leaves everything else alone", () => {
    expect(classifyTurnError("Provider session did not survive a server restart.").kind).toBe(
      "other",
    );
    expect(classifyTurnError("Port 4290 is busy").kind).toBe("other");
    expect(classifyTurnError("ENOENT: no such file or directory").kind).toBe("other");
  });
});
