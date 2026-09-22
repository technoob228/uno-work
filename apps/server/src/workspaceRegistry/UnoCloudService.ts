/**
 * UnoCloudService — the daemon's read of the Uno account behind the workspace.
 *
 * Two things come from the control plane: who the account is (`/auth/me`) and
 * what boxes it has (`/api/v1/boxes`). Boxes matter here because a box is a
 * machine the app can *make* reachable — it exposes a ready-to-run SSH command
 * and can be woken — which is not true of an arbitrary host the user typed in.
 *
 * The service can also *create* a box (`createBox`): that is a billable
 * background job, tracked in memory and polled by the client via
 * `createBoxStatus`. The job itself lives in `UnoBoxProvision.ts`.
 *
 * The API key is the account credential from server settings. There is no
 * separate login: a workspace is "linked" exactly when the daemon has a key.
 */
import { accountControlPlaneKey } from "./unoComputer.ts";
import type {
  UnoBoxConnection,
  UnoBoxCreateJobStatus,
  UnoCloudCreateBoxInput,
  UnoCloudCreateBoxResult,
  UnoCloudState,
} from "@t3tools/contracts";
import { Context, Data, Effect, Layer } from "effect";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  isTerminalUnoBoxCreateJobState,
  runUnoBoxProvisionJob,
  type UnoBoxProvisionClient,
} from "./UnoBoxProvision.ts";
import {
  asNullableString,
  asNumber,
  asString,
  fetchControlPlaneJson,
  parseUnoBoxConnection,
  parseUnoBoxList,
} from "./unoCloudParse.ts";

/**
 * A control-plane request that did not return a usable payload. Tagged so the
 * `catch` in `fetchJson` does not merge into the untyped global `Error`
 * channel; `message` carries the status/detail the panel surfaces.
 */
export class UnoCloudFetchError extends Data.TaggedError("UnoCloudFetchError")<{
  readonly message: string;
}> {}

/**
 * Short enough that waking a box shows up on the next panel paint, long enough
 * that a panel re-render does not hammer the control plane.
 */
const CACHE_TTL_MS = 20_000;

/** Finished create jobs are kept this long so a client that reconnects can still read the outcome. */
const FINISHED_JOB_RETENTION_MS = 60 * 60 * 1000;

const NOT_LINKED_MESSAGE = "Connect your Uno account first.";

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
  /**
   * Start a background "create a work box" job. Returns immediately; the
   * launch call happens once inside the job. A second call with the same name
   * while the first is still running returns the running job instead of
   * launching again — a double click must not buy two boxes.
   */
  readonly createBox: (
    input: UnoCloudCreateBoxInput,
  ) => Effect.Effect<UnoCloudCreateBoxResult, UnoCloudFetchError>;
  readonly createBoxStatus: (input: {
    readonly jobId: string;
  }) => Effect.Effect<UnoBoxCreateJobStatus, UnoCloudFetchError>;
}

export class UnoCloudService extends Context.Service<UnoCloudService, UnoCloudServiceShape>()(
  "t3/workspace/UnoCloudService",
) {}

const disconnectedState = (error: string | null): UnoCloudState => ({
  connected: false,
  account: null,
  boxes: [],
  fetchedAt: new Date().toISOString(),
  error,
});

interface CreateJobRecord {
  readonly name: string;
  status: UnoBoxCreateJobStatus;
  finishedAt: number | null;
}

