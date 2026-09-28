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
