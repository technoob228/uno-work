/**
 * A TCP stream to `host:port` through the person's proxy: HTTP CONNECT
 * (`http`), the same over TLS to the proxy (`https`), or SOCKS5 with the
 * name resolved by the proxy (`socks5`, RFC 1928 / 1929). The bridge and
 * "Check" both use it, so a check proves what children will get.
 *
 * Errors carry a `reason` for the person ("Wrong login or password") and
 * never the login itself.
 */
import * as Net from "node:net";
import * as Tls from "node:tls";

import type { NetworkProxyScheme } from "@t3tools/contracts";

export interface UpstreamProxy {
  readonly scheme: NetworkProxyScheme;
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly password: string | null;
}

export type ProxyDialFailure =
  | "unreachable" // the proxy's own address doesn't answer / refuses
  | "auth" // the proxy wants another login or password
  | "refused" // the proxy answered but won't go to that address
  | "protocol" // it doesn't speak what the type says
  | "timeout";

export class ProxyDialError extends Error {
  readonly failure: ProxyDialFailure;
  constructor(failure: ProxyDialFailure, message: string) {
    super(message);
    this.name = "ProxyDialError";
    this.failure = failure;
  }
}

export const PROXY_DIAL_TIMEOUT_MS = 10_000;

/** A sentence for the person. */
export function dialFailureReason(error: unknown): string {
  if (!(error instanceof ProxyDialError)) return "The proxy check didn't finish.";
  switch (error.failure) {
    case "unreachable":
      return "The proxy doesn't answer at this address and port.";
    case "auth":
      return "The proxy didn't accept the login or password.";
    case "refused":
      return "The proxy answered but couldn't reach the internet.";
    case "protocol":
      return "It doesn't answer like this type of proxy. Check the type and port.";
    case "timeout":
      return "The proxy took too long to answer.";
  }
}

