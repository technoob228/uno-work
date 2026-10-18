/**
 * "Your site" from a cloud computer in the person's own browser (18.10): a
 * page the agent opened at `http://localhost:PORT` on the computer is shown
 * from `https://p{PORT}--{LABEL}.uno4.work`. The console checks the port
 * session and hands the request to the computer's daemon with
 * {@link PORT_PREVIEW_HEADER}; the daemon relays it to `127.0.0.1:PORT`
 * (apps/server portPreview.ts). The panel keeps showing the localhost address
 * (apps/web …/preview/portPreview.ts).
 *
 * Pure: shared by the daemon (redirects, Origin) and the app (address bar).
 */

/** Set by the console on a request for the port's address: the port number. */
export const PORT_PREVIEW_HEADER = "x-uno-port-preview";
/** The page's own `Authorization` (the console's bearer takes the real header). */
export const PORT_PREVIEW_APP_AUTHORIZATION_HEADER = "x-uno-app-authorization";
/** On the daemon's 401 to a port request: the daemon refused, not the app. */
export const PORT_PREVIEW_AUTH_FAILED_HEADER = "x-uno-port-preview-auth";
/** Comment's page script, served by the daemon on the port's address. */
export const PORT_PREVIEW_PAGE_TOOLS_PATH = "/__uno/page-tools.js";

export const PORT_PREVIEW_MIN_PORT = 1024;
export const PORT_PREVIEW_MAX_PORT = 65_535;

const PORT_HOST_PATTERN = /^p(\d{1,5})--([a-z0-9-]+)\.(.+)$/i;

/** A port a preview may use (the daemon also refuses its own and the App API's). */
export function isPreviewablePort(port: number): boolean {
  return Number.isInteger(port) && port >= PORT_PREVIEW_MIN_PORT && port <= PORT_PREVIEW_MAX_PORT;
}

/** `p5173--abc.uno4.work` → its port and account label; null for any other host. */
export function parsePortPreviewHost(
  host: string,
): { readonly port: number; readonly label: string; readonly domain: string } | null {
  const match = PORT_HOST_PATTERN.exec(host.trim().toLowerCase().replace(/:\d+$/, ""));
  if (!match) return null;
  const port = Number(match[1]);
  if (!isPreviewablePort(port)) return null;
  return { port, label: match[2]!, domain: match[3]! };
}

function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  return Number(parts[0]) === 127 && parts.every((part) => Number(part) <= 255);
}

/**
 * An address only the computer itself can open: localhost (and *.localhost),
 * 127.x, 0.0.0.0, [::1]. In the person's browser it would reach their own
 * device instead.
 */
export function isComputerLocalUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "[::1]" || hostname === "[::]" || hostname === "0.0.0.0") return true;
  return isIpv4Loopback(hostname);
}

/** The port of a computer-local address (80/443 when it names none); null otherwise. */
export function computerLocalPort(rawUrl: string): number | null {
  if (!isComputerLocalUrl(rawUrl)) return null;
  const url = new URL(rawUrl);
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** Path, query and hash of an address: what the port's address keeps of it. */
export function urlPathAndQuery(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

/**
 * The port's address of a computer-local page: `http://localhost:5173/a?b`
 * with origin `https://p5173--abc.uno4.work` → `https://p5173--abc.uno4.work/a?b`.
 * Null when the page is not on that origin's port.
 */
export function localUrlToPortPreviewUrl(localUrl: string, origin: string): string | null {
  const port = computerLocalPort(localUrl);
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return null;
  }
  const host = parsePortPreviewHost(parsedOrigin.host);
  if (port === null || host === null || host.port !== port) return null;
  return `${parsedOrigin.origin}${urlPathAndQuery(localUrl)}`;
}

/**
 * Back to the computer's own address for the address bar:
 * `https://p5173--abc.uno4.work/a?b` → `http://localhost:5173/a?b`; null for
 * any other address.
 */
export function portPreviewUrlToLocalUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = parsePortPreviewHost(url.host);
  if (!host) return null;
  return `http://localhost:${host.port}${url.pathname}${url.search}${url.hash}`;
}
