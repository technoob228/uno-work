/**
 * The tunnel for real: the daemon's NetworkService runs the real uno-net
 * (built from native/uno-net) against a real WireGuard exit
 * (cmd/uno-net-testexit: amneziawg-go + netstack on loopback UDP, an echo on
 * 10.66.0.1:7 and a DNS answering echo.test). What a child of Uno Work does
 * is what this test does: CONNECT through the bridge in HTTPS_PROXY.
 *
 * Needs Go; skipped without it.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as Net from "node:net";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { createInterface } from "node:readline";

import type { NetworkProxyCheck, NetworkState } from "@t3tools/contracts";
import { Effect, Exit, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { type NetworkComputerInfo, makeNetworkService } from "./NetworkService.ts";

const NATIVE = Path.resolve(import.meta.dirname, "../../../../native/uno-net");
const COMPUTER: NetworkComputerInfo = { id: "env-1", name: "MacBook", kind: "desktop" };

const hasGo = (() => {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function memoryStore() {
  const memory = new Map<string, Uint8Array>();
  return {
    get: (name: string) => Effect.succeed(memory.get(name) ?? null),
    set: (name: string, value: Uint8Array) => Effect.sync(() => void memory.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name: string) => Effect.sync(() => void memory.delete(name)),
  };
}

/** A CONNECT through the bridge; resolves with the first bytes echoed, or the refusal line. */
function connectThrough(proxyUrl: string, host: string, port: number): Promise<string> {
  const url = new URL(proxyUrl);
  const auth = Buffer.from(
    `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
  ).toString("base64");
  return new Promise((resolve, reject) => {
    const socket = Net.connect({ host: url.hostname, port: Number(url.port) });
    let buffer = "";
    let established = false;
    socket.setTimeout(15_000, () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
    socket.on("connect", () => {
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!established) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const status = buffer.slice(0, buffer.indexOf("\r\n"));
        if (!/ 200 /.test(status)) {
          socket.destroy();
          resolve(status);
          return;
        }
        established = true;
        buffer = buffer.slice(end + 4);
        socket.write("hello through the tunnel");
      }
      if (established && buffer.length >= "hello through the tunnel".length) {
        socket.destroy();
        resolve(buffer);
      }
    });
    socket.on("error", reject);
  });
}

async function waitFor(
  read: () => Promise<NetworkState>,
  ok: (state: NetworkState) => boolean,
  ms: number,
): Promise<NetworkState> {
  const until = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
    last = await read();
  }
  return last;
}

describe.skipIf(!hasGo)("Network tunnel through the real engine", () => {
  let dir = "";
  let unoNet = "";
  let exit: ChildProcess | null = null;
  let conf = "";

  beforeAll(async () => {
    dir = mkdtempSync(Path.join(tmpdir(), "uno-net-test-"));
    unoNet = Path.join(dir, "uno-net");
    const testExit = Path.join(dir, "uno-net-testexit");
    execFileSync("go", ["build", "-o", unoNet, "./cmd/uno-net"], { cwd: NATIVE });
    execFileSync("go", ["build", "-o", testExit, "./cmd/uno-net-testexit"], { cwd: NATIVE });
    exit = spawn(testExit, [], { stdio: ["pipe", "pipe", "inherit"] });
    conf = await new Promise<string>((resolve) => {
      createInterface({ input: exit!.stdout! }).once("line", (line) => {
        resolve((JSON.parse(line) as { conf: string }).conf);
      });
    });
  }, 180_000);

  afterAll(() => {
    exit?.stdin?.end();
    exit?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("imports a config, carries children through it, and goes closed when the exit dies", async () => {
    const env: Record<string, string | undefined> = { PATH: process.env["PATH"] };
    const scope = Effect.runSync(Scope.make());
    const okCheck: NetworkProxyCheck = {
      status: "ok",
      ip: "10.66.0.1",
      country: null,
      latencyMs: 1,
      at: new Date().toISOString(),
    };
    try {
      const service = await Effect.runPromise(
        makeNetworkService({
          env,
          engineBinary: unoNet,
          recheckMs: 0,
          accountRefreshMs: 0,
          // No internet behind the test exit: the address echo is faked.
          checkProxy: async () => okCheck,
        }).pipe(
          Effect.provideService(ServerSecretStore, memoryStore()),
          Effect.provideService(Scope.Scope, scope),
        ),
      );
      const read = () => Effect.runPromise(service.state(COMPUTER));

      const imported = await Effect.runPromise(
        service.change({ importConfig: { conf, label: "Test exit" } }, COMPUTER),
      );
      expect(imported.enabled).toBe(true);
      expect(imported.exits.find((e) => e.id === imported.exitId)).toMatchObject({
        kind: "config",
        label: "Test exit",
        protocols: ["wireguard"],
        addressType: "unknown",
      });
      // The config's private key goes nowhere.
      const privateKey = /PrivateKey = (\S+)/.exec(conf)?.[1] ?? "missing";
      expect(JSON.stringify(imported)).not.toContain(privateKey);
      expect(JSON.stringify(env)).not.toContain(privateKey);

      const on = await waitFor(read, (s) => s.status === "on", 20_000);
      expect(on.status).toBe("on");
      expect(on.activeProtocol).toBe("wireguard");
      expect(on.strict).toBe(false);

      const proxyUrl = env["HTTPS_PROXY"] ?? "";
      expect(proxyUrl).toMatch(/^http:\/\/uno:[0-9a-f]+@127\.0\.0\.1:\d+$/);
      expect(await connectThrough(proxyUrl, "10.66.0.1", 7)).toBe("hello through the tunnel");
      // Names resolve inside the tunnel.
      expect(await connectThrough(proxyUrl, "echo.test", 7)).toBe("hello through the tunnel");

      // The exit dies: down, and the bridge refuses instead of going direct.
      exit?.kill("SIGKILL");
      const down = await waitFor(read, (s) => s.status === "down", 40_000);
      expect(down.status).toBe("down");
      expect(down.reason).toBeTruthy();
      expect(await connectThrough(proxyUrl, "10.66.0.1", 7)).toMatch(/502/);

      const off = await Effect.runPromise(service.change({ enabled: false }, COMPUTER));
      expect(off.status).toBe("off");
      expect(env["HTTPS_PROXY"]).toBeUndefined();
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  }, 120_000);
});
