/**
 * The byte pump of the app proxy (`appProxyHttp.ts`): one request to an app
 * on this machine's loopback, resolved with the app's response once its
 * headers arrive. Kept apart (node:http only) so it is tested on a real socket.
 */
import http from "node:http";
import type { Readable } from "node:stream";

/** Waiting for the app's response headers; a stream after that has no limit. */
export const UPSTREAM_HEADERS_TIMEOUT_MS = 120_000;

const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

export function openAppUpstream(input: {
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Readable | null;
  readonly signal: AbortSignal;
  readonly headersTimeoutMs?: number;
}): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const upstream = http.request({
      // A literal address: no name lookup, no Host-driven routing.
      host: "127.0.0.1",
      port: input.port,
      method: input.method,
      path: input.path,
      // HTTP/1.1 needs a Host; never the browser's (that is Work's name).
      headers: { ...input.headers, host: `127.0.0.1:${input.port}` },
      agent: upstreamAgent,
      setHost: false,
      signal: input.signal,
    });
    upstream.setTimeout(input.headersTimeoutMs ?? UPSTREAM_HEADERS_TIMEOUT_MS, () => {
      upstream.destroy(new Error("The app didn't answer in time."));
    });
    upstream.once("response", (response) => {
      // Long-lived answers (server-sent events) may stay quiet for a while.
      upstream.setTimeout(0);
      resolve(response);
    });
    // `on`, not `once`: a socket error after the headers (the app dies
    // mid-stream) must not become an unhandled 'error' event.
    upstream.on("error", reject);
    if (input.body) {
      input.body.on("error", (cause) => upstream.destroy(cause));
      input.body.pipe(upstream);
    } else {
      upstream.end();
    }
  });
}
