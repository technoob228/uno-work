/**
 * Signed capability tokens for plugin panel URLs.
 *
 * The panel iframe is sandboxed without `allow-same-origin`, so none of its
 * requests (the document itself, `app.js`, `data.json`) can carry the app's
 * session cookie. Instead of guessing from `Sec-Fetch-Dest` which requests
 * "deserve" auth, every panel request carries a token in the URL path:
 *
 *   /api/plugins/<pluginId>/panel/<token>/<rest>
 *
 * Putting it in the path (not the query) is what makes sub-resources work:
 * relative references inside the panel (`data.json`, `./app.js`) resolve
 * against the tokenised directory and inherit the token automatically — no
 * cookies (which an opaque origin cannot send anyway) and no rewriting of the
 * panel's HTML.
 *
 * Token: `<issuedAt base36>.<nonce>.<hmac>`, HMAC-SHA256 over a domain tag,
 * the plugin id, the manifest's panel path, the issue time and the nonce, keyed
 * with a random per-daemon secret. Binding to the panel path means a manifest
 * edit that repoints the panel invalidates outstanding URLs; the random secret
 * means a daemon restart does too. Verification is constant-time.
 *
 * Lifetimes are split by what the request is for (decided from the resolved
 * file, not from request headers):
 * - the panel entry document must be loaded within `PANEL_TOKEN_LOAD_WINDOW_MS`
 *   of issue — the app asks for a fresh URL right before it mounts the iframe;
 * - other panel files (scripts, styles, the `data.json` a panel re-fetches
 *   while it stays open) are served for `PANEL_TOKEN_SESSION_MS`.
 */
import { randomBytes } from "node:crypto";

import { signPayload, timingSafeEqualBase64Url } from "../auth/utils.ts";
import { PLUGIN_PANEL_ROUTE_PREFIX, PLUGIN_PANEL_ROUTE_SEGMENT } from "./panelPaths.ts";

export const PANEL_TOKEN_SECRET_BYTES = 32;
export const PANEL_TOKEN_LOAD_WINDOW_MS = 2 * 60 * 1000;
export const PANEL_TOKEN_SESSION_MS = 8 * 60 * 60 * 1000;
/** Tolerated clock skew for tokens "issued in the future". */
const PANEL_TOKEN_MAX_SKEW_MS = 5 * 1000;
const PANEL_TOKEN_NONCE_BYTES = 12;
const PANEL_TOKEN_PATTERN = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;
const PANEL_TOKEN_DOMAIN = "uno-plugin-panel-v1";

export function generatePanelTokenSecret(): Uint8Array {
  return new Uint8Array(randomBytes(PANEL_TOKEN_SECRET_BYTES));
}

interface PanelTokenBinding {
  readonly secret: Uint8Array;
  readonly pluginId: string;
  readonly panelPath: string;
}

function panelTokenPayload(input: {
  readonly pluginId: string;
  readonly panelPath: string;
  readonly issuedAt: string;
  readonly nonce: string;
}): string {
  // NUL cannot appear in a plugin id or a validated panel path, so the
  // concatenation is unambiguous.
  return [PANEL_TOKEN_DOMAIN, input.pluginId, input.panelPath, input.issuedAt, input.nonce].join(
    "\u0000",
  );
}

function panelTokenSignature(
  input: PanelTokenBinding & { readonly issuedAt: string; readonly nonce: string },
): string {
  return signPayload(
    panelTokenPayload({
      pluginId: input.pluginId,
      panelPath: input.panelPath,
      issuedAt: input.issuedAt,
      nonce: input.nonce,
    }),
    input.secret,
  );
}

export function signPanelToken(
  input: PanelTokenBinding & { readonly issuedAtMs: number; readonly nonce?: string },
): string {
  const issuedAt = Math.floor(input.issuedAtMs).toString(36);
  const nonce = input.nonce ?? randomBytes(PANEL_TOKEN_NONCE_BYTES).toString("base64url");
  return `${issuedAt}.${nonce}.${panelTokenSignature({ ...input, issuedAt, nonce })}`;
}

/**
 * Checks the signature and returns the issue time, or `null` for a malformed,
 * forged or foreign (other plugin / other panel path / other daemon) token.
 * The age check is the caller's: it depends on what is being requested.
 */
export function verifyPanelTokenSignature(
  input: PanelTokenBinding & { readonly token: string },
): number | null {
  const match = PANEL_TOKEN_PATTERN.exec(input.token);
  if (match === null) return null;
  const [, issuedAt, nonce, signature] = match as unknown as [string, string, string, string];
  const expected = panelTokenSignature({ ...input, issuedAt, nonce });
  if (!timingSafeEqualBase64Url(signature, expected)) return null;
  const issuedAtMs = Number.parseInt(issuedAt, 36);
  return Number.isSafeInteger(issuedAtMs) ? issuedAtMs : null;
}

export function isPanelTokenFresh(input: {
  readonly issuedAtMs: number;
  readonly nowMs: number;
  readonly maxAgeMs: number;
}): boolean {
  const age = input.nowMs - input.issuedAtMs;
  return age >= -PANEL_TOKEN_MAX_SKEW_MS && age <= input.maxAgeMs;
}

/** Relative panel URL the app puts into the iframe `src`. */
export function pluginPanelUrl(pluginId: string, token: string): string {
  return `${PLUGIN_PANEL_ROUTE_PREFIX}/${encodeURIComponent(pluginId)}/${PLUGIN_PANEL_ROUTE_SEGMENT}/${token}/`;
}
