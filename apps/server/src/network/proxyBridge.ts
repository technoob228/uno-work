/**
 * The daemon's local proxy (Network → Proxy, 26.11): an HTTP proxy on
 * 127.0.0.1 that every child of Uno Work is pointed at (`proxyEnv.ts`). It
 * forwards to the person's proxy with the person's login, so a child never
 * sees that login, and one HTTP proxy URL covers SOCKS5 proxies too.
 *
 * - `CONNECT host:port` (HTTPS, git over https, anything TLS): a stream
 *   through the person's proxy (`proxyDial.ts`).
 * - `GET http://…` (plain HTTP): forwarded to an HTTP(S) proxy as is, or
 *   through a SOCKS5 stream.
 *
 * Only for those who hold the token: `http://uno:<token>@127.0.0.1:<port>`
 * (other users of this computer can't ride the person's proxy).
 *
 * Off is not "closed": a child started while it was on keeps the bridge's
 * address in its environment, so with no upstream the bridge goes direct —
 * the same as a child started while off. On, with the proxy not answering,
 * the bridge answers 502: nothing goes around the proxy.
 */
import { timingSafeEqual } from "node:crypto";
import * as Http from "node:http";
import * as Https from "node:https";
import * as Net from "node:net";

import { type UpstreamProxy, basicProxyAuthorization, dialThroughProxy } from "./proxyDial.ts";

export const BRIDGE_USER = "uno";

export interface ProxyBridge {
  readonly port: number;
  /** What children get: with the token, never the person's login. */
  readonly url: string;
  /** null — go direct (Network off). */
  readonly setUpstream: (upstream: UpstreamProxy | null) => void;
  readonly close: () => Promise<void>;
}

const HOP_BY_HOP = new Set([
  "proxy-authorization",
  "proxy-connection",
  "proxy-authenticate",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardHeaders(headers: Http.IncomingHttpHeaders): Http.OutgoingHttpHeaders {
  const out: Http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
  }
  return out;
}

function tokenMatches(header: string | undefined, token: Buffer): boolean {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? "");
  if (!match?.[1]) return false;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  const given = Buffer.from(decoded.slice(colon + 1), "utf8");
  return given.length === token.length && timingSafeEqual(given, token);
}

/** `host:port` of a CONNECT; IPv6 in brackets. null — not one. */
export function parseConnectTarget(raw: string | undefined): { host: string; port: number } | null {
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|([^\s:/[\]]+)):(\d{1,5})$/.exec(raw ?? "");
  if (!match) return null;
  const port = Number(match[3]);
  const host = match[1] ?? match[2] ?? "";
  return port >= 1 && port <= 65_535 && host ? { host, port } : null;
}

function dial(upstream: UpstreamProxy | null, host: string, port: number): Promise<Net.Socket> {
  if (upstream) return dialThroughProxy(upstream, host, port);
  return new Promise((resolve, reject) => {
    const socket = Net.connect({ host, port });
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function refuse(socket: Net.Socket, status: string, extra = "") {
  if (socket.writable) {
    socket.end(`HTTP/1.1 ${status}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  socket.destroy();
}

const AUTH_CHALLENGE = 'Proxy-Authenticate: Basic realm="Uno Work"\r\n';

export function startProxyBridge(input: {
  readonly token: string;
  /** The port it had last time (children keep it in their env); 0 — any. */
  readonly port: number;
  readonly upstream: UpstreamProxy | null;
}): Promise<ProxyBridge> {
  const token = Buffer.from(input.token, "utf8");
  let upstream = input.upstream;
  const sockets = new Set<Net.Socket>();
  /** Streams to the far side: cut when the exit changes, so nothing stays on the old one. */
  const tunnels = new Set<Net.Socket>();

  const server = Http.createServer((request, response) => {
    if (!tokenMatches(request.headers["proxy-authorization"], token)) {
      response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="Uno Work"' }).end();
      return;
    }
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400).end("Uno Work's proxy takes absolute http:// addresses.");
      return;
    }
    if (target.protocol !== "http:") {
      response.writeHead(400).end("Use CONNECT for https.");
      return;
    }
    const current = upstream;
    const headers = forwardHeaders(request.headers);
    const port = Number(target.port) || 80;
    const onUpstream = (upstreamResponse: Http.IncomingMessage) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        forwardHeaders(upstreamResponse.headers),
      );
      upstreamResponse.pipe(response);
    };
    let outgoing: Http.ClientRequest;
    if (current && current.scheme !== "socks5") {
      // An HTTP(S) proxy takes the absolute address itself.
      const auth = basicProxyAuthorization(current);
      const options: Https.RequestOptions = {
        host: current.host,
        port: current.port,
        method: request.method,
        path: target.href,
        headers: auth ? { ...headers, "proxy-authorization": auth } : headers,
        agent: false,
      };
      outgoing =
        current.scheme === "https"
          ? Https.request(
              { ...options, servername: Net.isIP(current.host) ? undefined : current.host },
              onUpstream,
            )
          : Http.request(options, onUpstream);
    } else {
      outgoing = Http.request(
        {
          host: target.hostname,
          port,
          method: request.method,
          path: `${target.pathname}${target.search}`,
          headers,
          createConnection: (_options, done) => {
            dial(current, target.hostname.replace(/^\[|\]$/g, ""), port).then(
              (socket) => done(null, socket),
              (error: Error) => done(error, undefined as unknown as Net.Socket),
            );
            return undefined;
          },
        },
        onUpstream,
      );
    }
    outgoing.on("error", () => {
      if (!response.headersSent) response.writeHead(502).end();
      else response.destroy();
    });
    request.pipe(outgoing);
  });

  server.on("connect", (request: Http.IncomingMessage, client: Net.Socket, head: Buffer) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    if (!tokenMatches(request.headers["proxy-authorization"], token)) {
      refuse(client, "407 Proxy Authentication Required", AUTH_CHALLENGE);
      return;
    }
    const target = parseConnectTarget(request.url);
    if (!target) {
      refuse(client, "400 Bad Request");
      return;
    }
    dial(upstream, target.host, target.port).then(
      (remote) => {
        sockets.add(remote);
        tunnels.add(remote);
        remote.once("close", () => {
          sockets.delete(remote);
          tunnels.delete(remote);
        });
        if (client.destroyed) {
          remote.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) remote.write(head);
        remote.on("error", () => client.destroy());
        client.on("error", () => remote.destroy());
        remote.pipe(client);
        client.pipe(remote);
      },
      () => refuse(client, "502 Bad Gateway"),
    );
  });

  server.on("connection", (socket: Net.Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // A proxy that is chatty (long downloads, idle keep-alive) must not be cut by Node's defaults.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 30_000;

  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });

  return listen(input.port)
    .catch((error) => {
      // Last time's port is taken: any free one (children started since get the new one).
      if (input.port !== 0) return listen(0);
      throw error;
    })
    .then((port) => ({
      port,
      url: `http://${BRIDGE_USER}:${encodeURIComponent(input.token)}@127.0.0.1:${port}`,
      setUpstream: (next) => {
        upstream = next;
        for (const tunnel of tunnels) tunnel.destroy();
      },
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    }));
}
