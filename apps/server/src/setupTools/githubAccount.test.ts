import { describe, expect, it } from "vitest";

import { ConnectorsError, type MachineCredentials } from "./connectors.ts";
import {
  isGithubInstallUrl,
  makeGithubAccountClient,
  parseGithubAccountStatus,
} from "./githubAccount.ts";

interface Call {
  readonly method: string;
  readonly url: string;
  readonly auth: string | null;
}

function fakeConsole(handler: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      auth: headers.get("authorization"),
    };
    calls.push(call);
    const reply = handler(call);
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
      status: reply.status,
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const CREDS: MachineCredentials = { boxToken: "uno_agt_machine", boxId: 2385 };

const client = (
  fake: ReturnType<typeof fakeConsole>,
  credentials: MachineCredentials | null = CREDS,
) =>
  makeGithubAccountClient({
    credentials: async () => credentials,
    baseUrl: () => "https://console.test",
    fetch: fake.fetchImpl,
  });

describe("the account's GitHub as this computer sees it", () => {
  it("asks the console with the machine token, for its own box", async () => {
    const fake = fakeConsole(() => ({
      status: 200,
      body: { configured: true, connected: true, accounts: ["octocat"], permission: "write" },
    }));
    expect(await client(fake).status()).toEqual({
      available: true,
      reason: null,
      connected: true,
      accounts: ["octocat"],
      permission: "write",
    });
    expect(fake.calls).toEqual([
      {
        method: "GET",
        url: "https://console.test/api/v1/boxes/2385/work/git/github",
        auth: "Bearer uno_agt_machine",
      },
    ]);
  });

  it("is simply not offered off a cloud computer, on an older console, or with the console down", async () => {
    const never = fakeConsole(() => ({ status: 500 }));
    expect(await client(never, null).status()).toMatchObject({
      available: false,
      reason: "not_cloud_computer",
    });
    expect(never.calls).toHaveLength(0);

    const old = fakeConsole(() => ({ status: 404, body: { error: "NOT_FOUND" } }));
    expect(await client(old).status()).toMatchObject({
      available: false,
      reason: "not_configured",
    });

    const noApp = fakeConsole(() => ({
      status: 200,
      body: { configured: false, connected: false, accounts: [], permission: "write" },
    }));
    expect(await client(noApp).status()).toMatchObject({
      available: false,
      reason: "not_configured",
    });

    const down = makeGithubAccountClient({
      credentials: async () => CREDS,
      baseUrl: () => "https://console.test",
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(await down.status()).toMatchObject({ available: false, reason: "console_unreachable" });
  });

  it("does not offer GitHub to an assistant the person kept away from it", () => {
    expect(
      parseGithubAccountStatus({
        configured: true,
        connected: true,
        accounts: ["octocat"],
        permission: "none",
      }),
    ).toMatchObject({ available: false, connected: true, permission: "none" });
    expect(
      parseGithubAccountStatus({ configured: true, connected: false, permission: "read" }),
    ).toMatchObject({ available: true, connected: false, permission: "read", accounts: [] });
    // Junk logins never reach the interface.
    expect(
      parseGithubAccountStatus({
        configured: true,
        connected: true,
        accounts: ["ok-org", "<script>", 7],
        permission: "write",
      }).accounts,
    ).toEqual(["ok-org"]);
  });

  it("returns the App's install link and nothing that isn't github.com", async () => {
    const fake = fakeConsole(() => ({
      status: 200,
      body: { authorize_url: "https://github.com/apps/uno-deploy/installations/new?state=s" },
    }));
    expect(await client(fake).connect()).toEqual({
      authorizeUrl: "https://github.com/apps/uno-deploy/installations/new?state=s",
    });
    expect(fake.calls[0]).toMatchObject({
      method: "POST",
      url: "https://console.test/api/v1/boxes/2385/work/git/github/connect",
    });

    const evil = fakeConsole(() => ({
      status: 200,
      body: { authorize_url: "https://github.com.evil.example/apps/x" },
    }));
    await expect(client(evil).connect()).rejects.toBeInstanceOf(ConnectorsError);
    expect(isGithubInstallUrl("javascript:alert(1)")).toBe(false);
    expect(isGithubInstallUrl("http://github.com/apps/x")).toBe(false);
  });

  it("says why Connect didn't start", async () => {
    const cases: ReadonlyArray<[number, string]> = [
      [503, "not_configured"],
      [404, "not_configured"],
      [403, "not_allowed"],
      [500, "console_error"],
    ];
    for (const [status, code] of cases) {
      const fake = fakeConsole(() => ({ status, body: { error: "X" } }));
      await expect(client(fake).connect()).rejects.toMatchObject({ code });
    }
    await expect(
      client(
        fakeConsole(() => ({ status: 200 })),
        null,
      ).connect(),
    ).rejects.toMatchObject({
      code: "not_cloud_computer",
    });
  });
});
