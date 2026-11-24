import { describe, expect, it } from "vitest";

import { makePartsCache, makeTeamCloud, PARTS_FAILED_TTL_MS, TeamCloudError } from "./teamCloud.ts";
import {
  NO_PARTS,
  parseInbound,
  parseLevels,
  parseRequest,
  personName,
} from "./teamCloud.logic.ts";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(answer: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return answer(url, init);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const cloudWith = (answer: (url: string, init: RequestInit) => Response, token = "k") => {
  const fake = fakeFetch(answer);
  const cloud = makeTeamCloud({
    baseUrl: () => "https://cloud.test",
    token: async () => token,
    fetchImpl: fake.fetchImpl,
  });
  return { cloud, calls: fake.calls };
};

describe("the team routes", () => {
  it("reads what is on", async () => {
    const { cloud, calls } = cloudWith(() =>
      reply(200, { share: true, requests: true, agents: false, tasks: false }),
    );
    expect(await cloud.collab()).toEqual({
      share: true,
      requests: true,
      agents: false,
      tasks: false,
    });
    expect(calls[0]!.url).toBe("https://cloud.test/api/v1/work/team/collab");
  });

  it("sends a chat's events in snake_case", async () => {
    const { cloud, calls } = cloudWith(() => reply(200, { ok: true }));
    await cloud.postEvents(7, {
      source: "env-1",
      status: "running",
      events: [{ message_id: "m1", role: "user", text: "hi", at: "2026-11-20T10:00:00Z" }],
    });
    expect(calls[0]).toMatchObject({
      url: "https://cloud.test/api/v1/work/team/chats/7/events",
      method: "POST",
      body: { source: "env-1", status: "running", events: [{ message_id: "m1" }] },
    });
  });

  it("a claim another computer took first is false, not an error", async () => {
    const { cloud } = cloudWith(() => reply(409, { error: "CLAIMED" }));
    expect(await cloud.claim(3, "env-1")).toBe(false);
  });

  it("409 NOT_SHARED comes as its code", async () => {
    const { cloud } = cloudWith(() => reply(409, { error: "NOT_SHARED" }));
    await expect(cloud.postEvents(1, { source: "s", events: [] })).rejects.toMatchObject({
      status: 409,
      code: "NOT_SHARED",
    });
  });

  it("no credential: nothing is called", async () => {
    const { cloud, calls } = cloudWith(() => reply(200, {}), "");
    await expect(cloud.collab()).rejects.toBeInstanceOf(TeamCloudError);
    expect(calls).toHaveLength(0);
  });

  it("long polls with the cursor in the query", async () => {
    const { cloud, calls } = cloudWith(() => reply(200, { requests: [], rev: 12 }));
    expect(await cloud.outgoing("env 1", 5, 25)).toEqual({ requests: [], rev: 12 });
    expect(calls[0]!.url).toBe(
      "https://cloud.test/api/v1/work/team/requests/outgoing?source=env%201&after_rev=5&wait=25",
    );
  });

  it("a status says who decided", async () => {
    const { cloud, calls } = cloudWith(() => reply(200, { request: {} }));
    await cloud.status(5, "env-1", { status: "started", decidedVia: "auto" });
    expect(calls[0]!.body).toEqual({ source: "env-1", status: "started", decided_via: "auto" });
  });

  it("INVALID_FIELD names the field", async () => {
    const { cloud } = cloudWith(() =>
      reply(400, { error: "INVALID_FIELD", field: "title", reason: "too_long" }),
    );
    await expect(cloud.status(5, "s", { status: "done" })).rejects.toMatchObject({
      code: "INVALID_FIELD",
      field: "title: too_long",
    });
  });

  it("the other person not on isn't this account off", () => {
    expect(new TeamCloudError(409, "PERSON_NOT_ENABLED", "x").off).toBe(false);
    expect(new TeamCloudError(404, "WORK_TEAM_COLLAB_DISABLED", "x").off).toBe(true);
  });

  it("only the first computer sends the Telegram copy", async () => {
    const { cloud } = cloudWith(() => reply(200, { send: false }));
    expect(await cloud.telegram(1, "s")).toBe(false);
  });
});

describe("what is on, cached", () => {
  it("off on a failure, asked again a minute later", async () => {
    let now = 0;
    let calls = 0;
    const cache = makePartsCache({
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new TeamCloudError(0, "", "Couldn't reach the Uno cloud.");
        return { share: true, requests: false, agents: false, tasks: false };
      },
      now: () => now,
    });
    expect(await cache.get()).toEqual(NO_PARTS);
    expect(cache.lastError()).toBe("Couldn't reach the Uno cloud.");
    expect(await cache.get()).toEqual(NO_PARTS);
    expect(calls).toBe(1);
    now = PARTS_FAILED_TTL_MS + 1;
    expect((await cache.get()).share).toBe(true);
    expect(cache.lastError()).toBeNull();
  });

  it("the server's off code is quiet: off, no error", async () => {
    const cache = makePartsCache({
      fetch: async () => {
        throw new TeamCloudError(403, "WORK_TEAM_COLLAB_DISABLED", "off");
      },
    });
    expect(await cache.get()).toEqual(NO_PARTS);
    expect(cache.lastError()).toBeNull();
  });
});

describe("the cloud's answers", () => {
  it("a request, forgiving about missing fields", () => {
    const request = parseRequest({
      id: 4,
      project_id: 2,
      kind: "session",
      status: "waiting",
      from: { user_id: 9, email: "andrei@example.com" },
      level: "tasks",
      auto: true,
    });
    expect(request).toMatchObject({
      id: 4,
      kind: "session",
      level: "tasks",
      levelNow: "tasks",
      auto: true,
    });
    expect(personName(request!.from)).toBe("andrei");
    // From their assistant computer: marked, and never auto whatever the cloud says.
    expect(
      parseRequest({
        id: 5,
        project_id: 2,
        kind: "session",
        status: "waiting",
        auto: true,
        from_assistant: true,
      }),
    ).toMatchObject({ fromAssistant: true, viaAgent: true, auto: false });
    expect(parseRequest({ id: 4, project_id: 2, kind: "teleport", status: "waiting" })).toBeNull();
  });

  it("skips an empty inbound message and a bad level", () => {
    expect(
      parseInbound({
        messages: [
          { id: 1, chat_id: 2, thread_id: "t", text: "  " },
          { id: 2, chat_id: 2, thread_id: "t", text: "hi", from: { user_id: 3 } },
        ],
      }).map((message) => message.id),
    ).toEqual([2]);
    expect(parseLevels({ effective_in: { "3": "answer", "4": "root" } }).effectiveIn).toEqual({
      "3": "answer",
    });
  });
});
