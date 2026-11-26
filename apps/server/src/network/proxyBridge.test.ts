import * as Http from "node:http";
import * as Net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type ProxyBridge, parseConnectTarget, startProxyBridge } from "./proxyBridge.ts";
import { ProxyDialError, type UpstreamProxy, dialThroughProxy } from "./proxyDial.ts";

const LOGIN = { username: "alice", password: "s3cret:with@chars" };

function listen(server: Net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as Net.AddressInfo).port));
  });
}

/** The site: answers its path, and who connected. */
function makeTarget() {
  return Http.createServer((request, response) => {
    response.end(`hello ${request.url}`);
  });
}

/** An HTTP proxy that wants alice's login; counts what went through it. */
function makeHttpProxy(seen: string[]) {
  const expected = `Basic ${Buffer.from(`${LOGIN.username}:${LOGIN.password}`).toString("base64")}`;
  const server = Http.createServer((request, response) => {
    if (request.headers["proxy-authorization"] !== expected) {
      response.writeHead(407).end();
      return;
    }
    seen.push(`GET ${request.url}`);
    const url = new URL(request.url ?? "");
    const out = Http.request(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: { host: url.host },
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    out.end();
  });
  server.on("connect", (request: Http.IncomingMessage, client: Net.Socket) => {
    if (request.headers["proxy-authorization"] !== expected) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    seen.push(`CONNECT ${request.url}`);
    const [host, port] = (request.url ?? "").split(":");
    const remote = Net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 OK\r\n\r\n");
      remote.pipe(client);
      client.pipe(remote);
    });
    remote.on("error", () => client.destroy());
  });
  return server;
}

/** A SOCKS5 proxy with a login (RFC 1929). */
function makeSocksProxy(seen: string[]) {
  return Net.createServer((client) => {
    let stage = 0;
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2 + (buffer[1] ?? 0)) {
        const methods = [...buffer.subarray(2, 2 + (buffer[1] ?? 0))];
        buffer = buffer.subarray(2 + (buffer[1] ?? 0));
        client.write(Buffer.from([5, methods.includes(2) ? 2 : 0xff]));
        stage = 1;
      }
      if (stage === 1 && buffer.length >= 2) {
        const userLength = buffer[1] ?? 0;
        const passLength = buffer[2 + userLength];
        if (passLength === undefined || buffer.length < 3 + userLength + passLength) return;
        const user = buffer.subarray(2, 2 + userLength).toString();
        const pass = buffer.subarray(3 + userLength, 3 + userLength + passLength).toString();
        buffer = buffer.subarray(3 + userLength + passLength);
        const ok = user === LOGIN.username && pass === LOGIN.password;
        client.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) {
          client.end();
          return;
        }
        stage = 2;
      }
      if (stage === 2 && buffer.length >= 7 && buffer[3] === 3) {
        const nameLength = buffer[4] ?? 0;
        if (buffer.length < 7 + nameLength) return;
        const host = buffer.subarray(5, 5 + nameLength).toString();
        const port = buffer.readUInt16BE(5 + nameLength);
        const rest = buffer.subarray(7 + nameLength);
        stage = 3;
        client.off("data", onData);
        seen.push(`SOCKS ${host}:${port}`);
        const remote = Net.connect(port, host === "localhost" ? "127.0.0.1" : host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rest.length > 0) remote.write(rest);
          remote.pipe(client);
          client.pipe(remote);
        });
        remote.on("error", () => client.destroy());
      }
    };
    client.on("data", onData);
    client.on("error", () => undefined);
  });
}

const TOKEN = "bridge-token-0123456789";
const auth = (token = TOKEN) => `Basic ${Buffer.from(`uno:${token}`).toString("base64")}`;

/** GET `path` of the target through the bridge with CONNECT, as curl does for https. */
function getViaConnect(
  bridge: ProxyBridge,
  targetPort: number,
  token = TOKEN,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = Http.request({
      host: "127.0.0.1",
      port: bridge.port,
      method: "CONNECT",
      path: `localhost:${targetPort}`,
      headers: { "proxy-authorization": auth(token) },
    });
    request.on("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        resolve({ status: response.statusCode ?? 0, body: "" });
        return;
      }
      socket.write(`GET /tunnel HTTP/1.0\r\nHost: localhost\r\n\r\n`);
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: 200, body: text.slice(text.indexOf("\r\n\r\n") + 4) });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

