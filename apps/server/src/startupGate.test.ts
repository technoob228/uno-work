import * as Http from "node:http";
import type { AddressInfo } from "node:net";
import * as Net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  STARTUP_GATE_HEADER,
  STARTUP_STATUS_PATH,
  installStartupGate,
  type StartupGateHandle,
} from "./startupGate.ts";

interface Started {
  server: Http.Server;
  gate: StartupGateHandle;
  port: number;
}

const servers: Http.Server[] = [];

async function start(): Promise<Started> {
  const server = Http.createServer();
  const gate = installStartupGate(server, { uptimeSeconds: () => 7 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { server, gate, port: (server.address() as AddressInfo).port };
}

async function get(port: number, path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

function rawUpgrade(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = Net.connect(port, "127.0.0.1", () => {
      socket.write(
        "GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("end", () => resolve(data));
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error(`upgrade hung, got: ${data}`));
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("startupGate", () => {
  it("answers browser navigation with the branded starting page instead of hanging", async () => {
    const { port } = await start();
    const res = await get(port, "/pair", { accept: "text/html,application/xhtml+xml" });
    expect(res.status).toBe(503);
    expect(res.headers.get(STARTUP_GATE_HEADER)).toBe("1");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("retry-after")).toBe("2");
    expect(res.body).toContain("Starting your computer");
    // Страница не тянет ассеты, которых ещё некому отдать.
    expect(res.body).not.toMatch(/<(link|script)[^>]+(href|src)=/);
  });

  it("reports startup status as JSON with the daemon uptime", async () => {
    const { port } = await start();
    const res = await get(port, STARTUP_STATUS_PATH);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ starting: true, phase: "daemon", uptimeSeconds: 7 });
  });

  it("answers API calls with 503 + Retry-After", async () => {
    const { port } = await start();
    const res = await get(port, "/api/auth/session", { accept: "application/json" });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(JSON.parse(res.body)).toMatchObject({ error: "starting" });
  });

  it("rejects WebSocket upgrades with 503 instead of silently dropping them", async () => {
    const { port } = await start();
    const response = await rawUpgrade(port);
    expect(response).toMatch(/^HTTP\/1\.1 503 /);
  });

  it("steps aside once the real router is attached", async () => {
    const { server, gate, port } = await start();
    server.on("request", (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("router");
    });
    server.on("upgrade", (_req, socket) => {
      socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
    });

    // Даже в том же тике, до снятия шлюза, отвечает только роутер.
    const immediate = await get(port, "/", { accept: "text/html" });
    expect(immediate).toMatchObject({ status: 200, body: "router" });
    expect(immediate.headers.get(STARTUP_GATE_HEADER)).toBeNull();

    await new Promise((resolve) => setImmediate(resolve));
    expect(gate.released()).toBe(true);
    expect(server.listenerCount("request")).toBe(1);
    expect(server.listenerCount("upgrade")).toBe(1);

    const status = await get(port, STARTUP_STATUS_PATH);
    expect(status).toMatchObject({ status: 200, body: "router" });
    expect(await rawUpgrade(port)).toMatch(/^HTTP\/1\.1 101 /);
  });
});
