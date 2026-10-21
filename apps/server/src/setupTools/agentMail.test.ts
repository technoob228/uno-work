import { describe, expect, it } from "vitest";

import { ADDRESS_TAKEN_MESSAGE, makeAgentMailClient, parseAgentMailState } from "./agentMail.ts";
import { ConnectorsError } from "./connectors.ts";

interface Call {
  readonly method: string;
  readonly url: string;
  readonly auth: string | null;
  readonly body: unknown;
}

function fakeConsole(handler: (call: Call) => { status: number; body?: unknown } | Error) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = handler(call);
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
      status: reply.status,
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const client = (fake: ReturnType<typeof fakeConsole>, token: string | null = "uno_agt_machine") =>
  makeAgentMailClient({
    token: async () => token,
    baseUrl: () => "https://console.test",
    fetch: fake.fetchImpl,
  });

const MAILBOX = {
  available: true,
  reason: null,
  mailbox: {
    address: "misha-otter@uno4.me",
    local: "misha-otter",
    created_at: "2026-10-20T10:00:00Z",
    limits: { daily_per_mailbox: 50, sent_today: 3 },
  },
};

describe("Email for your AI as Settings sees it", () => {
  it("asks the console with the machine token and camelCases the mailbox", async () => {
    const fake = fakeConsole(() => ({ status: 200, body: MAILBOX }));
    expect(await client(fake).status()).toEqual({
      available: true,
      reason: null,
      mailbox: {
        address: "misha-otter@uno4.me",
        local: "misha-otter",
        createdAt: "2026-10-20T10:00:00Z",
        dailyLimit: 50,
        sentToday: 3,
      },
    });
    expect(fake.calls).toEqual([
      {
        method: "GET",
        url: "https://console.test/api/v1/work/mail",
        auth: "Bearer uno_agt_machine",
        body: undefined,
      },
    ]);
  });

  it("is unavailable with the reason: flag off, not a cloud computer, old or unreachable console", async () => {
    expect(
      await client(
        fakeConsole(() => ({ status: 200, body: { available: false, reason: "not_enabled" } })),
      ).status(),
    ).toEqual({ available: false, reason: "not_enabled", mailbox: null });

    const none = fakeConsole(() => ({ status: 200, body: MAILBOX }));
    expect((await client(none, null).status()).reason).toBe("not_cloud_computer");
    expect(none.calls).toEqual([]);

    expect((await client(fakeConsole(() => ({ status: 404 }))).status()).reason).toBe(
      "not_configured",
    );
    expect((await client(fakeConsole(() => ({ status: 500 }))).status()).reason).toBe(
      "console_unreachable",
    );
    expect((await client(fakeConsole(() => new Error("offline"))).status()).reason).toBe(
      "console_unreachable",
    );
  });

  it("never shows a mailbox without an address", () => {
    expect(parseAgentMailState({ available: true, mailbox: { address: "" } }).available).toBe(
      false,
    );
    expect(parseAgentMailState(null).available).toBe(false);
    // The local part comes from the address when the console leaves it out.
    expect(
      parseAgentMailState({ available: true, mailbox: { address: "a-b@uno4.me" } }).mailbox?.local,
    ).toBe("a-b");
  });

  it("renames with PUT {local} and returns the new address", async () => {
    const fake = fakeConsole(() => ({ status: 200, body: { address: "misha-agent@uno4.me" } }));
    expect(await client(fake).changeAddress("misha-agent")).toEqual({
      address: "misha-agent@uno4.me",
    });
    expect(fake.calls[0]).toMatchObject({
      method: "PUT",
      url: "https://console.test/api/v1/work/mail/address",
      body: { local: "misha-agent" },
    });
  });

  it("turns taken / invalid / limits into sentences the person can read", async () => {
    const attempt = async (reply: { status: number; body?: unknown }) => {
      try {
        await client(fakeConsole(() => reply)).changeAddress("x-name");
        return null;
      } catch (error) {
        expect(error).toBeInstanceOf(ConnectorsError);
        const { status, code, message } = error as ConnectorsError;
        return { status, code, message };
      }
    };
    expect(await attempt({ status: 409, body: { error: "taken" } })).toEqual({
      status: 409,
      code: "taken",
      message: ADDRESS_TAKEN_MESSAGE,
    });
    expect(
      await attempt({
        status: 422,
        body: { error: "invalid", message: "Names can't contain two dashes in a row." },
      }),
    ).toEqual({
      status: 422,
      code: "invalid",
      message: "Names can't contain two dashes in a row.",
    });
    expect((await attempt({ status: 422, body: { error: "invalid" } }))?.message).toMatch(
      /3–40 lowercase letters/,
    );
    expect((await attempt({ status: 200, body: { address: "" } }))?.code).toBe("console_error");
    expect((await attempt({ status: 404 }))?.code).toBe("not_enabled");
  });

  it("doesn't call the console off a cloud computer", async () => {
    const fake = fakeConsole(() => ({ status: 200, body: {} }));
    await expect(client(fake, null).changeAddress("misha")).rejects.toMatchObject({
      code: "not_cloud_computer",
    });
    expect(fake.calls).toEqual([]);
  });
});
