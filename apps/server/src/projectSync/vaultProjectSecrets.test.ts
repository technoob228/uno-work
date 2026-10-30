import { describe, expect, it } from "vitest";

import { ProjectVaultError, consoleProjectTeams } from "./vaultProjectSecrets.ts";

const TOKEN = "uno_box_machine_token_for_test";
const VALUE = "the-value-itself";

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly auth: string | null;
  readonly body: unknown;
}

function fakeConsole(answer: (sent: Sent) => { status: number; body?: unknown }) {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const request: Sent = {
      method: init?.method ?? "GET",
      url: String(url),
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    sent.push(request);
    const { status, body } = answer(request);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
  const teams = consoleProjectTeams({
    baseUrl: "https://console.test",
    token: async () => TOKEN,
    fetch: fetchFn,
  });
  return { teams, sent };
}

describe("consoleProjectTeams", () => {
  it("lists projects with the computer's key, and skips what it can't read", async () => {
    const { teams, sent } = fakeConsole(() => ({
      status: 200,
      body: {
        projects: [
          {
            id: 12,
            name: "notes",
            role: "editor",
            joined_at: "2026-10-30T12:00:00.123456Z",
            owner: { user_id: 85, email: "a@b.c", username: "misha" },
          },
          { id: "13", name: "broken", role: "editor" },
          { id: 14, name: "other", role: "viewer" },
        ],
        invites: [{ id: 3, project_id: 99, project_name: "not-yet" }],
      },
    }));
    await expect(teams.projects()).resolves.toEqual([
      {
        id: 12,
        name: "notes",
        role: "editor",
        owner: { username: "misha", email: "a@b.c" },
        joinedAt: "2026-10-30T12:00:00.123456Z",
      },
    ]);
    expect(sent).toEqual([
      {
        method: "GET",
        url: "https://console.test/api/v1/work/team/projects",
        auth: `Bearer ${TOKEN}`,
        body: null,
      },
    ]);
  });

  it("teams off, a console without them, a key with no say: no projects, no error", async () => {
    for (const [status, body] of [
      [404, { error: "WORK_TEAM_DISABLED" }],
      [404, undefined],
      [403, { error: "INSUFFICIENT_SCOPE" }],
    ] as const) {
      const { teams } = fakeConsole(() => ({ status, body }));
      await expect(teams.projects()).resolves.toEqual([]);
    }
  });

  it("any other failure is one", async () => {
    const { teams } = fakeConsole(() => ({ status: 500 }));
    await expect(teams.projects()).rejects.toBeInstanceOf(ProjectVaultError);
  });

  it("reads keys through the team's routes, only those asked for", async () => {
    const { teams, sent } = fakeConsole((request) =>
      request.method === "GET"
        ? {
            status: 200,
            body: {
              project_id: 12,
              secrets: [{ name: "STRIPE_KEY", version: 3, updated_at: "t" }],
            },
          }
        : { status: 200, body: { project_id: 12, values: { STRIPE_KEY: VALUE }, missing: [] } },
    );
    const keys = teams.keys(12);
    await expect(keys.list("notes")).resolves.toEqual([
      { name: "STRIPE_KEY", version: 3, updatedAt: "t" },
    ]);
    await expect(keys.reveal("notes", ["STRIPE_KEY"])).resolves.toEqual({ STRIPE_KEY: VALUE });
    expect(sent.map(({ method, url, body }) => [method, url, body])).toEqual([
      ["GET", "https://console.test/api/v1/work/team/projects/12/secrets", null],
      [
        "POST",
        "https://console.test/api/v1/work/team/projects/12/secrets/reveal",
        { names: ["STRIPE_KEY"] },
      ],
    ]);
  });

  it("never manages a team: looking is all a computer's key may do", () => {
    const { teams } = fakeConsole(() => ({ status: 200 }));
    expect(Object.keys(teams).toSorted()).toEqual(["keys", "projects"]);
    expect(Object.keys(teams.keys(12)).toSorted()).toEqual(["list", "reveal"]);
  });

  it("an error says what happened, never what the console echoed", async () => {
    for (const [status, error, words] of [
      [403, "ASSISTANT_COMPUTER_NO_PROJECT_KEYS", /assistant's own computer/],
      [404, "WORK_TEAM_DISABLED", /aren't available right now/],
    ] as const) {
      const { teams } = fakeConsole(() => ({ status, body: { error, detail: VALUE } }));
      const failure = await teams
        .keys(12)
        .reveal("notes")
        .catch((caught: Error) => caught);
      expect(String(failure)).toMatch(words);
      expect(String(failure)).not.toContain(VALUE);
    }
  });
});
