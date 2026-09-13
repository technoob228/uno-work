/**
 * Finds a Uno Work desktop daemon on the computer the browser is running on.
 *
 * Only the hosted web app (app.uno4.work, served by a box) has a reason to
 * look: the desktop build *is* the daemon. The probe is one GET to the public
 * descriptor on the well-known desktop port with a short timeout, so a
 * computer without the desktop app costs a connection-refused and nothing
 * more.
 *
 * Port: the desktop asks for `DEFAULT_DESKTOP_BACKEND_PORT` (3773) and only
 * scans upward when that port is taken. Discovery deliberately probes just
 * the default. Tradeoff: a desktop that had to move to 3774 is invisible to
 * "Use this computer" and falls back to the pairing-link path; in exchange
 * there is exactly one loopback request, no port scanning from a public page
 * (which browsers increasingly gate behind local-network permission prompts),
 * and the daemon that answers is the one the user expects.
 */
import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import { isWebApp } from "./webMode";

/** Mirrors `DEFAULT_DESKTOP_BACKEND_PORT` in apps/desktop/src/backendPort.ts. */
export const LOCAL_DAEMON_WELL_KNOWN_PORT = 3773;
/** Desktop dev runs the backend on 13773 (see AGENTS.md); only probed in dev builds. */
const LOCAL_DAEMON_DEV_PORT = 13773;
export const LOCAL_DAEMON_PROBE_TIMEOUT_MS = 1_500;

export interface LocalDaemonDescriptor {
  readonly environmentId: ExecutionEnvironmentDescriptor["environmentId"];
  readonly label: string;
  readonly platform: ExecutionEnvironmentDescriptor["platform"];
  readonly serverVersion: string;
  /** What the daemon says it is; older daemons leave it out (a computer here). */
  readonly machineKind?: ExecutionEnvironmentDescriptor["machineKind"];
  /** `http://127.0.0.1:<port>/` — what a saved environment stores. */
  readonly httpBaseUrl: string;
}

export interface DiscoverLocalDaemonOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly ports?: ReadonlyArray<number>;
  /** Defaults to `isWebApp`; the desktop build never probes. */
  readonly enabled?: boolean;
}

export function localDaemonHttpBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

export function defaultLocalDaemonPorts(): ReadonlyArray<number> {
  return import.meta.env.DEV
    ? [LOCAL_DAEMON_WELL_KNOWN_PORT, LOCAL_DAEMON_DEV_PORT]
    : [LOCAL_DAEMON_WELL_KNOWN_PORT];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Strict enough that a random local web server answering 200 is not "a daemon". */
export function parseLocalDaemonDescriptor(
  body: unknown,
  httpBaseUrl: string,
): LocalDaemonDescriptor | null {
  if (!isRecord(body)) {
    return null;
  }
  const { environmentId, label, platform, serverVersion } = body;
  if (
    !isNonEmptyString(environmentId) ||
    !isNonEmptyString(label) ||
    !isNonEmptyString(serverVersion) ||
    !isRecord(platform) ||
    !isNonEmptyString(platform["os"]) ||
    !isNonEmptyString(platform["arch"])
  ) {
    return null;
  }
  const machineKind = body["machineKind"];
  return {
    environmentId: environmentId as LocalDaemonDescriptor["environmentId"],
    label: label.trim(),
    platform: {
      os: platform["os"],
      arch: platform["arch"],
    } as LocalDaemonDescriptor["platform"],
    serverVersion: serverVersion.trim(),
    ...(machineKind === "uno_box" || machineKind === "computer" || machineKind === "server"
      ? { machineKind }
      : {}),
    httpBaseUrl,
  };
}

async function probePort(
  port: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<LocalDaemonDescriptor | null> {
  const httpBaseUrl = localDaemonHttpBaseUrl(port);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL("/.well-known/t3/environment", httpBaseUrl), {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      // Chrome's Local Network Access: an https page reaching an http loopback
      // address must say so up front. Unknown to older browsers, which ignore it.
      ...({ targetAddressSpace: "loopback" } as Record<string, unknown>),
    });
    if (!response.ok) {
      return null;
    }
    return parseLocalDaemonDescriptor(await response.json(), httpBaseUrl);
  } catch {
    // Connection refused, timeout, blocked by the browser: all mean "not here".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves to the local daemon's descriptor, or null when there is none (or
 * when this build must not look). Never throws.
 */
export async function discoverLocalDaemon(
  options?: DiscoverLocalDaemonOptions,
): Promise<LocalDaemonDescriptor | null> {
  const enabled = options?.enabled ?? isWebApp;
  if (!enabled) {
    return null;
  }
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return null;
  }
  const timeoutMs = options?.timeoutMs ?? LOCAL_DAEMON_PROBE_TIMEOUT_MS;
  for (const port of options?.ports ?? defaultLocalDaemonPorts()) {
    const descriptor = await probePort(port, fetchImpl, timeoutMs);
    if (descriptor) {
      return descriptor;
    }
  }
  return null;
}
