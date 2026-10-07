import { readLocalApi } from "~/localApi";

/** The http(s) URL for a link target, or null for any other scheme or invalid input. */
export function toExternalHttpUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Opens a link from untrusted content (markdown previews, agent output) in
 * the system browser. Only http(s) is ever opened; the app window itself is
 * never navigated. Returns false when the link was refused.
 */
export function openUntrustedLinkExternally(href: string | null | undefined): boolean {
  const url = toExternalHttpUrl(href);
  if (!url) return false;
  const api = readLocalApi();
  if (api) {
    void api.shell.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
  return true;
}

/**
 * Where a link from a chat opens (flows v2, Misha's rule 07.10):
 * - `console` — the Uno console: always a new tab (the console and Uno Work
 *   open each other in new tabs; desktop: the system browser);
 * - `own` — the person's own things: a published site (`*.uno4.me`), an app
 *   or preview of their Work computer (`*.uno4.work`), a local dev server —
 *   the right panel, at once;
 * - `external` — everything else: a new tab (desktop: the system browser).
 * null — not an http(s) link.
 */
export type ChatLinkTarget = "console" | "own" | "external";

const CONSOLE_HOSTS: ReadonlySet<string> = new Set(["console.uno.place", "console.uno4.dev"]);
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

export function chatLinkTarget(href: string | null | undefined): ChatLinkTarget | null {
  const url = toExternalHttpUrl(href);
  if (!url) return null;
  const host = new URL(url).hostname.toLowerCase();
  if (CONSOLE_HOSTS.has(host)) return "console";
  if (
    host === "uno4.me" ||
    host.endsWith(".uno4.me") ||
    host.endsWith(".uno4.work") ||
    LOCAL_HOSTS.has(host) ||
    host.endsWith(".localhost")
  ) {
    return "own";
  }
  return "external";
}

