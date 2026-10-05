/**
 * Which browser origins may talk to the daemon cross-origin.
 *
 * Two clients legitimately do: the Electron renderer (origin
 * http://127.0.0.1:<port>) when it connects to a remote environment with a
 * bearer token, and the hosted Uno Work app — the shared entry app.uno4.work
 * and each account's own address <label>.uno4.work — which connects the
 * account's boxes and, with "Use this computer", the desktop daemon on the
 * same machine. Everything else is same-origin. Kept in its own module
 * because both the CORS layer and the link-request route need the same answer.
 */

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

const UNO_WEB_APP_ORIGINS = new Set(["https://app.uno4.work"]);

/**
 * An account's own Uno Work address: https://<one label>.uno4.work, default
 * port. Bearer tokens still gate every call; this only lets the page read the
 * answers, exactly as app.uno4.work could when everyone shared it.
 */
const UNO_WORK_ACCOUNT_HOST = /^[a-z0-9-]{1,63}\.uno4\.work$/;

function isUnoWorkAccountOrigin(parsed: URL): boolean {
  return parsed.protocol === "https:" && parsed.port === "" && UNO_WORK_ACCOUNT_HOST.test(parsed.hostname);
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

/**
 * Extra origins (self-hosted SPA) come from T3CODE_ALLOWED_ORIGINS, comma
 * separated. Empty `allowedOrigins` in effect's cors means `*`, and before this
 * check ANY site could call /api/auth/* and read the answers.
 */
export function isAllowedCorsOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (isLoopbackHostname(parsed.hostname)) {
    return true;
  }
  if (UNO_WEB_APP_ORIGINS.has(parsed.origin) || isUnoWorkAccountOrigin(parsed)) {
    return true;
  }
  const extra = process.env.T3CODE_ALLOWED_ORIGINS;
  if (!extra) {
    return false;
  }
  return extra
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .includes(parsed.origin);
}
