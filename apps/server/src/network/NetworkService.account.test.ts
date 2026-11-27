/**
 * The account's exits (console) in the daemon, with a fake console and a fake
 * engine: one switch for the account, this device's key registered at the
 * exit (private key never sent), the protocol picks the transports, and
 * fail-closed while the exit is being set up.
 */
import * as Net from "node:net";

import type { NetworkProtocol } from "@t3tools/contracts";
import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import {
  type ConsoleNetworkClient,
  ConsoleNetworkError,
  type ConsoleNetworkState,
  parseConsoleNetworkState,
} from "./consoleNetwork.ts";
import {
  NETWORK_SECRET_NAME,
  type NetworkComputerInfo,
  consoleCredentialsFrom,
  makeNetworkService,
} from "./NetworkService.ts";
import type { TunnelRuntime, TunnelSnapshot } from "./tunnelRuntime.ts";
import type { UnoNetConfig } from "./unoNet.ts";

const COMPUTER: NetworkComputerInfo = { id: "env-1", name: "stage-work", kind: "cloud" };

const CONSOLE_BODY = {
  available: true,
  enabled: false,
  exit_id: null,
  protocol: "auto",
  since: null,
  exits: [
    {
      id: "box-2534",
      kind: "computer",
      box_id: 2534,
      label: "work-canary",
      self: false,
      state: "ready",
      country: "NL",
      city: "Amsterdam",
      address: "203.0.113.5",
      address_type: "datacenter",
      protocols: ["wireguard", "amneziawg"],
      available: true,
    },
    {
      id: "box-2531",
      kind: "computer",
      box_id: 2531,
      label: "stage-work",
      self: true,
      state: "not_set_up",
      protocols: [],
      available: true,
    },
    {
      id: "uno-17",
      kind: "uno",
      label: "Germany",
      country: "DE",
      address_type: "clean",
      protocols: [],
      available: false,
      reason: "soon",
    },
  ],
  computers: [{ id: "box-2531", name: "stage-work", kind: "cloud", status: "off" }],
};

const TRANSPORTS = [
  {
    protocol: "wireguard" as const,
    addresses: ["10.66.0.7/32"],
    dns: ["1.1.1.1"],
    peer: { publicKey: "gwWG", endpoint: "203.0.113.5:40123" },
  },
  {
    protocol: "amneziawg" as const,
    addresses: ["10.67.0.7/32"],
    dns: ["1.1.1.1"],
    obfuscation: { jc: "4" },
    peer: { publicKey: "gwAWG", endpoint: "203.0.113.5:40124" },
  },
];

function fakeConsole(options: { notReadyTimes?: number } = {}) {
  let state: ConsoleNetworkState = parseConsoleNetworkState(CONSOLE_BODY);
  let notReady = options.notReadyTimes ?? 0;
  const peers: Array<{ publicKey: string; exitId: string; label: string }> = [];
  const changes: unknown[] = [];
  const client: ConsoleNetworkClient = {
    state: async () => state,
    change: async (input) => {
      changes.push(input);
      state = {
        ...state,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.exitId !== undefined ? { exitId: input.exitId } : {}),
        ...(input.protocol !== undefined ? { protocol: input.protocol as NetworkProtocol } : {}),
      };
      return state;
    },
    registerPeer: async (input) => {
      peers.push(input);
      if (notReady > 0) {
        notReady -= 1;
        throw new ConsoleNetworkError(409, "NETWORK_EXIT_NOT_READY", "setting up", "setting_up");
      }
      return {
        exitId: input.exitId,
        transports: TRANSPORTS,
        probe: "10.66.0.1",
        probeAwg: "10.67.0.1",
      };
    },
  };
  return { client, peers, changes };
}

function fakeRuntime() {
  const applied: Array<UnoNetConfig | null> = [];
  let snapshot: TunnelSnapshot = {
    status: "off",
    activeProtocol: null,
    latencyMs: null,
    since: null,
    error: null,
  };
  const runtime: TunnelRuntime = {
    setDesired: async (config) => {
      applied.push(config);
      snapshot = config
        ? { ...snapshot, status: "on", activeProtocol: "wireguard", latencyMs: 9 }
        : { ...snapshot, status: "off", activeProtocol: null };
    },
    snapshot: () => snapshot,
    // No real engine: the bridge refuses (as it would with the engine missing).
    socks: () => null,
    onChange: () => {},
    close: async () => {},
  };
  return { runtime, applied };
}

