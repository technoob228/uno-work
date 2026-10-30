import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  AutomationClientError,
  consoleRefusal,
  executorToConsole,
  makeAutomationsClient,
  parseAutomation,
  parseEvent,
  parseHook,
  parseTrigger,
  triggerToConsole,
  parseExecutor,
  readConsoleError,
  updateBodyToConsole,
} from "./consoleClient.ts";

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const IDENTITY = { boxToken: "uno_agt_test", boxId: 2531 };

const CONSOLE_AUTOMATION = {
  id: 7,
  box_id: 2531,
  assistant: "assistant-ada",
  assistant_name: "Ada",
  name: "Review PRs in getuno/x",
  instruction: "Review the PR and leave a comment",
  enabled: true,
  trigger: { kind: "github.pull_request", repo: "getuno/x", actions: ["opened"], drafts: false },
  status: "needs_github_permission",
  status_detail: "GitHub needs one more permission",
  manage_url: "https://github.com/settings/installations/42",
  next_run_at: null,
  last_run: {
    id: 99,
    automation_id: 7,
    kind: "github.pull_request",
    title: "PR #12 · Fix login",
    url: "https://github.com/getuno/x/pull/12",
    state: "waiting_wake",
    reason: "computer_asleep",
    thread_id: null,
    summary: null,
    created_at: "2026-10-28T10:00:00Z",
    started_at: null,
    finished_at: null,
  },
  created_at: "2026-10-28T09:00:00Z",
  updated_at: "2026-10-28T09:30:00Z",
  some_future_field: "ignored",
};

function stand(
  answer: (url: string, init: RequestInit) => Response | Promise<Response>,
  identity: typeof IDENTITY | null = IDENTITY,
) {
  const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
  const client = makeAutomationsClient({
    identity: Effect.succeed(identity),
    fetchImpl: async (url, init = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
        auth: new Headers(init.headers).get("authorization"),
      });
      return answer(url, init);
    },
  });
  return { client, calls };
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));

describe("console answers → Work's camelCase", () => {
  it("maps an automation and its last run, ignoring unknown fields", () => {
    expect(parseAutomation(CONSOLE_AUTOMATION)).toEqual({
      id: 7,
      boxId: 2531,
      assistant: "assistant-ada",
      assistantName: "Ada",
      name: "Review PRs in getuno/x",
      instruction: "Review the PR and leave a comment",
      enabled: true,
      trigger: {
        kind: "github.pull_request",
        repo: "getuno/x",
        actions: ["opened"],
        drafts: false,
      },
      executor: { kind: "assistant" },
      status: "needs_github_permission",
      statusDetail: "GitHub needs one more permission",
      manageUrl: "https://github.com/settings/installations/42",
      nextRunAt: null,
      lastRun: {
        id: 99,
        automationId: 7,
        kind: "github.pull_request",
        title: "PR #12 · Fix login",
        url: "https://github.com/getuno/x/pull/12",
        state: "waiting_wake",
        reason: "computer_asleep",
        threadId: null,
        summary: null,
        createdAt: "2026-10-28T10:00:00Z",
        startedAt: null,
        finishedAt: null,
      },
      createdAt: "2026-10-28T09:00:00Z",
      updatedAt: "2026-10-28T09:30:00Z",
    });
  });

  it("drops an automation it can't read and a manage link that isn't GitHub's", () => {
    expect(parseAutomation({ id: 1, trigger: { kind: "weird" } })).toBeNull();
    expect(
      parseAutomation({ ...CONSOLE_AUTOMATION, manage_url: "https://evil.example/x" })?.manageUrl,
    ).toBeNull();
    // An unknown status reads as ok rather than breaking the list.
    expect(parseAutomation({ ...CONSOLE_AUTOMATION, status: "new_status" })?.status).toBe("ok");
  });

  it("maps an event of the queue", () => {
    expect(
      parseEvent({
        id: 501,
        automation_id: 7,
        assistant: "assistant-home",
        assistant_name: "Uno",
        name: "Morning plan",
        instruction: "Plan my day",
        kind: "schedule",
        title: "Weekdays at 09:00",
        url: null,
        payload: { slot: "2026-10-28T07:00:00Z", label: "Weekdays at 09:00" },
        created_at: "2026-10-28T07:00:01Z",
      }),
    ).toEqual({
      id: 501,
      automationId: 7,
      assistant: "assistant-home",
      assistantName: "Uno",
      name: "Morning plan",
      instruction: "Plan my day",
      executor: { kind: "assistant" },
      kind: "schedule",
      title: "Weekdays at 09:00",
      url: null,
      payload: { slot: "2026-10-28T07:00:00Z", label: "Weekdays at 09:00" },
      createdAt: "2026-10-28T07:00:01Z",
    });
  });
});

