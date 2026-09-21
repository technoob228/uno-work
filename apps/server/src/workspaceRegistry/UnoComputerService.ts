/**
 * UnoComputerService — the daemon side of Uno Work's "This computer" screen.
 *
 * Same channel as `UnoCloudService`: the account key from server settings,
 * sent to the control plane by the daemon (the browser never holds it). The
 * computer is the box this daemon runs on (`UnoBoxIdentity`); a caller may name
 * another of the account's boxes explicitly, which is how a laptop daemon shows
 * one of the user's cloud computers.
 *
 * Reads never fail — see `unoComputer.ts` for how a missing route becomes
 * "coming soon". Install is an action and fails with a readable message.
 * Power goes through `UnoCloudService.boxPower` in the RPC layer.
 */
import type {
  UnoComputerActivity,
  UnoComputerActivityInput,
  UnoComputerApps,
  UnoComputerInstallAppInput,
  UnoComputerInstallAppResult,
  UnoComputerInstallStatus,
  UnoComputerInstallStatusInput,
  UnoComputerMetrics,
  UnoComputerState,
  UnoComputerTargetInput,
} from "@t3tools/contracts";
import { Context, Effect, Layer } from "effect";

import { ServerSettingsService } from "../serverSettings.ts";
import { UnoBoxIdentity } from "../unoBoxIdentity.ts";
import { UnoCloudFetchError } from "./UnoCloudService.ts";
import { fetchControlPlaneJson } from "./unoCloudParse.ts";
import {
  computerKeyFor,
  installComputerApp,
  readComputerActivity,
  readComputerApps,
  readComputerMetrics,
  readComputerState,
  readInstallStatus,
  type KnownInstall,
} from "./unoComputer.ts";

const DEFAULT_ACTIVITY_TAIL = 40;
/** Installs the daemon remembers, so a reload can re-attach to a running one. */
const MAX_KNOWN_INSTALLS = 50;

export interface UnoComputerServiceShape {
  /** The box a request is about: the explicit one, else this machine's. */
  readonly resolveBoxId: (input?: UnoComputerTargetInput) => Effect.Effect<number | null>;
  readonly getState: (input?: UnoComputerTargetInput) => Effect.Effect<UnoComputerState>;
  readonly metrics: (input?: UnoComputerTargetInput) => Effect.Effect<UnoComputerMetrics>;
  readonly activity: (input?: UnoComputerActivityInput) => Effect.Effect<UnoComputerActivity>;
  readonly apps: (input?: UnoComputerTargetInput) => Effect.Effect<UnoComputerApps>;
  readonly installApp: (
    input: UnoComputerInstallAppInput,
  ) => Effect.Effect<UnoComputerInstallAppResult, UnoCloudFetchError>;
  readonly installStatus: (
    input: UnoComputerInstallStatusInput,
  ) => Effect.Effect<UnoComputerInstallStatus, UnoCloudFetchError>;
  /**
   * Питание СВОЕЙ машины токеном машины. `false` — не наш случай (чужой бокс
   * или токена нет): тогда питание идёт ключом аккаунта через `uno.cloud`.
   */
  readonly powerOwnBox: (
    boxId: number,
    action: string,
  ) => Effect.Effect<boolean, UnoCloudFetchError>;
}

export class UnoComputerService extends Context.Service<
  UnoComputerService,
  UnoComputerServiceShape
>()("t3/workspace/UnoComputerService") {}

const toFetchError = (cause: unknown) =>
  new UnoCloudFetchError({ message: cause instanceof Error ? cause.message : String(cause) });