/** Reads from `socket` until `done(buffer)` returns a result, with the leftover bytes. */
function readUntil<T>(
  socket: Net.Socket,
  done: (buffer: Buffer) => { value: T; used: number } | null,
): Promise<{ value: T; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 16_384) {
        cleanup();
        reject(new ProxyDialError("protocol", "proxy answer too long"));
        return;
      }
      let parsed: { value: T; used: number } | null;
      try {
        parsed = done(buffer);
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (parsed) {
        cleanup();
        resolve({ value: parsed.value, rest: buffer.subarray(parsed.used) });
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new ProxyDialError("protocol", "proxy closed the connection"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(
        error instanceof ProxyDialError ? error : new ProxyDialError("protocol", error.message),
      );
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

function openToProxy(proxy: UpstreamProxy): Promise<Net.Socket> {
  return new Promise((resolve, reject) => {
    const socket =
      proxy.scheme === "https"
        ? Tls.connect({ host: proxy.host, port: proxy.port, servername: sniName(proxy.host) })
        : Net.connect({ host: proxy.host, port: proxy.port });
    const ready = proxy.scheme === "https" ? "secureConnect" : "connect";
    const onError = (error: NodeJS.ErrnoException) => {
      socket.destroy();
      const unreachable = UNREACHABLE_CODES.has(error.code ?? "");
      reject(new ProxyDialError(unreachable ? "unreachable" : "protocol", error.message));
    };
    socket.once("error", onError);
    socket.once(ready, () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

/** TLS SNI takes names only. */
function sniName(host: string): string | undefined {
  return Net.isIP(host) === 0 ? host : undefined;
}

function hostForRequest(host: string): string {
  return Net.isIP(host) === 6 ? `[${host}]` : host;
}

/** `Proxy-Authorization` value for an HTTP(S) proxy; null without a login. */
export function basicProxyAuthorization(proxy: UpstreamProxy): string | null {
  if (!proxy.username && !proxy.password) return null;
  const pair = `${proxy.username ?? ""}:${proxy.password ?? ""}`;
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
}

async function connectViaHttp(
  socket: Net.Socket,
  proxy: UpstreamProxy,
  host: string,
  port: number,
) {
  const target = `${hostForRequest(host)}:${port}`;
  const auth = basicProxyAuthorization(proxy);
  socket.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
      (auth ? `Proxy-Authorization: ${auth}\r\n` : "") +
      "\r\n",
  );
  const { value: status, rest } = await readUntil(socket, (buffer) => {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return null;
    const line = buffer.subarray(0, buffer.indexOf("\r\n")).toString("latin1");
    const match = /^HTTP\/1\.[01] (\d{3})/.exec(line);
    if (!match) throw new ProxyDialError("protocol", "not an HTTP proxy answer");
    return { value: Number(match[1]), used: end + 4 };
  });
  if (status === 407) throw new ProxyDialError("auth", "proxy wants authentication");
  if (status < 200 || status > 299) {
    throw new ProxyDialError("refused", `proxy answered ${status}`);
  }
  return rest;
}

async function connectViaSocks(
  socket: Net.Socket,
  proxy: UpstreamProxy,
  host: string,
  port: number,
) {
  const withLogin = Boolean(proxy.username || proxy.password);
  socket.write(Buffer.from(withLogin ? [5, 2, 0, 2] : [5, 1, 0]));
  const { value: method } = await readUntil(socket, (buffer) => {
    if (buffer.length < 2) return null;
    if (buffer[0] !== 5) throw new ProxyDialError("protocol", "not a SOCKS5 proxy");
    return { value: buffer[1], used: 2 };
  });
  if (method === 2) {
    const user = Buffer.from(proxy.username ?? "", "utf8");
    const pass = Buffer.from(proxy.password ?? "", "utf8");
    if (user.length > 255 || pass.length > 255) {
      throw new ProxyDialError("auth", "login too long for SOCKS5");
    }
    socket.write(
      Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]),
    );
    const { value: ok } = await readUntil(socket, (buffer) =>
      buffer.length < 2 ? null : { value: buffer[1] === 0, used: 2 },
    );
    if (!ok) throw new ProxyDialError("auth", "SOCKS5 login refused");
  } else if (method !== 0) {
    throw new ProxyDialError(withLogin ? "protocol" : "auth", "SOCKS5 wants another method");
  }
  const ipKind = Net.isIP(host);
  const address =
    ipKind === 4
      ? Buffer.from([1, ...host.split(".").map(Number)])
      : ipKind === 6
        ? Buffer.concat([Buffer.from([4]), ipv6Bytes(host)])
        : Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host, "utf8")]);
  const portBytes = Buffer.from([port >> 8, port & 0xff]);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, portBytes]));
  const { value: reply, rest } = await readUntil(socket, (buffer) => {
    if (buffer.length < 5) return null;
    if (buffer[0] !== 5) throw new ProxyDialError("protocol", "not a SOCKS5 reply");
    const kind = buffer[3];
    const length = kind === 1 ? 4 : kind === 4 ? 16 : kind === 3 ? 1 + (buffer[4] ?? 0) : -1;
    if (length < 0) throw new ProxyDialError("protocol", "bad SOCKS5 reply");
    const total = 4 + length + 2;
    return buffer.length < total ? null : { value: buffer[1], used: total };
  });
  if (reply !== 0) throw new ProxyDialError("refused", `SOCKS5 reply ${reply}`);
  return rest;
}

function ipv6Bytes(address: string): Buffer {
  const [head = "", tail = ""] = address.split("::");
  const part = (text: string) => (text ? text.split(":") : []);
  const left = part(head);
  const right = address.includes("::") ? part(tail) : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16) || 0, index * 2));
  return bytes;
}

/**
 * A stream to `host:port` through `proxy`. Bytes the proxy sent right after
 * its answer are put back, so the caller reads the stream from its start.
 */
export async function dialThroughProxy(
  proxy: UpstreamProxy,
  host: string,
  port: number,
  timeoutMs = PROXY_DIAL_TIMEOUT_MS,
): Promise<Net.Socket> {
  let socket: Net.Socket | null = null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new ProxyDialError("timeout", "proxy took too long"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        socket = await openToProxy(proxy);
        // Too late: the caller has gone; don't leave the stream open.
        if (timedOut) socket.destroy();
        const rest =
          proxy.scheme === "socks5"
            ? await connectViaSocks(socket, proxy, host, port)
            : await connectViaHttp(socket, proxy, host, port);
        if (rest.length > 0) socket.unshift(rest);
        return socket;
      })(),
      timeout,
    ]);
  } catch (error) {
    (socket as Net.Socket | null)?.destroy();
    throw error instanceof ProxyDialError
      ? error
      : new ProxyDialError("protocol", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}
