/**
 * The address sites see, from Cloudflare's trace (`ip=…`, `loc=…`): no key,
 * no third-party account. The machine's browser asks it too
 * (`serverBrowser.ts`); Network's "Check" asks it through the person's proxy.
 */
import type * as Net from "node:net";
import * as Tls from "node:tls";

import type { NetworkProxyCheck } from "@t3tools/contracts";

import { type UpstreamProxy, dialFailureReason, dialThroughProxy } from "./proxyDial.ts";

// By name, not by IP: a browser's request through a proxy to a bare IP fails
// playwright's certificate check (SNI goes out as localhost).
export const TRACE_HOST = "one.one.one.one";
export const TRACE_PATH = "/cdn-cgi/trace";
export const TRACE_URL = `https://${TRACE_HOST}${TRACE_PATH}`;

/** Address and country from a Cloudflare trace answer. */
export function parseTrace(body: string): { ip: string | null; country: string | null } {
  const ip = /^ip=(.+)$/m.exec(body)?.[1]?.trim() || null;
  const loc = /^loc=([A-Z]{2})$/m.exec(body)?.[1] ?? null;
  return { ip, country: loc && loc !== "XX" ? loc : null };
}

const CHECK_TIMEOUT_MS = 12_000;

/** One GET of the trace over `socket` (a stream to TRACE_HOST:443); the body. */
function fetchTraceOver(socket: Net.Socket): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const tls = Tls.connect({ socket, servername: TRACE_HOST });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      tls.destroy();
      reject(new Error("trace timed out"));
    }, CHECK_TIMEOUT_MS);
    tls.once("secureConnect", () => {
      // HTTP/1.0: the answer ends with the connection, never chunked.
      tls.write(`GET ${TRACE_PATH} HTTP/1.0\r\nHost: ${TRACE_HOST}\r\nUser-Agent: UnoWork\r\n\r\n`);
    });
    tls.on("data", (chunk: Buffer) => chunks.push(chunk));
    tls.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    tls.once("end", () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8");
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0);
      const split = text.indexOf("\r\n\r\n");
      resolve({ status, body: split >= 0 ? text.slice(split + 4) : "" });
      tls.destroy();
    });
  });
}

/** "Check": the trace through `proxy`, as a child of Uno Work would go. */
export async function checkProxy(
  proxy: UpstreamProxy,
  now: () => Date = () => new Date(),
): Promise<NetworkProxyCheck> {
  const started = Date.now();
  let socket;
  try {
    socket = await dialThroughProxy(proxy, TRACE_HOST, 443);
  } catch (error) {
    return { status: "failed", reason: dialFailureReason(error), at: now().toISOString() };
  }
  try {
    const answer = await fetchTraceOver(socket);
    const { ip, country } = parseTrace(answer.body);
    if (answer.status !== 200 || !ip) {
      return {
        status: "failed",
        reason: "The proxy let the check through, but the answer came back broken.",
        at: now().toISOString(),
      };
    }
    return { status: "ok", ip, country, latencyMs: Date.now() - started, at: now().toISOString() };
  } catch {
    socket.destroy();
    return {
      status: "failed",
      reason: "The proxy connected, but a secure page didn't open through it.",
      at: now().toISOString(),
    };
  }
}
