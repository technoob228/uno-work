/**
 * "Can this web app be shown inside Uno Work?" — answered by the daemon,
 * because the browser can't read the headers of a cross-origin frame: a page
 * that refuses to be framed just shows the browser's own "refused to connect"
 * box, with nothing the app can detect.
 *
 * Two headers decide it, in this order (the order browsers use):
 *
 *   1. CSP `frame-ancestors` — when present, it alone decides (browsers then
 *      ignore X-Frame-Options). Several policies must all allow it.
 *   2. `X-Frame-Options` — DENY never, SAMEORIGIN only for the app's own origin.
 *
 * Only headers are read; the body is dropped. The check never throws: a
 * network error is `unknown`, and the frame is tried anyway with "Open in a
 * new tab" at hand.
 */
import type { UnoEmbedCheck } from "@t3tools/contracts";

export interface EmbedHeaders {
  readonly xFrameOptions: string | null;
  /** Every Content-Security-Policy header (not the Report-Only one). */
  readonly contentSecurityPolicies: ReadonlyArray<string>;
}

function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : protocol === "http:" ? "80" : "";
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return pattern === host;
}

/**
 * One CSP source expression against the embedding page's origin
 * (CSP3 "Does url match expression in origin with redirect count").
 */
export function sourceMatches(source: string, embedder: URL, app: URL): boolean {
  const expr = source.trim().toLowerCase();
  if (expr === "'none'" || expr === "") return false;
  if (expr === "'self'") return embedder.origin === app.origin;
  if (expr === "*") return embedder.protocol === "https:" || embedder.protocol === "http:";
  // scheme-source: "https:"
  if (/^[a-z][a-z0-9+.-]*:$/.test(expr)) {
    return expr === embedder.protocol || (expr === "http:" && embedder.protocol === "https:");
  }
  // host-source: [scheme://]host[:port][/path]
  const match =
    /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9.-]+)(?::(\*|\d+))?(\/.*)?$/.exec(expr);
  if (!match) return false;
  const [, scheme, host, port] = match;
  if (scheme) {
    const schemeOk =
      `${scheme}:` === embedder.protocol || (scheme === "http" && embedder.protocol === "https:");
    if (!schemeOk) return false;
  } else {
    // No scheme: the protected resource's scheme, upgraded http → https allowed.
    const schemeOk =
      embedder.protocol === app.protocol ||
      (app.protocol === "http:" && embedder.protocol === "https:");
    if (!schemeOk) return false;
  }
  if (!host || !hostMatches(host, embedder.hostname)) return false;
  const embedderPort = embedder.port || defaultPort(embedder.protocol);
  if (port === "*") return true;
  if (port) return port === embedderPort;
  return embedderPort === defaultPort(embedder.protocol);
}

/** The `frame-ancestors` source list of one policy, or null when it has none. */
export function frameAncestorsOf(policy: string): string[] | null {
  for (const directive of policy.split(";")) {
    const parts = directive.trim().split(/\s+/);
    if (parts[0]?.toLowerCase() === "frame-ancestors") return parts.slice(1);
  }
  return null;
}

export function decideEmbed(
  headers: EmbedHeaders,
  appUrl: string,
  embedderOrigin: string,
): UnoEmbedCheck {
  const app = parseOrigin(appUrl);
  const embedder = parseOrigin(embedderOrigin);
  if (!app || !embedder) return { verdict: "unknown", reason: "Not a web address" };

  // A header may carry several comma-joined policies.
  const policies = headers.contentSecurityPolicies.flatMap((header) => header.split(","));
  const ancestorLists = policies
    .map(frameAncestorsOf)
    .filter((list): list is string[] => list !== null);
  if (ancestorLists.length > 0) {
    const allowed = ancestorLists.every((list) =>
      list.some((source) => sourceMatches(source, embedder, app)),
    );
    return allowed
      ? { verdict: "ok", reason: null }
      : { verdict: "blocked", reason: "The app only allows itself to be shown on its own pages" };
  }

  const xfo = headers.xFrameOptions?.split(",")[0]?.trim().toLowerCase() ?? "";
  if (xfo === "deny") {
    return { verdict: "blocked", reason: "The app never allows itself inside other pages" };
  }
  if (xfo === "sameorigin" && embedder.origin !== app.origin) {
    return {
      verdict: "blocked",
      reason: "The app only allows itself to be shown on its own pages",
    };
  }
  return { verdict: "ok", reason: null };
}

const CHECK_TIMEOUT_MS = 6_000;

/** Fetches the app (following redirects, e.g. to its login page) and decides. */
export async function checkEmbed(
  input: { readonly url: string; readonly embedderOrigin: string },
  fetchImpl: typeof fetch = fetch,
): Promise<UnoEmbedCheck> {
  const app = parseOrigin(input.url);
  if (!app) return { verdict: "unknown", reason: "Not a web address" };
  try {
    const response = await fetchImpl(app.toString(), {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { accept: "text/html,*/*;q=0.8" },
    });
    void response.body?.cancel().catch(() => {});
    const csp: string[] = [];
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-security-policy") csp.push(value);
    });
    // The final address after redirects decides 'self' / SAMEORIGIN.
    return decideEmbed(
      {
        xFrameOptions: response.headers.get("x-frame-options"),
        contentSecurityPolicies: csp,
      },
      response.url || app.toString(),
      input.embedderOrigin,
    );
  } catch {
    return { verdict: "unknown", reason: "The app didn't answer" };
  }
}
