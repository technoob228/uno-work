import { describe, expect, it } from "vitest";

import { UNO_WORK_NOTE_PREFIX, parseUnoWorkNote } from "./secretRequestCopy.ts";
import {
  BUSY_DEFAULT_RETRY_SECONDS,
  NO_ANSWER_RETRY_DELAYS_MS,
  TURN_AUTO_RETRY_MAX_ATTEMPTS,
  classifyTurnError,
  decideTurnAutoRetry,
  turnAutoRetryNoteBody,
  turnAutoRetryNoteLine,
} from "./turnErrorRetry.ts";

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
    // The gateway's in-stream SSE error chunk, as opencode reports it.
    expect(
      classifyTurnError(
        '{"message":"Uno AI didn\'t answer in time — try again.","type":"upstream_timeout","code":"upstream_timeout"}',
      ).kind,
    ).toBe("no-answer");
    expect(classifyTurnError('{"code":"upstream_timeout"}').kind).toBe("no-answer");
  });

  it("knows 'Uno AI stopped answering' (a broken stream), as the person reads it and as raw JSON", () => {
    expect(classifyTurnError(STOPPED_ANSWERING).kind).toBe("no-answer");
    expect(
      classifyTurnError(
        '{"message":"Uno AI stopped answering — try again.","type":"upstream_error","code":"upstream_error"}',
      ).kind,
    ).toBe("no-answer");
    // A provider's refusal relayed as upstream_error is not a broken stream.
    expect(
      classifyTurnError('{"error":{"message":"Invalid model","type":"upstream_error","code":400}}')
        .kind,
    ).toBe("other");
  });

  it("leaves everything else alone", () => {
    expect(classifyTurnError("Provider session did not survive a server restart.").kind).toBe(
      "other",
    );
    expect(classifyTurnError("Port 4290 is busy").kind).toBe("other");
    expect(classifyTurnError("ENOENT: no such file or directory").kind).toBe("other");
  });
});

const UPSTREAM_TIMEOUT = "Uno AI didn't answer in time — try again.";
const STOPPED_ANSWERING = "Uno AI stopped answering — try again.";

describe("decideTurnAutoRetry", () => {
  it("continues a turn the model didn't answer: 15 s, then 45 s, then the person decides", () => {
    expect(decideTurnAutoRetry({ error: UPSTREAM_TIMEOUT, attemptsUsed: 0 })).toEqual({
      retry: true,
      kind: "no-answer",
      attempt: 1,
      maxAttempts: TURN_AUTO_RETRY_MAX_ATTEMPTS,
      delayMs: 15_000,
    });
    expect(decideTurnAutoRetry({ error: "502 Bad Gateway", attemptsUsed: 1 })).toMatchObject({
      retry: true,
      attempt: 2,
      delayMs: 45_000,
    });
    expect(decideTurnAutoRetry({ error: UPSTREAM_TIMEOUT, attemptsUsed: 2 })).toEqual({
      retry: false,
      reason: "attempts-used",
    });
    expect(NO_ANSWER_RETRY_DELAYS_MS).toHaveLength(TURN_AUTO_RETRY_MAX_ATTEMPTS);
  });

  it("continues a broken stream the same way, within the same limit (Misha 29.10)", () => {
    expect(decideTurnAutoRetry({ error: STOPPED_ANSWERING, attemptsUsed: 0 })).toEqual({
      retry: true,
      kind: "no-answer",
      attempt: 1,
      maxAttempts: TURN_AUTO_RETRY_MAX_ATTEMPTS,
      delayMs: 15_000,
    });
    expect(decideTurnAutoRetry({ error: STOPPED_ANSWERING, attemptsUsed: 1 })).toMatchObject({
      retry: true,
      attempt: 2,
      delayMs: 45_000,
    });
    expect(decideTurnAutoRetry({ error: STOPPED_ANSWERING, attemptsUsed: 2 })).toEqual({
      retry: false,
      reason: "attempts-used",
    });
  });

  it("waits as long as a busy gateway asks", () => {
    expect(
      decideTurnAutoRetry({ error: "Uno AI is busy for you. Retry after 25 s", attemptsUsed: 0 }),
    ).toMatchObject({ retry: true, kind: "busy", attempt: 1, delayMs: 25_000 });
    expect(decideTurnAutoRetry({ error: "429 Too Many Requests", attemptsUsed: 1 })).toMatchObject({
      retry: true,
      kind: "busy",
      attempt: 2,
      delayMs: BUSY_DEFAULT_RETRY_SECONDS * 1_000,
    });
  });

  it("never retries billing, sign-in or anything else", () => {
    for (const error of [
      "Your AI hours are used up. Top up at https://console.uno4.dev/billing",
      "HTTP 402: insufficient_credits",
      "Not signed in. Run codex login.",
      "Provider session did not survive a server restart. Send a new message to continue.",
      "ENOENT: no such file or directory",
    ]) {
      expect(decideTurnAutoRetry({ error, attemptsUsed: 0 })).toEqual({
        retry: false,
        reason: "not-retryable",
      });
    }
  });
});

describe("auto-retry note", () => {
  it("reads as one calm line in the chat, with the attempt", () => {
    const body = turnAutoRetryNoteBody({ kind: "no-answer", attempt: 1, maxAttempts: 2 });
    expect(body).toContain("Continue the task from where you stopped");
    expect(parseUnoWorkNote(`${UNO_WORK_NOTE_PREFIX}${body}`)).toEqual({
      kind: "auto-retry",
      text: "Uno AI didn't answer — trying again automatically (1 of 2)…",
    });
    expect(
      turnAutoRetryNoteLine(turnAutoRetryNoteBody({ kind: "busy", attempt: 2, maxAttempts: 2 })),
    ).toBe("Uno AI was busy — trying again automatically (2 of 2)…");
  });

  it("is not mistaken for an error to retry", () => {
    const body = turnAutoRetryNoteBody({ kind: "no-answer", attempt: 1, maxAttempts: 2 });
    expect(classifyTurnError(body).kind).toBe("other");
    expect(turnAutoRetryNoteLine("Continue please")).toBeNull();
  });
});
