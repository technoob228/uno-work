import { describe, expect, it } from "vitest";

import { ControlPlaneHttpError } from "@t3tools/shared/unoCloud";

import {
  makeRemoteDaemonClient,
  pairingFailure,
  RemoteComputerError,
} from "./remoteDaemonClient.ts";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

function fakeDaemon(handler: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const reply = handler(call);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const pairingOk = { url: "https://b.app.uno4.dev/pair#token=one-time", hostname: "b" };

describe("remote daemon client", () => {
  it("pairs through the console, trades the token for a session, reuses it", async () => {
    const consoleCalls: string[] = [];
    let sessions = 0;
    const daemon = fakeDaemon((call) => {
      if (call.url.endsWith("/api/auth/bootstrap/bearer")) {
        sessions += 1;
        expect(call.body).toEqual({ credential: "one-time" });
        return {
          status: 200,
          body: {
            sessionToken: `s${sessions}`,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        };
      }
      return { status: 200, body: { auth: call.authorization } };
    });
    const client = makeRemoteDaemonClient({
      controlPlane: async (path) => {
        consoleCalls.push(path);
        return pairingOk;
      },
      keyKind: "machine",
      fetch: daemon.fetchImpl,
    });
    const first = await client.request({ boxId: 7, computerName: "b", method: "GET", path: "/x" });
    const second = await client.request({ boxId: 7, computerName: "b", method: "GET", path: "/y" });
    expect(first.body).toEqual({ auth: "Bearer s1" });
    expect(second.body).toEqual({ auth: "Bearer s1" });
    expect(consoleCalls).toEqual(["/api/v1/boxes/7/work/session"]);
  });

  it("a forgotten session (401) is re-paired once", async () => {
    let sessions = 0;
    const daemon = fakeDaemon((call) => {
      if (call.url.endsWith("/api/auth/bootstrap/bearer")) {
        sessions += 1;
        return { status: 200, body: { sessionToken: `s${sessions}` } };
      }
      return call.authorization === "Bearer s1"
        ? { status: 401, body: { error: "Unauthorized" } }
        : { status: 200, body: { ok: true } };
    });
    const client = makeRemoteDaemonClient({
      controlPlane: async () => pairingOk,
      keyKind: "account",
      fetch: daemon.fetchImpl,
    });
    const reply = await client.request({
      boxId: 1,
      computerName: "b",
      method: "POST",
      path: "/z",
      body: {},
    });
    expect(reply).toEqual({ status: 200, body: { ok: true } });
    expect(sessions).toBe(2);
  });

  it("no key: not linked, without calling anyone", async () => {
    const client = makeRemoteDaemonClient({ controlPlane: null, keyKind: "none" });
    await expect(
      client.request({ boxId: 1, computerName: "b", method: "GET", path: "/" }),
    ).rejects.toMatchObject({ code: "not_linked" });
  });

  it("never puts the token or the link into an error", async () => {
    const daemon = fakeDaemon(() => ({ status: 500, body: { error: "boom" } }));
    const client = makeRemoteDaemonClient({
      controlPlane: async () => pairingOk,
      keyKind: "machine",
      fetch: daemon.fetchImpl,
    });
    const error = await client
      .request({ boxId: 1, computerName: "b", method: "GET", path: "/" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RemoteComputerError);
    expect(String((error as Error).message)).not.toContain("one-time");
  });
});

describe("pairingFailure", () => {
  const machine = { computerName: "stage-work", keyKind: "machine" as const };
  it("a machine token without machines:create gets the way to allow it", () => {
    const error = pairingFailure(
      new ControlPlaneHttpError(403, '403: {"error":"WORK_MACHINE_SCOPE_DISABLED"}'),
      machine,
    );
    expect(error.code).toBe("no_permission");
    expect(error.message).toContain("Settings → Computer access");
  });
  it("a waking computer, a dead one, a deleted one", () => {
    expect(
      pairingFailure(new Error("The computer is still starting. Try again in a moment."), machine)
        .code,
    ).toBe("starting");
    expect(
      pairingFailure(new ControlPlaneHttpError(409, "409: WORK_MACHINE_FAILED: x"), machine).code,
    ).toBe("failed");
    expect(pairingFailure(new ControlPlaneHttpError(404, "404: not found"), machine).code).toBe(
      "not_found",
    );
    expect(
      pairingFailure(new ControlPlaneHttpError(502, "502: <html>"), machine).message,
    ).not.toContain("<");
  });
});