function memoryStore() {
  const memory = new Map<string, Uint8Array>();
  return {
    memory,
    service: {
      get: (name: string) => Effect.succeed(memory.get(name) ?? null),
      set: (name: string, value: Uint8Array) => Effect.sync(() => void memory.set(name, value)),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: (name: string) => Effect.sync(() => void memory.delete(name)),
    },
  };
}

function connectStatus(proxyUrl: string): Promise<string> {
  const url = new URL(proxyUrl);
  const auth = Buffer.from(`uno:${decodeURIComponent(url.password)}`).toString("base64");
  return new Promise((resolve, reject) => {
    const socket = Net.connect({ host: url.hostname, port: Number(url.port) });
    socket.on("connect", () =>
      socket.write(
        `CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
      ),
    );
    socket.once("data", (chunk) => {
      socket.destroy();
      resolve(chunk.toString("utf8").split("\r\n")[0] ?? "");
    });
    socket.on("error", reject);
  });
}

async function withService<A>(
  deps: {
    console: ConsoleNetworkClient | null;
    runtime: TunnelRuntime;
    store?: ReturnType<typeof memoryStore>;
  },
  body: (
    service: Effect.Success<ReturnType<typeof makeNetworkService>>,
    env: Record<string, string | undefined>,
  ) => Effect.Effect<A, Error>,
): Promise<A> {
  const env: Record<string, string | undefined> = { PATH: "/bin" };
  const store = deps.store ?? memoryStore();
  const scope = Effect.runSync(Scope.make());
  try {
    return await Effect.runPromise(
      makeNetworkService({
        env,
        recheckMs: 0,
        accountRefreshMs: 0,
        peerRetryMs: 0,
        engineBinary: "/fake/uno-net",
        runtime: deps.runtime,
        consoleClient: () => Effect.succeed(deps.console),
        checkProxy: async () => ({ status: "failed", reason: "unused", at: "x" }),
      }).pipe(
        Effect.flatMap((service) => body(service, env)),
        Effect.provideService(ServerSecretStore, store.service),
        Effect.provideService(Scope.Scope, scope),
      ),
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("Network: the account's exits", () => {
  it("lists the account's computers as exits, hides this one, marks Uno addresses soon", async () => {
    const { client } = fakeConsole();
    const { runtime } = fakeRuntime();
    const state = await withService({ console: client, runtime }, (service) =>
      Effect.gen(function* () {
        yield* Effect.sleep(20);
        return yield* service.state(COMPUTER);
      }),
    );
    expect(state.tunnel).toBe(true);
    expect(state.exits.map((e) => e.id)).toEqual(["box-2534", "uno-17"]);
    expect(state.exits[0]).toMatchObject({
      kind: "computer",
      addressType: "datacenter",
      online: true,
      note: null,
    });
    expect(state.exits[1]).toMatchObject({ kind: "uno", online: false, note: "Coming soon" });
    expect(state.enabled).toBe(false);
  });

  it("picking an exit turns the account on, registers this device's public key and runs the tunnel", async () => {
    const fake = fakeConsole();
    const { runtime, applied } = fakeRuntime();
    const store = memoryStore();
    await withService({ console: fake.client, runtime, store }, (service, env) =>
      Effect.gen(function* () {
        yield* Effect.sleep(20);
        const on = yield* service.change({ exitId: "box-2534" }, COMPUTER);
        expect(fake.changes.at(-1)).toMatchObject({ exitId: "box-2534", enabled: true });
        expect(on).toMatchObject({
          enabled: true,
          exitId: "box-2534",
          status: "on",
          activeProtocol: "wireguard",
        });
        expect(on.strict).toBe(false);

        const peer = fake.peers.at(-1);
        expect(peer).toMatchObject({ exitId: "box-2534", label: "stage-work" });
        const record = JSON.parse(new TextDecoder().decode(store.memory.get(NETWORK_SECRET_NAME)));
        // Only the public key went to the console; the private one stays here.
        expect(peer?.publicKey).toBe(record.device.publicKey);
        expect(JSON.stringify(fake.peers)).not.toContain(record.device.privateKey);
        expect(JSON.stringify(on)).not.toContain(record.device.privateKey);

        // The engine got both transports (auto) with this device's private key.
        const config = applied.at(-1);
        expect(config?.transports.map((t) => t.protocol)).toEqual(["wireguard", "amneziawg"]);
        expect(config?.transports[0]?.privateKey).toBe(record.device.privateKey);
        expect(env.HTTPS_PROXY).toMatch(/^http:\/\/uno:/);
        // No engine socket in this fake: the bridge refuses, never direct.
        expect(yield* Effect.promise(() => connectStatus(env.HTTPS_PROXY ?? ""))).toMatch(/502/);

        // Protocol is the account's: AmneziaWG only.
        yield* service.change({ protocol: "amneziawg" }, COMPUTER);
        expect(applied.at(-1)?.transports.map((t) => t.protocol)).toEqual(["amneziawg"]);

        // Off: the account's switch.
        const off = yield* service.change({ enabled: false }, COMPUTER);
        expect(fake.changes.at(-1)).toMatchObject({ enabled: false });
        expect(off.status).toBe("off");
        expect(applied.at(-1)).toBeNull();
        expect(env.HTTPS_PROXY).toBeUndefined();
      }),
    );
  });

  it("stays offline (connecting, bridge closed) while Uno sets the exit up", async () => {
    const fake = fakeConsole({ notReadyTimes: 1 });
    const { runtime, applied } = fakeRuntime();
    await withService({ console: fake.client, runtime }, (service, env) =>
      Effect.gen(function* () {
        yield* Effect.sleep(20);
        const waiting = yield* service.change({ exitId: "box-2534" }, COMPUTER);
        expect(waiting.status).toBe("connecting");
        expect(waiting.reason).toMatch(/setting up work-canary/);
        expect(applied.every((c) => c === null)).toBe(true);
        expect(env.HTTPS_PROXY).toBeDefined();
        expect(yield* Effect.promise(() => connectStatus(env.HTTPS_PROXY ?? ""))).toMatch(/502/);
      }),
    );
  });

  it("keeps the tunnel (not direct) after a restart while the console is unreachable", async () => {
    const store = memoryStore();
    const fake = fakeConsole();
    await withService({ console: fake.client, runtime: fakeRuntime().runtime, store }, (service) =>
      Effect.gen(function* () {
        yield* Effect.sleep(20);
        yield* service.change({ exitId: "box-2534" }, COMPUTER);
      }),
    );
    const down: ConsoleNetworkClient = {
      state: async () => {
        throw new ConsoleNetworkError(502, "CONSOLE_UNREACHABLE", "unreachable");
      },
      change: async () => {
        throw new ConsoleNetworkError(502, "CONSOLE_UNREACHABLE", "unreachable");
      },
      registerPeer: async () => {
        throw new ConsoleNetworkError(502, "CONSOLE_UNREACHABLE", "unreachable");
      },
    };
    const second = fakeRuntime();
    const state = await withService({ console: down, runtime: second.runtime, store }, (service) =>
      Effect.gen(function* () {
        yield* Effect.sleep(20);
        return yield* service.state(COMPUTER);
      }),
    );
    expect(state).toMatchObject({ enabled: true, exitId: "box-2534", status: "on" });
    expect(second.applied.at(-1)?.transports.length).toBe(2);
  });

  it("a local proxy wins over the account's exit on this computer", async () => {
    const fake = fakeConsole();
    const { runtime } = fakeRuntime();
    await withService({ console: fake.client, runtime }, (service) =>
      Effect.gen(function* () {
        yield* Effect.sleep(20);
        yield* service.change({ exitId: "box-2534" }, COMPUTER);
        const proxied = yield* service.change(
          { proxy: { scheme: "http", host: "proxy.example", port: 3128 }, exitId: "proxy" },
          COMPUTER,
        );
        expect(proxied.exitId).toBe("proxy");
        // The account stays on for the other computers.
        expect(fake.changes.at(-1)).toMatchObject({ exitId: "box-2534", enabled: true });
      }),
    );
  });

  it("credentials: the machine token first, the account key on a Mac, never a gateway key", () => {
    expect(
      consoleCredentialsFrom({ boxToken: "uno_agt_x", boxId: 2531, apiKey: "k" }, "dev-1"),
    ).toEqual({
      kind: "machine",
      boxToken: "uno_agt_x",
      boxId: 2531,
    });
    expect(consoleCredentialsFrom({ apiKey: "uno_live_k" }, "dev-1")).toEqual({
      kind: "account",
      accountKey: "uno_live_k",
      deviceId: "dev-1",
    });
    expect(consoleCredentialsFrom({ apiKey: "unollm_k" }, "dev-1")).toBeNull();
    expect(consoleCredentialsFrom(null, "dev-1")).toBeNull();
  });
});
