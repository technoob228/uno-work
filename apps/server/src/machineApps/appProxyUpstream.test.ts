import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { openAppUpstream } from "./appProxyUpstream.ts";

const servers: http.Server[] = [];

async function startApp(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
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

describe("openAppUpstream", () => {
  it("sends the request to 127.0.0.1:<port> with the given path, headers and body", async () => {
    let seen: { method?: string; url?: string; host?: string; cookie?: string; body?: string } = {};
    const port = await startApp(async (req, res) => {
      seen = {
        method: req.method,
        url: req.url,
        host: req.headers.host,
        cookie: req.headers.cookie,
        body: await readAll(req),
      };
      res.writeHead(201, { "content-type": "application/json", "set-cookie": "x=1" });
      res.end('{"ok":true}');
    });
    const response = await openAppUpstream({
      port,
      method: "POST",
      path: "/api/refresh?x=1",
      headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" },
      body: Readable.from([Buffer.from('{"a":'), Buffer.from("1}")], { objectMode: false }),
      signal: new AbortController().signal,
    });
    expect(response.statusCode).toBe(201);
    expect(await readAll(response)).toBe('{"ok":true}');
    expect(seen).toEqual({
      method: "POST",
      url: "/api/refresh?x=1",
      host: `127.0.0.1:${port}`,
      cookie: undefined,
      body: '{"a":1}',
    });
  });

  it("resolves at the headers and streams the rest (server-sent events)", async () => {
    const control: { finish?: () => void } = {};
    const port = await startApp((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      control.finish = () => res.end("data: 2\n\n");
    });
    const response = await openAppUpstream({
      port,
      method: "GET",
      path: "/events",
      headers: {},
      body: null,
      signal: new AbortController().signal,
    });
    expect(response.headers["content-type"]).toBe("text/event-stream");
    const reading = readAll(response);
    control.finish?.();
    expect(await reading).toBe("data: 1\n\ndata: 2\n\n");
  });

  it("rejects when nothing listens on the port", async () => {
    const port = await startApp(() => {});
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(
      openAppUpstream({
        port,
        method: "GET",
        path: "/",
        headers: {},
        body: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });

  it("gives up when the app never answers", async () => {
    const port = await startApp(() => {});
    await expect(
      openAppUpstream({
        port,
        method: "GET",
        path: "/",
        headers: {},
        body: null,
        signal: new AbortController().signal,
        headersTimeoutMs: 100,
      }),
    ).rejects.toThrow(/didn't answer/);
  });
});
