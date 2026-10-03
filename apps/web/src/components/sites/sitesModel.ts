/**
 * The Sites screen as data: the person's sites on Uno Hosting (read by the
 * computer's daemon, `uno.sites.list`), newest first, each with its address
 * spelled for a person. Pure, so it is tested directly.
 */
import type { UnoWorkSite } from "@t3tools/contracts";

export interface SiteRow {
  readonly slug: string;
  readonly url: string;
  /** `our-cafe-bot.uno4.me` — what the person reads. */
  readonly host: string;
  readonly hasPassword: boolean;
  /** "Updated 3 days ago"-ready ISO time; null = unknown. */
  readonly updatedAt: string | null;
  /** The chat on this computer that published it; null = made elsewhere. */
  readonly madeIn: { readonly threadId: string; readonly title: string } | null;
}

export function hostOfSite(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function siteRows(sites: ReadonlyArray<UnoWorkSite>): SiteRow[] {
  return sites
    .map((site) => ({
      slug: site.slug,
      url: site.url,
      host: hostOfSite(site.url),
      hasPassword: site.hasPassword,
      updatedAt: site.updatedAt,
      madeIn: site.madeIn ?? null,
    }))
    .toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/**
 * The pill on a site's row. Every listed site is on the internet, so one
 * "Live" on each row said nothing: the pill tells who can open it — anyone
 * ("Live") or only people with the password ("Password").
 */
export function siteStatus(row: Pick<SiteRow, "hasPassword">): {
  readonly label: "Live" | "Password";
  readonly locked: boolean;
} {
  return row.hasPassword ? { label: "Password", locked: true } : { label: "Live", locked: false };
}

/** "2 hours ago", "3 days ago", "just now"; null when unknown. */
export function updatedAgo(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * The right-panel tabs that show a site: after Unpublish they would keep the
 * picture of a page that is no longer on the internet, so the caller closes
 * them. Only browser tabs count, matched by the site's host.
 */
export function tabsShowingSite(
  tabs: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly url?: string }>,
  siteUrl: string,
): string[] {
  const host = hostOfSite(siteUrl);
  if (host === "" || host === siteUrl) return [];
  return tabs
    .filter(
      (tab) =>
        (tab.kind === "browser" || tab.kind === "live-browser") &&
        typeof tab.url === "string" &&
        tab.url !== "" &&
        hostOfSite(tab.url) === host,
    )
    .map((tab) => tab.id);
}

/** What "Change with Uno" asks the chat. */
export function changeSitePrompt(row: Pick<SiteRow, "slug" | "url">): string {
  return `I want to change my site ${row.url} (slug ${row.slug}). Get its current code with curl, ask me what to change, then republish it under the same address.`;
}

export type AppsSitesTab = "apps" | "sites";

/** `/sites?tab=apps|sites` — Apps first; anything else reads as no tab. */
export function parseAppsSitesSearch(search: Record<string, unknown>): { tab?: AppsSitesTab } {
  return search.tab === "apps" || search.tab === "sites" ? { tab: search.tab } : {};
}
