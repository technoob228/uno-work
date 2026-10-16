import { afterEach, describe, expect, it, vi } from "vitest";

import { accountRequest, resetAccountAuthMeCache } from "./unoAccount";

const ME = { id: 7, username: "qa", email: "qa@example.com" };

function stubWorkProxy(fetchImpl: () => Promise<Response>) {
  vi.stubGlobal("window", { location: { hostname: "abc123.uno4.work" } });
  const fetchMock = vi.fn(fetchImpl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  resetAccountAuthMeCache();
  vi.unstubAllGlobals();
});

describe("accountRequest GET /auth/me", () => {
  it("serves parallel callers from one request", async () => {
    const fetchMock = stubWorkProxy(async () => new Response(JSON.stringify(ME), { status: 200 }));
    const answers = await Promise.all([1, 2, 3, 4].map(() => accountRequest("GET", "/auth/me")));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const me of answers) expect(me).toEqual(ME);
    // Each caller has its own copy.
    expect(answers[0]).not.toBe(answers[1]);
  });

  it("asks again after a refusal", async () => {
    let calls = 0;
    const fetchMock = stubWorkProxy(async () => {
      calls += 1;
      return calls === 1
        ? new Response("{}", { status: 503 })
        : new Response(JSON.stringify(ME), { status: 200 });
    });
    await expect(accountRequest("GET", "/auth/me")).rejects.toThrow();
    await expect(accountRequest("GET", "/auth/me")).resolves.toEqual(ME);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leaves other requests alone", async () => {
    const fetchMock = stubWorkProxy(async () => new Response("[]", { status: 200 }));
    await Promise.all([accountRequest("GET", "/api/v1/boxes"), accountRequest("GET", "/api/v1/boxes")]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