describe("outside triggers", () => {
  it("reads and writes require_signature, keeps ask", () => {
    expect(parseTrigger({ kind: "webhook", ask: false, require_signature: true })).toEqual({
      kind: "webhook",
      ask: false,
      requireSignature: true,
    });
    expect(parseTrigger({ kind: "site.form", slug: "report" })).toEqual({
      kind: "site.form",
      slug: "report",
    });
    expect(parseTrigger({ kind: "site.form" })).toBeNull();
    expect(triggerToConsole({ kind: "webhook", ask: true, requireSignature: true })).toEqual({
      kind: "webhook",
      ask: true,
      require_signature: true,
    });
  });

  it("a hook without a URL is no hook", () => {
    expect(parseHook({ url: "https://x", signing_secret: "s" })).toMatchObject({
      url: "https://x",
      signingSecret: "s",
      requireSignature: false,
    });
    expect(parseHook({ signing_secret: "s" })).toBeNull();
  });
});

describe("console errors → readable lines", () => {
  it("reads both the connector shape and a nested error", () => {
    expect(
      readConsoleError({
        error: "GITHUB_REPO_NOT_ALLOWED",
        code: "GITHUB_REPO_NOT_ALLOWED",
        detail: "getuno/x is not in the installation",
        manage_url: "https://github.com/apps/uno-deploy/installations/new",
      }),
    ).toEqual({
      code: "GITHUB_REPO_NOT_ALLOWED",
      detail: "getuno/x is not in the installation",
      manageUrl: "https://github.com/apps/uno-deploy/installations/new",
      connectUrl: undefined,
    });
    expect(readConsoleError({ error: { code: "NO_OPEN_PR", message: "none" } }).code).toBe(
      "NO_OPEN_PR",
    );
  });

  it("passes the console's code and status on with a human message and the link", () => {
    const refusal = consoleRefusal({
      status: 409,
      body: {
        error: "GITHUB_REPO_NOT_ALLOWED",
        detail: "getuno/x",
        manage_url: "https://github.com/settings/installations/42",
      },
    });
    expect(refusal).toBeInstanceOf(AutomationClientError);
    expect(refusal.status).toBe(409);
    expect(refusal.code).toBe("GITHUB_REPO_NOT_ALLOWED");
    expect(refusal.message).toContain("can't see this repository");
    expect(refusal.message).toContain("https://github.com/settings/installations/42");
    expect(refusal.manageUrl).toBe("https://github.com/settings/installations/42");
  });

  it("a bare 404 (old console, flag off) is AUTOMATIONS_DISABLED; 401 is not linked", () => {
    expect(consoleRefusal({ status: 404, body: null }).code).toBe("AUTOMATIONS_DISABLED");
    expect(consoleRefusal({ status: 404, body: { error: "AUTOMATIONS_DISABLED" } }).code).toBe(
      "AUTOMATIONS_DISABLED",
    );
    expect(consoleRefusal({ status: 404, body: { error: "NOT_FOUND" } }).code).toBe("NOT_FOUND");
    const unlinked = consoleRefusal({ status: 401, body: { error: "UNAUTHORIZED" } });
    expect(unlinked.code).toBe("NOT_CLOUD_COMPUTER");
    expect(consoleRefusal({ status: 503, body: null }).status).toBe(502);
  });
});

