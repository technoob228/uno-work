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
