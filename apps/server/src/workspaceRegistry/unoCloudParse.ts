/**
 * Control-plane parsing moved to `@t3tools/shared/unoCloud` (the interface
 * uses it too); the daemon-only HTTP helpers stay here.
 */
import { UNO_CONTROL_PLANE_BASE_URL } from "@t3tools/contracts";

import { ControlPlaneHttpError } from "@t3tools/shared/unoCloud";

export * from "@t3tools/shared/unoCloud";

/**
 * Dev/test switch: point every control-plane call at a local stub instead of
 * the production console (e.g. `UNO_WORK_DEV_CONTROL_PLANE_URL=http://127.0.0.1:8081`).
 * The account key is sent to whatever this names, so it is read from the
 * daemon's own environment only — never from settings a client can write.
 */
export const CONTROL_PLANE_URL_OVERRIDE_ENV = "UNO_WORK_DEV_CONTROL_PLANE_URL";

export function controlPlaneBaseUrl(): string {
  const override = process.env[CONTROL_PLANE_URL_OVERRIDE_ENV]?.trim();
  return override && override.length > 0
    ? override.replace(/\/+$/, "")
    : UNO_CONTROL_PLANE_BASE_URL;
}

/**
 * One request to the control plane. Non-2xx answers become an `Error` whose
 * message carries the status and (trimmed) body, which is what both the panel
 * and the provisioning job surface to the user.
 */
export async function fetchControlPlaneJson(
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(`${controlPlaneBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ControlPlaneHttpError(
      response.status,
      detail.trim().length > 0
        ? `${response.status}: ${detail.slice(0, 200)}`
        : `HTTP ${response.status}`,
    );
  }
  return (await response.json()) as unknown;
}
