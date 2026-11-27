import type { NetworkProxyCheck } from "@t3tools/contracts";
import { Effect, Exit, Scope } from "effect";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { redactSecretsInText, resetKnownSecretsForTest } from "../secretRedaction.ts";
import {
  NETWORK_SECRET_NAME,
  type NetworkComputerInfo,
  makeNetworkService,
  normalizeProxyInput,
} from "./NetworkService.ts";
import type { UpstreamProxy } from "./proxyDial.ts";

const COMPUTER: NetworkComputerInfo = { id: "env-1", name: "MacBook", kind: "desktop" };
const PASSWORD = "very-secret-proxy-password";

function makeStore() {
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

const OK: NetworkProxyCheck = {
  status: "ok",
  ip: "203.0.113.9",
  country: "DE",
  latencyMs: 120,
  at: "2026-11-26T00:00:00.000Z",
};

async function withService<A>(
  options: {
    store?: ReturnType<typeof makeStore>;
    env?: Record<string, string | undefined>;
    check?: (proxy: UpstreamProxy) => Promise<NetworkProxyCheck>;
    browserProxyPath?: string;
  },
  body: (
    service: Effect.Success<ReturnType<typeof makeNetworkService>>,
    env: Record<string, string | undefined>,
  ) => Effect.Effect<A, Error>,
): Promise<A> {
  const store = options.store ?? makeStore();
  const env = options.env ?? { PATH: "/bin" };
  const scope = Effect.runSync(Scope.make());
  try {
    return await Effect.runPromise(
      makeNetworkService({
        env,
        recheckMs: 0,
        accountRefreshMs: 0,
        engineBinary: null,
        checkProxy: options.check ?? (async () => OK),
        ...(options.browserProxyPath ? { browserProxyPath: options.browserProxyPath } : {}),
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

const proxyInput = {
  scheme: "socks5" as const,
  host: "proxy.example",
  port: 1080,
  username: "alice",
  password: PASSWORD,
};

describe("NetworkService", () => {
  it("is available with no proxy and no tunnel yet", async () => {
    const state = await withService({}, (service) => service.state(COMPUTER));
    expect(state).toMatchObject({
      available: true,
      tunnel: false,
      enabled: false,
      status: "off",
      exits: [],
      proxy: null,
    });
  });

  it("saves, checks and turns the proxy on: children get the bridge, never the password", async () => {
    resetKnownSecretsForTest();
    const store = makeStore();
    const checked: UpstreamProxy[] = [];
    await withService(
      {
        store,
        check: async (proxy) => {
          checked.push(proxy);
          return OK;
        },
      },
      (service, env) =>
        Effect.gen(function* () {
          const saved = yield* service.change({ proxy: proxyInput }, COMPUTER);
          expect(saved.status).toBe("off");
          expect(saved.proxy).toMatchObject({ host: "proxy.example", hasPassword: true });
          expect(saved.exits[0]).toMatchObject({ kind: "proxy", address: "203.0.113.9" });
          expect(env.HTTPS_PROXY).toBeUndefined();

          const on = yield* service.change({ enabled: true }, COMPUTER);
          expect(on).toMatchObject({ enabled: true, status: "on", exitId: "proxy" });
          expect(env.HTTPS_PROXY).toMatch(/^http:\/\/uno:[0-9a-f]+@127\.0\.0\.1:\d+$/);
          expect(env.NO_PROXY).toContain("uno.place");
          expect(checked.at(-1)).toMatchObject({ scheme: "socks5", password: PASSWORD });

          // The password goes nowhere: not the answer, not the env; logs redact it.
          expect(JSON.stringify(on)).not.toContain(PASSWORD);
          expect(JSON.stringify(env)).not.toContain(PASSWORD);
          expect(redactSecretsInText(`proxy ${PASSWORD} failed`)).not.toContain(PASSWORD);

          const off = yield* service.change({ enabled: false }, COMPUTER);
          expect(off.status).toBe("off");
          expect(env.HTTPS_PROXY).toBeUndefined();
          expect(env).toEqual({ PATH: "/bin" });
        }),
    );
    const record = JSON.parse(new TextDecoder().decode(store.memory.get(NETWORK_SECRET_NAME)));
    expect(record.proxy.password).toBe(PASSWORD);
  });

  it("on the desktop, the browser panel's file holds the bridge and the direct list while on", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "net-browser-")), "browser-proxy.json");
    await withService({ browserProxyPath: path }, (service, env) =>
      Effect.gen(function* () {
        yield* service.change({ proxy: { ...proxyInput, skip: ["*.corp.example"] } }, COMPUTER);
        expect(existsSync(path)).toBe(false);

        yield* service.change({ enabled: true }, COMPUTER);
        const file = JSON.parse(readFileSync(path, "utf8"));
        const bridge = new URL(env.HTTPS_PROXY!);
        expect(file).toMatchObject({
          server: `http://127.0.0.1:${bridge.port}`,
          username: "uno",
          password: bridge.password,
        });
        expect(file.bypass).toEqual(
          expect.arrayContaining(["localhost", ".uno.place", ".corp.example"]),
        );
        // The bridge's login only, never the person's proxy password.
        expect(readFileSync(path, "utf8")).not.toContain(PASSWORD);
        if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);

        yield* service.change({ enabled: false }, COMPUTER);
        expect(existsSync(path)).toBe(false);
      }),
    );
  });

  it("comes back on after a restart with the same bridge port", async () => {
    const store = makeStore();
    const first = await withService({ store }, (service, env) =>
      service
        .change({ proxy: proxyInput, enabled: true }, COMPUTER)
        .pipe(Effect.map(() => env.HTTPS_PROXY)),
    );
    const second = await withService({ store }, (service, env) =>
      service.state(COMPUTER).pipe(Effect.map((state) => ({ state, url: env.HTTPS_PROXY }))),
    );
    expect(second.state.enabled).toBe(true);
    expect(second.url).toBe(first);
  });

  it("reads down when the proxy stops answering, and keeps children on it", async () => {
    const failed: NetworkProxyCheck = {
      status: "failed",
      reason: "The proxy doesn't answer at this address and port.",
      at: "2026-11-26T00:00:00.000Z",
    };
    await withService({ check: async () => failed }, (service, env) =>
      Effect.gen(function* () {
        const state = yield* service.change({ proxy: proxyInput, enabled: true }, COMPUTER);
        expect(state.status).toBe("down");
        expect(state.exits[0]?.online).toBe(false);
        expect(env.HTTPS_PROXY).toBeDefined();
      }),
    );
  });

  it("keeps the saved password when the form leaves it out, forgets it for another proxy", () => {
    const saved = normalizeProxyInput(proxyInput, null);
    const { password: _password, ...rest } = proxyInput;
    expect(normalizeProxyInput(rest, saved).password).toBe(PASSWORD);
    expect(normalizeProxyInput({ ...rest, host: "other.example" }, saved).password).toBeNull();
    expect(normalizeProxyInput({ ...rest, password: "" }, saved).password).toBeNull();
    expect(normalizeProxyInput({ ...rest, host: "http://p.example:8080/" }, null).host).toBe(
      "p.example",
    );
    expect(() => normalizeProxyInput({ ...rest, host: "bad host" }, null)).toThrow(/host/);
    expect(() => normalizeProxyInput({ ...rest, skip: ["bad_host!"] }, null)).toThrow(/bad_host/);
  });

  it("refuses to turn on without a proxy, and restores the person's own variables", async () => {
    await withService({ env: { HTTPS_PROXY: "http://corp:3128" } }, (service, env) =>
      Effect.gen(function* () {
        const refused = yield* service
          .change({ enabled: true }, COMPUTER)
          .pipe(
            Effect.match({ onFailure: (error) => error.message, onSuccess: () => "turned on" }),
          );
        expect(refused).toBe("Add a proxy first.");
        yield* service.change({ proxy: proxyInput, enabled: true }, COMPUTER);
        expect(env.HTTPS_PROXY).toContain("127.0.0.1");
        yield* service.change({ proxy: null }, COMPUTER);
        expect(env.HTTPS_PROXY).toBe("http://corp:3128");
      }),
    );
  });
});
