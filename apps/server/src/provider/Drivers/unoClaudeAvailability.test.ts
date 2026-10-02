import { describe, expect, it } from "vitest";

import {
  UNO_CLAUDE_AVAILABILITY_TTL_MS,
  makeUnoClaudeAvailability,
} from "./unoClaudeAvailability.ts";

function fakeFetch(answers: Array<unknown | Error>) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, doFetch };
}

describe("makeUnoClaudeAvailability", () => {
  it("a trial plan has no Claude on Uno AI; asks once per TTL", async () => {
    let now = 1_000;
    const { calls, doFetch } = fakeFetch([{ plan: "work-trial" }, { plan: "plus-ai" }]);
    const available = makeUnoClaudeAvailability({
      baseUrl: "https://gw/v1",
      key: "unollm_x",
      fetch: doFetch,
      now: () => now,
    });
    expect(await available()).toBe(false);
    expect(await available()).toBe(false);
    expect(calls).toEqual([{ url: "https://gw/v1/ai/status", auth: "Bearer unollm_x" }]);
    // Upgraded: picked up after the TTL.
    now += UNO_CLAUDE_AVAILABILITY_TTL_MS + 1;
    expect(await available()).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("an unreachable gateway keeps it allowed (as before the check)", async () => {
    const { doFetch } = fakeFetch([new Error("offline")]);
    const available = makeUnoClaudeAvailability({
      baseUrl: "https://gw/v1",
      key: "k",
      fetch: doFetch,
    });
    expect(await available()).toBe(true);
  });
});
