/**
 * "Connect your phone" — the pure half.
 *
 * The phone is the T3 Code app from the stores. It talks to this daemon
 * through the mobile-compat shim (apps/server/src/compat), so everything here
 * mirrors what that app accepts:
 *
 * - the QR carries `https://<daemon>/pair#token=<code>`; the app parses it
 *   locally (token from the hash first, path dropped) — same shape as the
 *   CLI's `auth pairing create --base-url … --qr`;
 * - manual entry is `host` + `code`; the app rebuilds the same link itself.
 *
 * Kept free of React so the rules can be tested with plain values.
 *
 * @module components/settings/phonePairing
 */
import type { ServerClientSessionRecord } from "../../environments/primary/auth";

/** Real store listings, from upstream README / docs/user/install.md. */
export const T3_APP_STORE_URL =
  "https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824";
export const T3_GOOGLE_PLAY_URL =
  "https://play.google.com/store/apps/details?id=com.t3tools.t3code";

/** Every phone code is labelled with this prefix; the session inherits it. */
export const PHONE_LABEL_PREFIX = "Phone";

export function phonePairingLabel(now: Date): string {
  const stamp = now.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${PHONE_LABEL_PREFIX} · ${stamp}`;
}

/** The daemon's own origin (scheme + host + port), without a trailing slash. */
export function normalizePhoneHost(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

export function buildPhonePairUrl(baseUrl: string, credential: string): string {
  const url = new URL("/pair", normalizePhoneHost(baseUrl));
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.toString();
}

/**
 * Can a phone reach this address?
 * - `public`: yes, from anywhere;
 * - `private`: only from the same Wi-Fi / VPN;
 * - `loopback`: never — it points at this computer itself.
 */
export type PhoneHostReach = "public" | "private" | "loopback";

export function classifyPhoneHostReach(baseUrl: string): PhoneHostReach {
  const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1") {
    return "loopback";
  }
  const octets = hostname.split(".");
  const isIpv4 =
    octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
  if (isIpv4) {
    const [a, b] = octets.map(Number) as [number, number, number, number];
    if (a === 127 || a === 0) return "loopback";
    if (a === 10) return "private";
    if (a === 172 && b >= 16 && b <= 31) return "private";
    if (a === 192 && b === 168) return "private";
    if (a === 169 && b === 254) return "private";
    // Carrier-grade NAT range — Tailscale and friends.
    if (a === 100 && b >= 64 && b <= 127) return "private";
    return "public";
  }
  if (hostname.includes(":")) {
    // IPv6 literal: unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(hostname) || /^fe[89ab]/.test(hostname)) return "private";
    return "public";
  }
  // Single-label names and mDNS / tailnet names only resolve nearby.
  if (!hostname.includes(".") || hostname.endsWith(".local") || hostname.endsWith(".ts.net")) {
    return "private";
  }
  return "public";
}

/** `ABCD2345EFGH` → `ABCD 2345 EFGH` for reading aloud; copy the raw code. */
export function formatPhoneCode(credential: string): string {
  return credential.match(/.{1,4}/g)?.join(" ") ?? credential;
}

export function formatCountdown(msLeft: number): string {
  // Floor, so a fresh 5-minute code reads 5:00 → 4:59, never 5:01 from clock skew.
  const totalSeconds = Math.max(0, Math.floor(msLeft / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * A session that came from a phone: labelled by our button, or a bearer
 * session from a mobile/tablet user agent (paired some other way, e.g. the
 * CLI). The browser tab reading this list is never one.
 */
export function isPhoneSession(session: ServerClientSessionRecord): boolean {
  if (session.current) return false;
  if (session.client.label?.startsWith(`${PHONE_LABEL_PREFIX} ·`)) return true;
  const isMobileDevice =
    session.client.deviceType === "mobile" || session.client.deviceType === "tablet";
  return isMobileDevice && session.method !== "browser-session-cookie";
}

export function describePhoneSession(session: ServerClientSessionRecord): string {
  const label = session.client.label;
  if (label) return label;
  const parts = [session.client.os, session.client.browser].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : "Phone";
}
