/**
 * Comment on the person's own sites (Uno Sites, `*.uno4.me` and their own
 * domains) in the web version's panel (19.10). The page is another origin
 * than Work, so — as with a port's page — Comment's script lives in the page
 * itself: the console puts `/__uno/page-tools.js` into the site's HTML. That
 * script talks to nobody until the parent shows a token the site's server
 * confirms for this exact Work address; only the site's owner gets one
 * (`POST /_account/site-comment` on Work's own address, ~10 minutes).
 *
 * Someone else's site: no token, no Comment — the page shows as before.
 * The desktop app doesn't need any of this: its <webview> reaches every page.
 */
import type { UnoWorkSite } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { accountRequest, accountTransport } from "../../account/unoAccount";
import type { SiteTokenSource } from "./annotate/postMessageWebview";

function originOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Every address a site answers on: its live address, its own domain, and
 * `<slug>.<sites domain>` (the list names only the own domain once there is
 * one; the sites domain is read off the other sites).
 */
export function siteOriginsOf(sites: ReadonlyArray<UnoWorkSite>): ReadonlySet<string> {
  const origins = new Set<string>();
  const bases = new Set<string>();
  for (const site of sites) {
    const origin = originOf(site.url);
    if (!origin) continue;
    origins.add(origin);
    const host = new URL(origin).hostname;
    if (!site.customDomain && host.startsWith(`${site.slug}.`))
      bases.add(host.slice(site.slug.length + 1));
  }
  for (const site of sites) {
    if (site.customDomain) {
      const own = originOf(`https://${site.customDomain}`);
      if (own) origins.add(own);
    }
    for (const base of bases) {
      const origin = originOf(`https://${site.slug}.${base}`);
      if (origin) origins.add(origin);
    }
  }
  return origins;
}

/** The origin of a page on one of the person's sites; null — any other page. */
export function ownSiteOrigin(pageUrl: string, sites: ReadonlyArray<UnoWorkSite>): string | null {
  const origin = originOf(pageUrl);
  return origin && siteOriginsOf(sites).has(origin) ? origin : null;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

/** A token is reused while it has at least this long left. */
const TOKEN_MARGIN_MS = 60_000;
/** After a refusal (not the owner, the account doesn't have it) — ask again only after this. */
const REFUSAL_PAUSE_MS = 5 * 60_000;

const tokens = new Map<string, CachedToken>();
const refusedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<string | null>>();

function parseToken(body: unknown, origin: string, now: number): CachedToken | null {
  if (!body || typeof body !== "object") return null;
  const record = body as { token?: unknown; origin?: unknown; expires_in?: unknown };
  if (typeof record.token !== "string" || record.token === "") return null;
  if (record.origin !== origin) return null;
  const seconds = typeof record.expires_in === "number" ? record.expires_in : 0;
  if (!(seconds > 0)) return null;
  return { token: record.token, expiresAt: now + seconds * 1000 };
}

/** A token for the site's page at `origin`, from the cache or the console; null — none. */
export function siteCommentToken(origin: string, now = Date.now()): Promise<string | null> {
  const cached = tokens.get(origin);
  if (cached && cached.expiresAt - now > TOKEN_MARGIN_MS) return Promise.resolve(cached.token);
  const refused = refusedAt.get(origin);
  if (refused !== undefined && now - refused < REFUSAL_PAUSE_MS) return Promise.resolve(null);
  if (accountTransport() !== "work-proxy") return Promise.resolve(null);
  const pending = inFlight.get(origin);
  if (pending) return pending;
  const request = accountRequest("POST", "/site-comment", { url: `${origin}/` })
    .then((body) => {
      const token = parseToken(body, origin, Date.now());
      if (!token) {
        refusedAt.set(origin, Date.now());
        return null;
      }
      tokens.set(origin, token);
      refusedAt.delete(origin);
      return token.token;
    })
    .catch(() => {
      refusedAt.set(origin, Date.now());
      return null;
    })
    .finally(() => inFlight.delete(origin));
  inFlight.set(origin, request);
  return request;
}

/** For tests: forget every token and refusal. */
export function resetSiteCommentTokens(): void {
  tokens.clear();
  refusedAt.clear();
  inFlight.clear();
}

export interface SiteComment {
  /** The site's origin: the frame talks to it only. */
  readonly origin: string;
  /** A fresh token on every page load of the frame. */
  readonly token: SiteTokenSource;
}

/**
 * The tab's own-site Comment: once the console handed out a token for the
 * site's origin (the person owns it, the account has it), the frame talks to
 * the page; null until then and for every other page.
 */
export function useSiteComment(input: {
  readonly url: string;
  readonly sites: ReadonlyArray<UnoWorkSite> | undefined;
  readonly enabled: boolean;
}): SiteComment | null {
  const { url, sites, enabled } = input;
  const origin = enabled && sites ? ownSiteOrigin(url, sites) : null;
  const [ready, setReady] = useState<string | null>(null);

  useEffect(() => {
    if (origin === null) return;
    let cancelled = false;
    void siteCommentToken(origin).then((token) => {
      if (!cancelled) setReady(token ? origin : null);
    });
    return () => {
      cancelled = true;
    };
  }, [origin]);

  return useMemo(
    () =>
      origin !== null && ready === origin
        ? { origin, token: () => siteCommentToken(origin) }
        : null,
    [origin, ready],
  );
}