export const makeUnoComputerService = (
  options: {
    readonly fetchJson?: (apiKey: string, path: string, init?: RequestInit) => Promise<unknown>;
  } = {},
) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const identity = yield* UnoBoxIdentity;
    const known: KnownInstall[] = [];

    const readCredentials = settings.getSettings.pipe(
      Effect.map((current) => ({
        accountKey: current.uno.apiKey.trim(),
        boxToken: current.uno.boxToken?.trim() ?? "",
      })),
      Effect.orElseSucceed(() => ({ accountKey: "", boxToken: "" })),
    );

    const resolveBoxId: UnoComputerServiceShape["resolveBoxId"] = (input) =>
      input?.boxId !== undefined ? Effect.succeed(input.boxId) : identity.current;

    /** Ключ под конкретный бокс: см. `computerKeyFor`. */
    const context = (targetBoxId: number | null) =>
      Effect.gen(function* () {
        const creds = yield* readCredentials;
        const ownBoxId = yield* identity.current;
        const apiKey = computerKeyFor({ ...creds, ownBoxId }, targetBoxId);
        return { apiKey, fetchJson: options.fetchJson };
      });

    // The read helpers fold every control-plane failure into their result, so
    // a rejection here would be a programming error — a defect, not an answer.
    const run = <A>(promise: () => Promise<A>) => Effect.promise(promise);

    const getState: UnoComputerServiceShape["getState"] = (input) =>
      Effect.gen(function* () {
        const ownBoxId = yield* identity.current;
        const ctx = yield* context(input?.boxId ?? ownBoxId);
        return yield* run(() =>
          readComputerState({ ...ctx, ownBoxId, requestedBoxId: input?.boxId }),
        );
      });

    const metrics: UnoComputerServiceShape["metrics"] = (input) =>
      Effect.gen(function* () {
        const boxId = yield* resolveBoxId(input);
        const ctx = yield* context(boxId);
        return yield* run(() => readComputerMetrics({ ...ctx, boxId }));
      });

    const activity: UnoComputerServiceShape["activity"] = (input) =>
      Effect.gen(function* () {
        const boxId = yield* resolveBoxId(input);
        const ctx = yield* context(boxId);
        const tail = input?.tail ?? DEFAULT_ACTIVITY_TAIL;
        return yield* run(() => readComputerActivity({ ...ctx, boxId, tail }));
      });

    const apps: UnoComputerServiceShape["apps"] = (input) =>
      Effect.gen(function* () {
        const boxId = yield* resolveBoxId(input);
        const ctx = yield* context(boxId);
        return yield* run(() => readComputerApps({ ...ctx, boxId, known: [...known] }));
      });

    const installApp: UnoComputerServiceShape["installApp"] = (input) =>
      Effect.gen(function* () {
        const boxId = yield* resolveBoxId(input);
        const ctx = yield* context(boxId);
        const result = yield* Effect.tryPromise({
          try: () =>
            installComputerApp({
              ...ctx,
              boxId,
              templateId: input.templateId,
              settings: input.settings,
            }),
          catch: toFetchError,
        });
        if (boxId !== null) {
          known.push({
            deploymentId: result.deploymentId,
            boxId,
            templateId: input.templateId,
            state: "installing",
            url: null,
          });
          if (known.length > MAX_KNOWN_INSTALLS) known.splice(0, known.length - MAX_KNOWN_INSTALLS);
        }
        return result;
      });

    const installStatus: UnoComputerServiceShape["installStatus"] = (input) =>
      Effect.gen(function* () {
        const record = known.find((k) => k.deploymentId === input.deploymentId);
        const boxId = record?.boxId ?? (yield* identity.current);
        const ctx = yield* context(boxId);
        const status = yield* Effect.tryPromise({
          try: () =>
            readInstallStatus({
              ...ctx,
              boxId,
              deploymentId: input.deploymentId,
              afterSeq: input.afterSeq ?? 0,
            }),
          catch: toFetchError,
        });
        if (record) {
          record.state = status.state;
          if (status.url) record.url = status.url;
        }
        return status;
      });

    const powerOwnBox: UnoComputerServiceShape["powerOwnBox"] = (boxId, action) =>
      Effect.gen(function* () {
        const creds = yield* readCredentials;
        const ownBoxId = yield* identity.current;
        if (creds.boxToken.length === 0 || boxId !== ownBoxId) return false;
        const fetchJson = options.fetchJson ?? fetchControlPlaneJson;
        yield* Effect.tryPromise({
          try: () =>
            fetchJson(creds.boxToken, `/api/v1/boxes/${boxId}/${action}`, { method: "POST" }),
          catch: toFetchError,
        });
        return true;
      });

    return {
      powerOwnBox,
      resolveBoxId,
      getState,
      metrics,
      activity,
      apps,
      installApp,
      installStatus,
    } satisfies UnoComputerServiceShape;
  });

export const UnoComputerServiceLive = Layer.effect(UnoComputerService, makeUnoComputerService());