function makeProvisionClient(apiKey: string): UnoBoxProvisionClient {
  return {
    getWorkImage: () => fetchControlPlaneJson(apiKey, "/api/v1/work/image"),
    launchImage: (imageId, body) =>
      fetchControlPlaneJson(apiKey, `/api/v1/images/${imageId}/launch`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    createPlainBox: (body) =>
      fetchControlPlaneJson(apiKey, "/api/v1/boxes", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    getBox: (boxId) => fetchControlPlaneJson(apiKey, `/api/v1/boxes/${boxId}`),
    listPorts: (boxId) => fetchControlPlaneJson(apiKey, `/api/v1/boxes/${boxId}/ports`),
    openPort: (boxId, port) =>
      fetchControlPlaneJson(apiKey, `/api/v1/boxes/${boxId}/ports`, {
        method: "POST",
        body: JSON.stringify({ port }),
      }),
    createWorkSession: (boxId) =>
      fetchControlPlaneJson(apiKey, `/api/v1/boxes/${boxId}/work/session`, {
        method: "POST",
        body: "{}",
      }),
    probeDaemonAddress: probeUnoWorkDaemonAddress,
  };
}

/** Per-request cap for the address probe: an edge that is not routing yet tends to hang, not refuse. */
const ADDRESS_PROBE_TIMEOUT_MS = 8_000;

/**
 * True when `<baseUrl>/.well-known/t3/environment` answers with an environment
 * descriptor — i.e. the box's public address reaches the Uno Work daemon. No
 * credentials are sent: the descriptor is public, and the account key must
 * never travel to a box hostname.
 */
export async function probeUnoWorkDaemonAddress(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/.well-known/t3/environment", baseUrl), {
      signal: AbortSignal.timeout(ADDRESS_PROBE_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { environmentId?: unknown } | null;
    return typeof body?.environmentId === "string" && body.environmentId.length > 0;
  } catch {
    return false;
  }
}

const makeUnoCloudService = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  // A plain closure variable rather than a `Ref`: the provisioning job (which
  // runs outside any fiber) also needs to drop the cache when a box appears.
  let cache: { readonly at: number; readonly state: UnoCloudState } | null = null;
  const createJobs = new Map<string, CreateJobRecord>();

  const fetchJson = (path: string, apiKey: string, init?: RequestInit) =>
    Effect.tryPromise({
      try: () => fetchControlPlaneJson(apiKey, path, init),
      catch: (cause) =>
        new UnoCloudFetchError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

  const readApiKey = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    return {
      // Account key, or on a Work machine its own token (see accountControlPlaneKey).
      apiKey: accountControlPlaneKey(current?.uno.apiKey ?? "", current?.uno.boxToken),
      goldenImageId: current?.uno.goldenImageId ?? null,
    };
  });

  const load = Effect.gen(function* () {
    const { apiKey } = yield* readApiKey;
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
      boxes: boxesResult._tag === "Success" ? parseUnoBoxList(boxesResult.success) : [],
      fetchedAt: new Date().toISOString(),
      error: boxesResult._tag === "Failure" ? boxesResult.failure.message : null,
    } satisfies UnoCloudState;
  });

  const getState: UnoCloudServiceShape["getState"] = (input) =>
    Effect.gen(function* () {
      const cached = cache;
      const fresh = cached !== null && Date.now() - cached.at < CACHE_TTL_MS;
      if (fresh && input?.refresh !== true) return cached.state;
      const state = yield* load;
      cache = { at: Date.now(), state };
      return state;
    });

  const boxPower: UnoCloudServiceShape["boxPower"] = (input) =>
    Effect.gen(function* () {
      const { apiKey } = yield* readApiKey;
      if (apiKey.length === 0) return disconnectedState(NOT_LINKED_MESSAGE);
      const result = yield* Effect.result(
        fetchJson(`/api/v1/boxes/${input.boxId}/${input.action}`, apiKey, { method: "POST" }),
      );
      // The control plane answers before the box has finished changing state,
      // so the refresh below is deliberately a fresh read rather than an
      // optimistic local edit.
      const state = yield* load;
      const withError: UnoCloudState =
        result._tag === "Failure" ? { ...state, error: result.failure.message } : state;
      cache = { at: Date.now(), state: withError };
      return withError;
    });

  const connectBox: UnoCloudServiceShape["connectBox"] = (input) =>
    Effect.gen(function* () {
      const { apiKey } = yield* readApiKey;
      if (apiKey.length === 0) {
        return yield* new UnoCloudFetchError({ message: NOT_LINKED_MESSAGE });
      }
      const raw = yield* fetchJson(`/api/v1/boxes/${input.boxId}/work/session`, apiKey, {
        method: "POST",
        body: "{}",
      });
      const connection = parseUnoBoxConnection(raw, input.boxId);
      if (!connection) {
        return yield* new UnoCloudFetchError({
          message: "The control plane did not return a pairing link for this box.",
        });
      }
      return connection;
    });

  const pruneFinishedJobs = () => {
    const cutoff = Date.now() - FINISHED_JOB_RETENTION_MS;
    for (const [jobId, record] of createJobs) {
      if (record.finishedAt !== null && record.finishedAt < cutoff) createJobs.delete(jobId);
    }
  };

  const findActiveJobByName = (name: string): string | null => {
    for (const [jobId, record] of createJobs) {
      if (record.name === name && !isTerminalUnoBoxCreateJobState(record.status.state)) {
        return jobId;
      }
    }
    return null;
  };

  const createBox: UnoCloudServiceShape["createBox"] = (input) =>
    Effect.gen(function* () {
      const { apiKey, goldenImageId } = yield* readApiKey;
      if (apiKey.length === 0) {
        return yield* new UnoCloudFetchError({ message: NOT_LINKED_MESSAGE });
      }
      const name = input.name.trim();
      if (name.length === 0) {
        return yield* new UnoCloudFetchError({ message: "Give the box a name." });
      }

      pruneFinishedJobs();
      const activeJobId = findActiveJobByName(name);
      if (activeJobId !== null) return { jobId: activeJobId };

      const jobId = crypto.randomUUID();
      const record: CreateJobRecord = {
        name,
        status: { jobId, state: "creating" },
        finishedAt: null,
      };
      createJobs.set(jobId, record);

      // Fire-and-forget on the event loop rather than an Effect fiber: the job
      // must outlive the RPC that started it, and it never throws (every
      // failure is folded into a `failed` status).
      void runUnoBoxProvisionJob(
        {
          jobId,
          name,
          ramMb: input.ramMb,
          vcpu: input.vcpu,
          diskGb: input.diskGb,
          goldenImageId,
        },
        {
          client: makeProvisionClient(apiKey),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => Date.now(),
          onStatus: (status) => {
            const boxAppeared = status.boxId != null && record.status.boxId == null;
            record.status = status;
            if (isTerminalUnoBoxCreateJobState(status.state)) {
              record.finishedAt = Date.now();
            }
            // A new box (or one that just became pairable) should show up on
            // the next box-list read instead of after the cache TTL.
            if (boxAppeared || status.state === "ready") {
              cache = null;
            }
          },
        },
      ).catch((cause: unknown) => {
        record.status = {
          jobId,
          state: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
        };
        record.finishedAt = Date.now();
      });

      return { jobId };
    });

  const createBoxStatus: UnoCloudServiceShape["createBoxStatus"] = (input) =>
    Effect.gen(function* () {
      const record = createJobs.get(input.jobId);
      if (!record) {
        return yield* new UnoCloudFetchError({
          message:
            "This box creation job is no longer known to the daemon (it may have restarted). Check the box list.",
        });
      }
      return record.status;
    });

  return {
    getState,
    boxPower,
    connectBox,
    createBox,
    createBoxStatus,
  } satisfies UnoCloudServiceShape;
});

export const UnoCloudServiceLive = Layer.effect(UnoCloudService, makeUnoCloudService);
