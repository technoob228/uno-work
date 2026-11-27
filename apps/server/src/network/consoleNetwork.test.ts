/**
 * The console client's state request: this device named on the person's key
 * (the console's "online through the exit" signal, which wakes a sleeping
 * exit), never on a machine token, and a console that refuses the id still
 * answers without it.
 */
import { describe, expect, it } from "vitest";

import {
  type ConsoleNetworkCredentials,
  consoleStatePath,
  isConsoleDeviceId,
  makeConsoleNetworkClient,
} from "./consoleNetwork.ts";
import { engineError } from "./tunnelRuntime.ts";

const STATE = { available: true, enabled: true, exit_id: "box-2534", protocol: "auto", exits: [] };

function fakeFetch(answer: (url: string) => { status: number; body: unknown }) {
  const urls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const { status, body } = answer(url);
    return new Response(JSON.stringify(body), { status });
  };
  return { urls, fetchImpl: fetchImpl as typeof fetch };
}

const ACCOUNT: ConsoleNetworkCredentials = {
  kind: "account",
  accountKey: "uno_live_k",
  deviceId: "dev-0123456789abcdef",
};

describe("console Network client: the state request", () => {
  it("names this device on the person's key", async () => {
    const { urls, fetchImpl } = fakeFetch(() => ({ status: 200, body: STATE }));
    const state = await makeConsoleNetworkClient(ACCOUNT, fetchImpl).state();
    expect(state.exitId).toBe("box-2534");
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? "").pathname).toBe("/api/v1/network");
    expect(new URL(urls[0] ?? "").searchParams.get("device_id")).toBe("dev-0123456789abcdef");
  });

  it("sends no device on a machine token (the token says which computer asks)", async () => {
    const { urls, fetchImpl } = fakeFetch(() => ({ status: 200, body: STATE }));
    await makeConsoleNetworkClient(
      { kind: "machine", boxToken: "uno_agt_x", boxId: 2531 },
      fetchImpl,
    ).state();
    expect(new URL(urls[0] ?? "").pathname).toBe("/api/v1/boxes/2531/work/network");
    expect(new URL(urls[0] ?? "").search).toBe("");
  });

  it("asks again without the id when the console refuses it", async () => {
    const { urls, fetchImpl } = fakeFetch((url) =>
      url.includes("device_id=")
        ? { status: 400, body: { error: "INVALID_DEVICE_ID", code: "INVALID_DEVICE_ID" } }
        : { status: 200, body: STATE },
    );
    const state = await makeConsoleNetworkClient(ACCOUNT, fetchImpl).state();
    expect(state.enabled).toBe(true);
    expect(urls.map((u) => new URL(u).search)).toEqual(["?device_id=dev-0123456789abcdef", ""]);
  });

  it("an id the console would refuse is left out", () => {
    expect(isConsoleDeviceId("dev-0123456789abcdef")).toBe(true);
    expect(isConsoleDeviceId("box-2531")).toBe(false);
    expect(isConsoleDeviceId("a b")).toBe(false);
    expect(isConsoleDeviceId("x".repeat(65))).toBe(false);
    expect(consoleStatePath({ ...ACCOUNT, deviceId: "box-2531" })).toBe("");
  });
});

describe("engine errors as sentences", () => {
  it("writes protocols by their names", () => {
    expect(engineError({ error: "no handshake with 203.0.113.5:40123 over wireguard" })).toBe(
      "No handshake with 203.0.113.5:40123 over WireGuard.",
    );
    expect(engineError({ error: "no handshake with 203.0.113.5:40124 over amneziawg" })).toBe(
      "No handshake with 203.0.113.5:40124 over AmneziaWG.",
    );
    expect(engineError({})).toBeNull();
  });
});
