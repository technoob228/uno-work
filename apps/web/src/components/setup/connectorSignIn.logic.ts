import type { SetupConnector } from "../../lib/setupApi";

/**
 * The account's sign-in to an app is in place: listed as connected and the
 * provider hasn't refused it. An expired grant stays `connected` with
 * `needsReconnect` until the new sign-in lands, so `connected` alone is not
 * it — Reconnect watching for `connected` stopped watching at once and called
 * the app connected before the person signed in (28.10).
 */
export function connectorSignedIn(
  connector: Pick<SetupConnector, "connected" | "needsReconnect"> | null | undefined,
): boolean {
  return connector?.connected === true && connector.needsReconnect !== true;
}

/**
 * Can this computer's Uno Work connect apps at all, and if not, what to say:
 * - `ready` — the list came from the console;
 * - `sign-in` — no machine token and no account key there (a Mac nobody
 *   signed in to Uno on): "Sign in to Uno to connect", not "Soon";
 * - `outdated` — a Mac with the account key, the console predates its routes;
 * - `soon` — anything else (console down, an older daemon without the route).
 * A provider the console has no OAuth app for is "Soon" on its own row.
 */
export type ConnectorsGate = "ready" | "sign-in" | "outdated" | "soon";

export function connectorsGate(
  state: { readonly available: boolean; readonly reason: string | null } | undefined,
): ConnectorsGate {
  if (state === undefined) return "soon";
  if (state.available) return "ready";
  if (state.reason === "sign_in_required" || state.reason === "not_cloud_computer") {
    return "sign-in";
  }
  if (state.reason === "console_outdated") return "outdated";
  return "soon";
}

/** The GitHub row of the account's GitHub App: git access, not a chat tool (audit 27.10 #7). */
export const GITHUB_FOR_GIT_LINE = "For git: clone and push your repos.";
