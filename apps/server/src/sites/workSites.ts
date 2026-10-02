/**
 * The person's sites on Uno Hosting, as this computer reads them from the
 * console (`GET /api/v1/work/sites`, the machine's own token — see
 * unoWork/consoleClient.ts). One parser for the `sites_list` tool and the
 * Sites screen (RPC `uno.sites.list`), so both show the same live addresses —
 * and the screen works on the computer's direct address, where the browser
 * has no account session.
 */
import type {
  ServerSettings,
  UnoWorkSite,
  UnoWorkSiteUnpublishResult,
  UnoWorkSites,
} from "@t3tools/contracts";

import { liveSiteUrl } from "../files/sitePublish.ts";
import { consoleRequest, consoleToken } from "../unoWork/consoleClient.ts";
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";

export const WORK_SITES_PATH = "/api/v1/work/sites";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** One site of the console's answer; null when it has no slug. */
export function parseWorkSite(raw: unknown): UnoWorkSite | null {
  const site = record(raw);
  const slug = strOrNull(site?.["slug"]);
  if (!site || !slug) return null;
  const customDomain = strOrNull(site["custom_domain"]);
  return {
    slug,
    url: customDomain
      ? `https://${customDomain}/`
      : liveSiteUrl(strOrNull(site["url"]) ?? undefined, slug),
    customDomain,
    hasPassword: site["has_password"] === true,
    sizeBytes: numOrNull(site["size_bytes"]),
    updatedAt: strOrNull(site["updated_at"]) ?? strOrNull(site["created_at"]),
  };
}

/** The console's `{deploys, storage_used_bytes, storage_limit_bytes}`. */
export function parseWorkSites(body: unknown): UnoWorkSites {
  const r = record(body) ?? {};
  const deploys = Array.isArray(r["deploys"]) ? r["deploys"] : [];
  return {
    availability: "ok",
    sites: deploys.flatMap((raw) => {
      const site = parseWorkSite(raw);
      return site ? [site] : [];
    }),
    storageUsedBytes: numOrNull(r["storage_used_bytes"]),
    storageLimitBytes: numOrNull(r["storage_limit_bytes"]),
    message: null,
  };
}

const empty = (availability: UnoWorkSites["availability"], message: string): UnoWorkSites => ({
  availability,
  sites: [],
  storageUsedBytes: null,
  storageLimitBytes: null,
  message,
});

/** Never throws: an unlinked computer or a silent console come back as `availability`. */
export async function listWorkSites(
  settings: Pick<ServerSettings, "uno">,
  options: { readonly fetchImpl?: typeof fetch; readonly baseUrl?: string } = {},
): Promise<UnoWorkSites> {
  const token = consoleToken(settings);
  if (token.length === 0) {
    return empty("not_linked", "Sign in to your Uno account to see your sites here.");
  }
  try {
    const reply = await consoleRequest({
      method: "GET",
      path: WORK_SITES_PATH,
      baseUrl: options.baseUrl ?? controlPlaneBaseUrl(),
      token,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (reply.status === 401 || reply.status === 403) {
      return empty(
        "not_linked",
        "This computer can't read your sites yet. Reopen it from the Uno console to refresh its access.",
      );
    }
    if (reply.status < 200 || reply.status >= 300) {
      return empty("unavailable", "Uno didn't answer. Try again in a moment.");
    }
    return parseWorkSites(reply.body);
  } catch {
    return empty("unavailable", "Uno didn't answer. Try again in a moment.");
  }
}

/**
 * "Unpublish" on the Sites screen: `DELETE /api/v1/deploys/{slug}` with this
 * computer's token. Only the person's click reaches it (the agent has no tool
 * that deletes a site). Never throws.
 */
export async function unpublishWorkSite(
  settings: Pick<ServerSettings, "uno">,
  slug: string,
  options: { readonly fetchImpl?: typeof fetch; readonly baseUrl?: string } = {},
): Promise<UnoWorkSiteUnpublishResult> {
  const clean = slug.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(clean)) {
    return { ok: false, message: "That isn't a site name." };
  }
  const token = consoleToken(settings);
  if (token.length === 0) {
    return { ok: false, message: "Sign in to your Uno account to change your sites here." };
  }
  try {
    const reply = await consoleRequest({
      method: "DELETE",
      path: `/api/v1/deploys/${encodeURIComponent(clean)}`,
      baseUrl: options.baseUrl ?? controlPlaneBaseUrl(),
      token,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (reply.status >= 200 && reply.status < 300) return { ok: true, message: null };
    if (reply.status === 404) return { ok: true, message: null };
    if (reply.status === 401 || reply.status === 403) {
      return {
        ok: false,
        message:
          "This computer can't change your sites. Unpublish it in the Uno console, or reopen this computer from there.",
      };
    }
    return { ok: false, message: "Uno didn't answer. Try again in a moment." };
  } catch {
    return { ok: false, message: "Uno didn't answer. Try again in a moment." };
  }
}