describe("automations client (console mocked)", () => {
  it("lists with the machine token on its own box", async () => {
    const { client, calls } = stand(() => json(200, { automations: [CONSOLE_AUTOMATION] }));
    const result = await Effect.runPromise(client.list);
    expect(result.available).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.automations).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "GET",
      auth: "Bearer uno_agt_test",
    });
    expect(calls[0]!.url).toMatch(/\/api\/v1\/boxes\/2531\/work\/automations$/);
  });

  it("says why automations aren't available: laptop, flag off, console down", async () => {
    const laptop = stand(() => json(200, {}), null);
    expect(await Effect.runPromise(laptop.client.list)).toEqual({
      available: false,
      reason: "not_cloud_computer",
      automations: [],
    });
    expect(laptop.calls).toHaveLength(0);

    const off = stand(() => json(404, { error: "AUTOMATIONS_DISABLED" }));
    expect((await Effect.runPromise(off.client.list)).reason).toBe("disabled");

    const down = stand(() => {
      throw new Error("connect ECONNREFUSED");
    });
    expect((await Effect.runPromise(down.client.list)).reason).toBe("console_unreachable");
  });

  it("creates with snake_case fields and reads the answer back", async () => {
    const { client, calls } = stand(() => json(201, CONSOLE_AUTOMATION));
    const created = await Effect.runPromise(
      client.create({
        assistant: "assistant-ada",
        assistantName: "Ada",
        name: "Review PRs in getuno/x",
        instruction: "Review the PR and leave a comment",
        trigger: { kind: "github.pull_request", repo: "getuno/x" },
      }),
    );
    expect(created.id).toBe(7);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({
      assistant: "assistant-ada",
      assistant_name: "Ada",
      name: "Review PRs in getuno/x",
      instruction: "Review the PR and leave a comment",
      trigger: { kind: "github.pull_request", repo: "getuno/x" },
    });
  });

  it("a refused create fails with the console's code", async () => {
    const { client } = stand(() =>
      json(422, { error: "TRIGGER_NOT_SUPPORTED_YET", code: "TRIGGER_NOT_SUPPORTED_YET" }),
    );
    const result = await run(
      client.create({
        assistant: "assistant-ada",
        assistantName: "Ada",
        name: "Mail",
        instruction: "Sum up",
        trigger: { kind: "gmail.message", from: "a@b.c" },
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe("TRIGGER_NOT_SUPPORTED_YET");
      expect(result.failure.status).toBe(422);
    }
  });

  it("long-polls events with after/wait and a longer timeout", async () => {
    const { client, calls } = stand(() =>
      json(200, { events: [{ id: 3, automation_id: 7, kind: "manual" }, { bogus: true }] }),
    );
    const events = await Effect.runPromise(client.events({ after: 2, waitSec: 99 }));
    expect(events.map((e) => e.id)).toEqual([3]);
    expect(calls[0]!.url).toMatch(/\/work\/automations\/events\?after=2&wait=25$/);
  });

  it("claim: taken, or already taken (409)", async () => {
    const ok = stand(() => json(200, { state: "running" }));
    expect(await Effect.runPromise(ok.client.claim(5))).toBe("claimed");
    expect(ok.calls[0]!.url).toMatch(/\/automations\/events\/5\/claim$/);
    const taken = stand(() => json(409, { error: "ALREADY_CLAIMED" }));
    expect(await Effect.runPromise(taken.client.claim(5))).toBe("already_claimed");
  });

  it("result: snake_case, clipped to 500", async () => {
    const { client, calls } = stand(() => json(200, {}));
    await Effect.runPromise(
      client.result(5, { state: "done", summary: "x".repeat(900), threadId: "t-1" }),
    );
    expect(calls[0]!.body).toMatchObject({ state: "done", thread_id: "t-1" });
    expect((calls[0]!.body as { summary: string }).summary).toHaveLength(500);
  });

  it("repos: list, or not connected with the link", async () => {
    const listed = stand(() =>
      json(200, { repos: [{ full_name: "getuno/x", private: true }, { nope: 1 }] }),
    );
    expect(await Effect.runPromise(listed.client.repos("get"))).toEqual({
      connected: true,
      repos: [{ fullName: "getuno/x", private: true }],
      manageUrl: null,
    });
    expect(listed.calls[0]!.url).toMatch(/\/work\/git\/github\/repos\?q=get$/);
    const notConnected = stand(() =>
      json(409, {
        error: "GITHUB_NOT_CONNECTED",
        connect_url: "https://github.com/apps/uno-deploy/installations/new",
      }),
    );
    expect(await Effect.runPromise(notConnected.client.repos(""))).toEqual({
      connected: false,
      repos: [],
      manageUrl: "https://github.com/apps/uno-deploy/installations/new",
    });
  });

  it("delete of a gone automation is not an error", async () => {
    const { client } = stand(() => json(404, { error: "NOT_FOUND" }));
    expect(await Effect.runPromise(client.remove(7))).toEqual({ deleted: false });
  });

  it("repos: the Add-on-GitHub link of the account that owns the repository", async () => {
    const body = {
      repos: [{ full_name: "getuno/x", private: true }],
      manage_url: "https://github.com/settings/installations/1",
      accounts: [
        {
          login: "getuno",
          manage_url: "https://github.com/organizations/getuno/settings/installations/2",
        },
        { login: "misha", manage_url: "https://github.com/settings/installations/3" },
        { login: "evil", manage_url: "https://evil.example/x" },
      ],
    };
    const { client } = stand(() => json(200, body));
    const owned = await Effect.runPromise(client.repos("GetUno/new-repo"));
    expect(owned.manageUrl).toBe(
      "https://github.com/organizations/getuno/settings/installations/2",
    );
    expect(owned.accounts).toEqual([
      {
        login: "getuno",
        manageUrl: "https://github.com/organizations/getuno/settings/installations/2",
      },
      { login: "misha", manageUrl: "https://github.com/settings/installations/3" },
      { login: "evil", manageUrl: null },
    ]);
    // No owner typed: the console's general link.
    expect((await Effect.runPromise(client.repos("x"))).manageUrl).toBe(
      "https://github.com/settings/installations/1",
    );
  });

  it("PATCH carries a renamed assistant's name", async () => {
    const { client, calls } = stand(() => json(200, CONSOLE_AUTOMATION));
    await Effect.runPromise(client.update(7, { assistantName: "Ada Lovelace" }));
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { assistant_name: "Ada Lovelace" } });
  });

  it("GitHub not connected without a link: a neutral line", () => {
    const refusal = consoleRefusal({ status: 409, body: { error: "GITHUB_NOT_CONNECTED" } });
    expect(refusal.message).toBe("GitHub isn't connected to this Uno account yet.");
  });
});

