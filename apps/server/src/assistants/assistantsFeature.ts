/**
 * Does this account have the new assistants (the console's ASSISTANTS_MVP)?
 *
 * The app asks `/auth/me` itself for its screens (`assistantsConsoleApi.ts`);
 * the daemon needs the same answer for what it does on its own: which
 * instructions the computer's assistant gets, whether its skills hub is
 * closed, whether schedule and picture tools are offered. With the flag off
 * a computer behaves exactly as on 0.0.105.
 *
 * One `GET /auth/me` with this computer's own token (allowed for a Work
 * machine's token and for an account key), cached: 10 minutes when on, 5 when
 * off, 1 after a failure. A failure or a computer without an Uno account
 * reads as "off" — the safe side: nothing new starts by mistake.
 *
 * `UNO_ASSISTANTS_MVP=on|off` overrides it (local stands, tests).
 */
import type { ServerSettings } from "@t3tools/contracts";

import { consoleRequest, consoleToken } from "../unoWork/consoleClient.ts";
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";

export const ASSISTANTS_FEATURE = "assistants_mvp";

const ON_TTL_MS = 10 * 60_000;
const OFF_TTL_MS = 5 * 60_000;
const FAILED_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;

interface Cached {
  readonly token: string;
  readonly enabled: boolean;
  readonly until: number;
}

let cached: Cached | null = null;
let inFlight: { readonly token: string; readonly promise: Promise<boolean> } | null = null;

/** Forget the cached answer (tests). */
export function resetAssistantsFeatureCache(): void {
  cached = null;
  inFlight = null;
}

function override(env: NodeJS.ProcessEnv): boolean | null {
  const raw = env["UNO_ASSISTANTS_MVP"]?.trim().toLowerCase();
  if (raw === "on" || raw === "1" || raw === "true") return true;
  if (raw === "off" || raw === "0" || raw === "false") return false;
  return null;
}

/** `features` of the console's `/auth/me` answer lists the assistants. */
export function featuresHaveAssistants(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const features = (body as Record<string, unknown>)["features"];
  return Array.isArray(features) && features.includes(ASSISTANTS_FEATURE);
}

export async function assistantsMvpEnabled(
  settings: Pick<ServerSettings, "uno"> | null,
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly baseUrl?: string;
    readonly now?: () => number;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<boolean> {
  const forced = override(options.env ?? process.env);
  if (forced !== null) return forced;
  const token = settings ? consoleToken(settings) : "";
  if (token.length === 0) return false;
  const now = options.now ?? Date.now;
  if (cached !== null && cached.token === token && cached.until > now()) return cached.enabled;
  if (inFlight !== null && inFlight.token === token) return inFlight.promise;
  const promise = (async () => {
    let enabled = false;
    let ttl = FAILED_TTL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        consoleRequest({
          method: "GET",
          path: "/auth/me",
          baseUrl: options.baseUrl ?? controlPlaneBaseUrl(),
          token,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS);
        }),
      ]);
      if (reply.status >= 200 && reply.status < 300) {
        enabled = featuresHaveAssistants(reply.body);
        ttl = enabled ? ON_TTL_MS : OFF_TTL_MS;
      }
    } catch {
      // the console didn't answer: off for a minute
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    cached = { token, enabled, until: now() + ttl };
    return enabled;
  })();
  inFlight = { token, promise };
  try {
    return await promise;
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}