/** A plain http:// GET through the bridge (absolute form). */
function getPlain(bridge: ProxyBridge, targetPort: number, token = TOKEN) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = Http.request(
      {
        host: "127.0.0.1",
        port: bridge.port,
        path: `http://localhost:${targetPort}/plain?x=1`,
        headers: { "proxy-authorization": auth(token), host: `localhost:${targetPort}` },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("Network proxy bridge", () => {
  const seen: string[] = [];
  const target = makeTarget();
  const httpProxy = makeHttpProxy(seen);
  const socksProxy = makeSocksProxy(seen);
  let targetPort = 0;
  let httpUpstream: UpstreamProxy;
  let socksUpstream: UpstreamProxy;
  let bridge: ProxyBridge;

  beforeAll(async () => {
    targetPort = await listen(target);
    httpUpstream = {
      scheme: "http",
      host: "127.0.0.1",
      port: await listen(httpProxy),
      ...LOGIN,
    };
    socksUpstream = {
      scheme: "socks5",
      host: "127.0.0.1",
      port: await listen(socksProxy),
      ...LOGIN,
    };
    bridge = await startProxyBridge({ token: TOKEN, port: 0, upstream: null });
  });

  afterAll(async () => {
    await bridge.close();
    for (const server of [target, httpProxy, socksProxy]) server.close();
  });

  it("asks for the token and never lets others ride the proxy", async () => {
    bridge.setUpstream(httpUpstream);
    expect((await getViaConnect(bridge, targetPort, "wrong")).status).toBe(407);
    expect((await getPlain(bridge, targetPort, "wrong")).status).toBe(407);
    expect(bridge.url).toBe(`http://uno:${TOKEN}@127.0.0.1:${bridge.port}`);
  });

  it("carries https (CONNECT) and plain http through an HTTP proxy with its login", async () => {
    bridge.setUpstream(httpUpstream);
    seen.length = 0;
    expect(await getViaConnect(bridge, targetPort)).toEqual({ status: 200, body: "hello /tunnel" });
    const plain = await getPlain(bridge, targetPort);
    expect(plain).toEqual({ status: 200, body: "hello /plain?x=1" });
    expect(seen).toEqual([
      `CONNECT localhost:${targetPort}`,
      `GET http://localhost:${targetPort}/plain?x=1`,
    ]);
  });

  it("carries both through a SOCKS5 proxy with a login", async () => {
    bridge.setUpstream(socksUpstream);
    seen.length = 0;
    expect(await getViaConnect(bridge, targetPort)).toEqual({ status: 200, body: "hello /tunnel" });
    expect(await getPlain(bridge, targetPort)).toEqual({ status: 200, body: "hello /plain?x=1" });
    expect(seen).toEqual([`SOCKS localhost:${targetPort}`, `SOCKS localhost:${targetPort}`]);
  });

  it("answers 502 instead of going around a proxy that refuses the login", async () => {
    bridge.setUpstream({ ...httpUpstream, password: "nope" });
    expect((await getViaConnect(bridge, targetPort)).status).toBe(502);
    bridge.setUpstream({ ...socksUpstream, password: "nope" });
    expect((await getViaConnect(bridge, targetPort)).status).toBe(502);
    expect((await getPlain(bridge, targetPort)).status).toBe(502);
  });

  it("goes direct while off (children started while on keep the bridge's address)", async () => {
    bridge.setUpstream(null);
    seen.length = 0;
    expect(await getViaConnect(bridge, targetPort)).toEqual({ status: 200, body: "hello /tunnel" });
    expect(seen).toEqual([]);
  });

  it("says why a dial failed, without the login", async () => {
    const closed = await listen(Net.createServer((socket) => socket.destroy()));
    const silent = await listen(Net.createServer(() => undefined));
    const failures = await Promise.all([
      dialThroughProxy({ ...httpUpstream, password: "nope" }, "localhost", targetPort).catch(
        (error: ProxyDialError) => error.failure,
      ),
      dialThroughProxy({ ...socksUpstream, password: "nope" }, "localhost", targetPort).catch(
        (error: ProxyDialError) => error.failure,
      ),
      dialThroughProxy({ ...httpUpstream, port: closed }, "localhost", targetPort).catch(
        (error: ProxyDialError) => error.failure,
      ),
      dialThroughProxy({ ...httpUpstream, port: silent }, "localhost", targetPort, 1_000).catch(
        (error: ProxyDialError) => error.failure,
      ),
    ]);
    expect(failures).toEqual(["auth", "auth", "protocol", "timeout"]);
  });

  it("parses CONNECT targets", () => {
    expect(parseConnectTarget("example.com:443")).toEqual({ host: "example.com", port: 443 });
    expect(parseConnectTarget("[2001:db8::1]:8443")).toEqual({ host: "2001:db8::1", port: 8443 });
    expect(parseConnectTarget("example.com")).toBeNull();
    expect(parseConnectTarget("a b:1")).toBeNull();
    expect(parseConnectTarget("x:70000")).toBeNull();
  });
});