describe("executor (29.10)", () => {
  it("reads the console's executor; absent or unknown is the assistant", () => {
    expect(parseExecutor(undefined)).toEqual({ kind: "assistant" });
    expect(parseExecutor({ kind: "robot" })).toEqual({ kind: "assistant" });
    expect(parseExecutor({ kind: "chat" })).toEqual({ kind: "assistant" });
    expect(parseExecutor({ kind: "chat", thread_id: "t-1", title: "Notes" })).toEqual({
      kind: "chat",
      threadId: "t-1",
      title: "Notes",
    });
    expect(parseExecutor({ kind: "new_chat", project_id: "p-1", from_thread_id: "t-1" })).toEqual({
      kind: "new_chat",
      projectId: "p-1",
      fromThreadId: "t-1",
    });
  });

  it("writes it snake_case, both ways round", () => {
    const executor = { kind: "new_chat" as const, projectId: "p-1", fromThreadId: "t-1" };
    expect(executorToConsole(executor)).toEqual({
      kind: "new_chat",
      project_id: "p-1",
      from_thread_id: "t-1",
    });
    expect(parseExecutor(executorToConsole(executor))).toEqual(executor);
    expect(updateBodyToConsole({ executor: { kind: "chat", threadId: "t" } })).toEqual({
      executor: { kind: "chat", thread_id: "t" },
    });
  });
});
