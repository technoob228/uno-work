/**
 * "Open in new tab" in the header of the computer's own browser (Work in the
 * cloud). The page there may be `http://localhost:8087/` — the computer's own
 * address, which this device can't open. So the button picks:
 *
 * - a page on the internet → that address;
 * - an app of the computer that is shown on the internet → its public address
 *   (same path);
 * - an app that isn't yet → "Show on the internet" (the person confirms);
 * - anything else on localhost → nothing to open outside (the reason is shown).
 *
 * Pure, so the rules are tested directly.
 */
import type { UnoMachineApp } from "@t3tools/contracts";

export type OpenOutsideTarget =
  | { readonly kind: "open"; readonly url: string }
  | { readonly kind: "publish"; readonly appId: string; readonly name: string }
  | { readonly kind: "none"; readonly reason: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

export function openOutsideTarget(
  pageUrl: string,
  apps: ReadonlyArray<UnoMachineApp>,
  publishBlockedReason: string | null = null,
): OpenOutsideTarget {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return { kind: "none", reason: "Nothing to open yet." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "none", reason: "Nothing to open yet." };
  }
  if (!LOOPBACK.has(url.hostname.toLowerCase())) return { kind: "open", url: url.toString() };

  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const app = apps.find((candidate) => candidate.port === port);
  const publicUrl = app?.publication?.url ?? null;
  if (publicUrl) {
    const target = new URL(publicUrl);
    target.pathname = url.pathname;
    target.search = url.search;
    target.hash = url.hash;
    return { kind: "open", url: target.toString() };
  }
  if (app && !app.loopbackOnly && publishBlockedReason === null) {
    return { kind: "publish", appId: app.id, name: app.name };
  }
  return {
    kind: "none",
    reason: app?.loopbackOnly
      ? "It only listens inside the computer (127.0.0.1). Ask Uno to make it listen on all addresses, then show it on the internet."
      : (publishBlockedReason ??
        "This address is the computer's own (localhost): only its browser can open it."),
  };
}

/**
 * The other way (web panel, 19.10): a page at an app's own address — its
 * public address (`publication.url`) or its private https one (`privateUrl`)
 * — is the computer's `http://localhost:<port>/…`. The web's panel shows that
 * through "Your site" (portPreview.ts), where Comment works; the address
 * itself, another origin, can't be reached from the panel. Null for any
 * other page.
 */
export function appLocalUrl(pageUrl: string, apps: ReadonlyArray<UnoMachineApp>): string | null {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  if (page.protocol !== "http:" && page.protocol !== "https:") return null;
  if (LOOPBACK.has(page.hostname.toLowerCase())) return null;
  for (const app of apps) {
    if (app.port === null || app.telegramBot !== undefined) continue;
    for (const candidate of [app.publication?.url, app.privateUrl]) {
      if (!candidate) continue;
      let own: URL;
      try {
        own = new URL(candidate);
      } catch {
        continue;
      }
      if (own.origin !== page.origin) continue;
      return `http://localhost:${app.port}${page.pathname}${page.search}${page.hash}`;
    }
  }
  return null;
}
