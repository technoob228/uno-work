/**
 * Taking a site off the internet as the person.
 *
 * A computer's own token may not delete sites (the console refuses it by
 * design), so the person's Uno session does it: app.uno4.work or the desktop
 * app, `DELETE /api/v1/deploys/{slug}` through the account API. Used by the
 * Unpublish button in Apps & sites and by the Allow of the agent's
 * `site_unpublish` (ComposerToolApprovalPanel).
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { accountRequest, accountTransport } from "../../account/unoAccount";
import { ensureEnvironmentApi } from "../../environmentApi";

/** With the person's own Uno session; false where there is none or the console said no. */
export async function unpublishSiteAsPerson(slug: string): Promise<boolean> {
  if (accountTransport() === "none") return false;
  try {
    await accountRequest("DELETE", `/api/v1/deploys/${encodeURIComponent(slug)}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The person's session first, then the computer's daemon (an older console,
 * or no session here); where neither works the person gets the console's
 * Sites screen.
 */
export async function unpublishSite(
  environmentId: EnvironmentId | null,
  slug: string,
): Promise<{ ok: boolean; message: string | null }> {
  if (await unpublishSiteAsPerson(slug)) return { ok: true, message: null };
  if (environmentId !== null) {
    try {
      const result = await ensureEnvironmentApi(environmentId).unoComputer.workSiteUnpublish({
        slug,
      });
      if (result.ok) return result;
    } catch {
      // an older computer without the call
    }
  }
  return { ok: false, message: "Unpublish it on the Sites page of the Uno console." };
}
