/**
 * UnoCloudService — the daemon's read of the Uno account behind the workspace.
 *
 * Two things come from the control plane: who the account is (`/auth/me`) and
 * what boxes it has (`/api/v1/boxes`). Boxes matter here because a box is a
 * machine the app can *make* reachable — it exposes a ready-to-run SSH command
 * and can be woken — which is not true of an arbitrary host the user typed in.
 *
 * The API key is the account credential from server settings. There is no
 * separate login: a workspace is "linked" exactly when the daemon has a key.
 */
import {
  UNO_CONTROL_PLANE_BASE_URL,
  type UnoBox,
  type UnoBoxConnection,
  type UnoCloudState,
} from "@t3tools/contracts";
import { Context, Data, Effect, Layer, Ref } from "effect";

import { ServerSettingsService } from "../serverSettings.ts";

/**
 * A control-plane request that did not return a usable payload. Tagged so the
 * `catch` in `fetchJson` does not merge into the untyped global `Error`
 * channel; `message` carries the status/detail the panel surfaces.
 */
class UnoCloudFetchError extends Data.TaggedError("UnoCloudFetchError")<{
  readonly message: string;
}> {}

/**
 * Short enough that waking a box shows up on the next panel paint, long enough
 * that a panel re-render does not hammer the control plane.
 */
const CACHE_TTL_MS = 20_000;

const API_BASE_URL = UNO_CONTROL_PLANE_BASE_URL;

export interface UnoCloudServiceShape {
  readonly getState: (input?: {
    readonly refresh?: boolean | undefined;
  }) => Effect.Effect<UnoCloudState>;
  readonly boxPower: (input: {
    readonly boxId: number;
    readonly action: "wake" | "sleep" | "start" | "stop";
  }) => Effect.Effect<UnoCloudState>;
  /**
   * Mint a one-time pairing link for a box's Uno Work daemon so the client can
   * add it as a remote environment in one click. Fails (rather than folding into
   * state) because the caller needs the link, not a machine list.
   */
  readonly connectBox: (input: {
    readonly boxId: number;
  }) => Effect.Effect<UnoBoxConnection, UnoCloudFetchError>;
}

export class UnoCloudService extends Context.Service<UnoCloudService, UnoCloudServiceShape>()(
  "t3/workspace/UnoCloudService",
) {}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toBox(raw: unknown): UnoBox | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
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

const disconnectedState = (error: string | null): UnoCloudState => ({
  connected: false,
  account: null,
  boxes: [],
  fetchedAt: new Date().toISOString(),
  error,
});

const makeUnoCloudService = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const cache = yield* Ref.make<{ readonly at: number; readonly state: UnoCloudState } | null>(
    null,
  );

  const fetchJson = (path: string, apiKey: string, init?: RequestInit) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${API_BASE_URL}${path}`, {
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
      },
      catch: (cause) =>
        new UnoCloudFetchError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

  const load = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const apiKey = current?.uno.apiKey.trim() ?? "";
    if (apiKey.length === 0) return disconnectedState(null);

    // Account and boxes are fetched independently: a boxes call that fails
    // (scoped token, control-plane hiccup) should still leave the panel able to
    // say which account it is looking at.
    const accountResult = yield* Effect.result(fetchJson("/auth/me", apiKey));
    if (accountResult._tag === "Failure") {
      return disconnectedState(accountResult.failure.message);
    }
    const accountRecord = accountResult.success as Record<string, unknown>;
    const boxesResult = yield* Effect.result(fetchJson("/api/v1/boxes", apiKey));
    const boxes =
      boxesResult._tag === "Success" &&
      typeof boxesResult.success === "object" &&
      boxesResult.success
        ? ((boxesResult.success as Record<string, unknown>)["boxes"] ?? [])
        : [];

    return {
      connected: true,
      account: {
        userId: asNumber(accountRecord["id"], -1),
        username: asString(accountRecord["username"]),
        email: asNullableString(accountRecord["email"]),
        balance: asNumber(accountRecord["balance"]),
        llmBalance: asNumber(accountRecord["llm_balance"]),
        role: asString(accountRecord["role"]) || "user",
      },
      boxes: Array.isArray(boxes)
        ? boxes.map(toBox).filter((box): box is UnoBox => box !== null)
        : [],
      fetchedAt: new Date().toISOString(),
      error: boxesResult._tag === "Failure" ? boxesResult.failure.message : null,
    } satisfies UnoCloudState;
  });

  const getState: UnoCloudServiceShape["getState"] = (input) =>
    Effect.gen(function* () {
      const cached = yield* Ref.get(cache);
      const fresh = cached !== null && Date.now() - cached.at < CACHE_TTL_MS;
      if (fresh && input?.refresh !== true) return cached.state;
      const state = yield* load;
      yield* Ref.set(cache, { at: Date.now(), state });
      return state;
    });

  const boxPower: UnoCloudServiceShape["boxPower"] = (input) =>
    Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
      const apiKey = current?.uno.apiKey.trim() ?? "";
      if (apiKey.length === 0) return disconnectedState("Connect your Uno account first.");
      const result = yield* Effect.result(
        fetchJson(`/api/v1/boxes/${input.boxId}/${input.action}`, apiKey, { method: "POST" }),
      );
      // The control plane answers before the box has finished changing state,
      // so the refresh below is deliberately a fresh read rather than an
      // optimistic local edit.
      const state = yield* load;
      const withError: UnoCloudState =
        result._tag === "Failure" ? { ...state, error: result.failure.message } : state;
      yield* Ref.set(cache, { at: Date.now(), state: withError });
      return withError;
    });

  const connectBox: UnoCloudServiceShape["connectBox"] = (input) =>
    Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
      const apiKey = current?.uno.apiKey.trim() ?? "";
      if (apiKey.length === 0) {
        return yield* new UnoCloudFetchError({ message: "Connect your Uno account first." });
      }
      const raw = yield* fetchJson(`/api/v1/boxes/${input.boxId}/work/session`, apiKey, {
        method: "POST",
        body: "{}",
      });
      const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
        string,
        unknown
      >;
      const url = asString(record["url"]);
      if (url.length === 0) {
        return yield* new UnoCloudFetchError({
          message: "The control plane did not return a pairing link for this box.",
        });
      }
      return {
        boxId: input.boxId,
        url,
        hostname: asString(record["hostname"]),
        expiresAt: asNullableString(record["expires_at"]),
      } satisfies UnoBoxConnection;
    });

  return { getState, boxPower, connectBox } satisfies UnoCloudServiceShape;
});

export const UnoCloudServiceLive = Layer.effect(UnoCloudService, makeUnoCloudService);
