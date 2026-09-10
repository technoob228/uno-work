/**
 * Parsers for Uno control-plane payloads, plus the one HTTP helper every
 * control-plane call goes through.
 *
 * Kept free of Effect so the same functions serve the Effect-based
 * `UnoCloudService` and the Promise-based provisioning job, and so they can be
 * unit-tested against recorded payloads without a runtime.
 */
import { UNO_CONTROL_PLANE_BASE_URL, type UnoBox, type UnoBoxConnection } from "@t3tools/contracts";

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function parseUnoBox(raw: unknown): UnoBox | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asNumber(record["id"], -1);
  if (id < 0) return null;
  return {
    id,
    name: asString(record["name"]) || `box-${id}`,
    status: asString(record["status"]) || "unknown",
    os: asString(record["os"]),
    ramMb: asNumber(record["ram_mb"]),
    vcpu: asNumber(record["vcpu"]),
    diskGb: asNumber(record["disk_gb"]),
    ssh: asNullableString(record["ssh"]),
    publicIp: asNullableString(record["public_ip"]),
    internalIp: asNullableString(record["internal_ip"]),
    createdAt: asNullableString(record["created_at"]),
    sleepDeadlineAt: asNullableString(record["sleep_deadline_at"]),
  };
}

/**
 * Accepts both `{ boxes: [...] }` (list endpoint) and a bare array; anything
 * that is not a box is dropped rather than failing the whole list.
 */
export function parseUnoBoxList(raw: unknown): ReadonlyArray<UnoBox> {
  const list = Array.isArray(raw) ? raw : (asRecord(raw)?.["boxes"] ?? []);
  if (!Array.isArray(list)) return [];
  return list.map(parseUnoBox).filter((box): box is UnoBox => box !== null);
}

/**
 * `POST /api/v1/boxes/{id}/work/session` answers `{ url, hostname, expires_at }`.
 * Null when there is no usable pairing URL — the caller decides whether that
 * is a retryable "daemon not up yet" or a hard failure.
 */
export function parseUnoBoxConnection(raw: unknown, boxId: number): UnoBoxConnection | null {
  const record = asRecord(raw);
  if (!record) return null;
  const url = asString(record["url"]);
  if (url.length === 0) return null;
  return {
    boxId,
    url,
    hostname: asString(record["hostname"]),
    expiresAt: asNullableString(record["expires_at"]),
  };
}

export interface UnoImage {
  readonly id: number;
  readonly name: string;
  readonly state: string;
  readonly kind: string;
}

/** `GET /api/v1/images` answers `{ images: [{ id, name, state, kind }] }`. */
export function parseUnoImages(raw: unknown): ReadonlyArray<UnoImage> {
  const list = Array.isArray(raw) ? raw : (asRecord(raw)?.["images"] ?? []);
  if (!Array.isArray(list)) return [];
  const images: UnoImage[] = [];
  for (const entry of list) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = asNumber(record["id"], -1);
    if (id < 0) continue;
    images.push({
      id,
      name: asString(record["name"]),
      state: asString(record["state"]),
      kind: asString(record["kind"]),
    });
  }
  return images;
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
  const response = await fetch(`${UNO_CONTROL_PLANE_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail.trim().length > 0
        ? `${response.status}: ${detail.slice(0, 200)}`
        : `HTTP ${response.status}`,
    );
  }
  return (await response.json()) as unknown;
}
