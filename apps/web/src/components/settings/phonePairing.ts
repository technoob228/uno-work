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
 * One code pairs one computer, so the workspace is paired computer by
 * computer — see `resolvePhoneComputer` at the bottom.
 *
 * Kept free of React so the rules can be tested with plain values.
 *
 * @module components/settings/phonePairing
 */
import type { AdvertisedEndpoint, EnvironmentId } from "@t3tools/contracts";

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

// ── The workspace's computers, as the phone sees them ────────────────────
//
// The store app pairs one computer per code (one QR = one environment), so
// "connect your phone to the workspace" means one code per computer, minted
// on that computer's own daemon, carrying an address a phone can dial.
// Desktop Work used to mint only on its own daemon at 127.0.0.1 — a QR no
// phone can use (Misha 11.11).

/** One computer of the workspace, before deciding how a phone reaches it. */
export interface PhoneComputerSource {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The daemon serving this Work window (the Mac in desktop, the box in its browser). */
  readonly isPrimary: boolean;
  readonly unoBoxId: number | null;
  /** The address Work itself uses for this daemon. */
  readonly httpBaseUrl: string | null;
  /** The box's own published origin (`https://<box>.app.uno4.dev`), when known. */
  readonly boxDirectOrigin: string | null;
  /** Desktop only: where the local daemon listens for other devices. */
  readonly advertisedEndpoints?: ReadonlyArray<
    Pick<AdvertisedEndpoint, "httpBaseUrl" | "reachability" | "status">
  >;
}

export type PhoneComputerReach = "public" | "private" | "unreachable";

export interface PhoneComputer {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly unoBoxId: number | null;
  /** What goes into the QR; null when no phone can reach this computer. */
  readonly phoneBaseUrl: string | null;
  readonly reach: PhoneComputerReach;
}

function usableAddress(
  url: string | null | undefined,
  isProxyHost: (url: string) => boolean,
): { readonly url: string; readonly reach: "public" | "private" } | null {
  if (!url) return null;
  let origin: string;
  try {
    origin = normalizePhoneHost(url);
  } catch {
    return null;
  }
  if (isProxyHost(origin)) return null;
  const reach = classifyPhoneHostReach(origin);
  return reach === "loopback" ? null : { url: origin, reach };
}

const ENDPOINT_RANK: Record<AdvertisedEndpoint["reachability"], number> = {
  public: 0,
  "private-network": 1,
  lan: 2,
  loopback: 3,
};

/**
 * The address a phone should dial for this computer, best first: the box's
 * own published origin → the address Work uses (unless it is loopback or the
 * sign-in proxy) → for the desktop daemon, an endpoint it really listens on
 * beyond loopback (Settings → Connections → Network access). A public address
 * beats a same-Wi-Fi one. Loopback is never offered: a phone that scans
 * `127.0.0.1` dials itself.
 */
export function resolvePhoneComputer(
  source: PhoneComputerSource,
  isProxyHost: (url: string) => boolean,
): PhoneComputer {
  const endpoints = (source.advertisedEndpoints ?? [])
    .filter((endpoint) => endpoint.status !== "unavailable" && endpoint.reachability !== "loopback")
    .toSorted((a, b) => ENDPOINT_RANK[a.reachability] - ENDPOINT_RANK[b.reachability]);
  const candidates = [
    source.boxDirectOrigin,
    source.httpBaseUrl,
    ...endpoints.map((endpoint) => endpoint.httpBaseUrl),
  ];
  let picked: { readonly url: string; readonly reach: "public" | "private" } | null = null;
  for (const candidate of candidates) {
    const address = usableAddress(candidate, isProxyHost);
    if (!address) continue;
    if (address.reach === "public") {
      picked = address;
      break;
    }
    picked ??= address;
  }
  return {
    environmentId: source.environmentId,
    label: source.label,
    isPrimary: source.isPrimary,
    unoBoxId: source.unoBoxId,
    phoneBaseUrl: picked?.url ?? null,
    reach: picked?.reach ?? "unreachable",
  };
}

const REACH_RANK: Record<PhoneComputerReach, number> = { public: 0, private: 1, unreachable: 2 };

/**
 * Scan order: computers a phone reaches from anywhere first (cloud computers
 * ahead of other servers), then same-Wi-Fi ones, unreachable last; by name
 * within a group.
 */
export function orderPhoneComputers(
  computers: ReadonlyArray<PhoneComputer>,
): ReadonlyArray<PhoneComputer> {
  return computers.toSorted(
    (a, b) =>
      REACH_RANK[a.reach] - REACH_RANK[b.reach] ||
      Number(b.unoBoxId !== null) - Number(a.unoBoxId !== null) ||
      a.label.localeCompare(b.label),
  );
}

/**
 * One entry per computer: the same box can be both the primary and a saved
 * connection. The first occurrence wins, so list the primary first.
 */
export function dedupePhoneComputerSources(
  sources: ReadonlyArray<PhoneComputerSource>,
): ReadonlyArray<PhoneComputerSource> {
  const seenEnvironments = new Set<string>();
  const seenBoxes = new Set<number>();
  const result: PhoneComputerSource[] = [];
  for (const source of sources) {
    if (seenEnvironments.has(source.environmentId)) continue;
    if (source.unoBoxId !== null && seenBoxes.has(source.unoBoxId)) continue;
    seenEnvironments.add(source.environmentId);
    if (source.unoBoxId !== null) seenBoxes.add(source.unoBoxId);
    result.push(source);
  }
  return result;
}
