/**
 * UnoBoxIdentity — does this daemon run on an Uno box, and which one?
 *
 * One answer, shared by the environment descriptor (`machineKind` /
 * `unoBoxId`) and by agent access (which mints a box-scoped token). The box
 * discovery itself lives here so both consumers use the same rules:
 * a box is recognised by its `internal_ip` matching a local interface, with a
 * fallback on an unambiguous hostname ↔ box-name match.
 *
 * Cheap signals are read once at construction and never block: the daemon's
 * own `UNO_BOX_ID`, then the agent token previously minted for this box
 * (ServerSecretStore). The control-plane lookup needs an account key and the
 * network, so it runs as a startup probe (`probe`) rather than on the request
 * path; `current` simply reports the latest known answer.
 */
import { UNO_CONTROL_PLANE_BASE_URL } from "@t3tools/contracts";
import { Context, Duration, Effect, Layer, Ref } from "effect";
import os from "node:os";

import { ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";
import { parseUnoBoxIdFromEnvironment } from "./environment/machineKind.ts";
import { ServerSettingsService } from "./serverSettings.ts";

/** Secret-store key of the box-scoped agent token minted by UnoAgentAccess. */
export const UNO_AGENT_TOKEN_SECRET_KEY = "uno-agent-token";

/** How long the startup probe may wait on the control plane. */
const PROBE_TIMEOUT = Duration.seconds(10);

export interface StoredAgentToken {
  readonly token: string;
  readonly access: string;
  readonly boxId: number;
  readonly expiresAt: string | null;
  /** Хвост ключа аккаунта, которым чеканили: смена ключа = перечеканка. */
  readonly mintedBy: string;
}

export function parseStoredAgentToken(bytes: Uint8Array | null): StoredAgentToken | null {
  if (bytes === null || bytes.length === 0) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as StoredAgentToken;
    return typeof parsed.token === "string" && parsed.token.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function localIPv4Addresses(): Set<string> {
  const found = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) found.add(addr.address);
    }
  }
  return found;
}

export async function fetchControlPlaneJson(
  path: string,
  apiKey: string,
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

/**
 * Опознание собственного бокса. internal_ip уникален на бокс; имя — нет,
 * поэтому по имени принимаем только однозначное совпадение.
 */
export async function discoverOwnBoxId(apiKey: string): Promise<number | null> {
  const raw = await fetchControlPlaneJson("/api/v1/boxes", apiKey);
  const boxes =
    typeof raw === "object" && raw !== null
      ? ((raw as Record<string, unknown>)["boxes"] as ReadonlyArray<Record<string, unknown>>)
      : [];
  if (!Array.isArray(boxes)) return null;

  const localAddresses = localIPv4Addresses();
  const byIp = boxes.filter(
    (box) => typeof box["internal_ip"] === "string" && localAddresses.has(box["internal_ip"]),
  );
  if (byIp.length === 1 && typeof byIp[0]?.["id"] === "number") {
    return byIp[0]["id"];
  }

  const hostname = os.hostname();
  const byName = boxes.filter((box) => box["name"] === hostname || box["hostname"] === hostname);
  if (byName.length === 1 && typeof byName[0]?.["id"] === "number") {
    return byName[0]["id"];
  }
  return null;
}

export interface UnoBoxIdentityShape {
  /** The box id once known; `null` until then (or forever, off a box). Never fails. */
  readonly current: Effect.Effect<number | null>;
  /**
   * Ask the control plane once. Skipped when the answer is already known or
   * there is no account key. Never fails: an unreachable control plane just
   * leaves the answer as it was.
   */
  readonly probe: Effect.Effect<void>;
}

export class UnoBoxIdentity extends Context.Service<UnoBoxIdentity, UnoBoxIdentityShape>()(
  "t3/UnoBoxIdentity",
) {}

const makeUnoBoxIdentity = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const secretStore = yield* ServerSecretStore;

  const fromEnvironment = parseUnoBoxIdFromEnvironment(process.env["UNO_BOX_ID"]);
  const fromStoredToken =
    fromEnvironment ??
    parseStoredAgentToken(
      yield* secretStore.get(UNO_AGENT_TOKEN_SECRET_KEY).pipe(Effect.orElseSucceed(() => null)),
    )?.boxId ??
    null;
  const known = yield* Ref.make<number | null>(fromStoredToken);

  const probe: UnoBoxIdentityShape["probe"] = Effect.gen(function* () {
    if ((yield* Ref.get(known)) !== null) return;
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const apiKey = current?.uno.apiKey.trim() ?? "";
    if (apiKey.length === 0) return;

    const discovered = yield* Effect.tryPromise(() => discoverOwnBoxId(apiKey)).pipe(
      Effect.timeoutOption(PROBE_TIMEOUT),
      Effect.map((option) => (option._tag === "Some" ? option.value : null)),
      Effect.orElseSucceed(() => null),
    );
    if (discovered === null) return;
    yield* Ref.set(known, discovered);
    yield* Effect.logInfo("uno.boxIdentity.discovered", { boxId: discovered });
  });

  return {
    current: Ref.get(known),
    probe,
  } satisfies UnoBoxIdentityShape;
});

export const UnoBoxIdentityLive = Layer.effect(UnoBoxIdentity, makeUnoBoxIdentity);

/** Тестовый стаб: не бокс. */
export const UnoBoxIdentityNone = Layer.succeed(UnoBoxIdentity, {
  current: Effect.succeed(null),
  probe: Effect.void,
});
