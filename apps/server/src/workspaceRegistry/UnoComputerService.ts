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
 * "coming soon". Install, remove and the AI limit are actions and fail with a
 * readable message.
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
  UnoComputerRemoveAppInput,
  UnoComputerRemoveAppResult,
  UnoComputerSetAppAiLimitInput,
  UnoComputerSetAppAiLimitResult,
  UnoComputerOpenAppInput,
  UnoComputerOpenAppResult,
  UnoComputerAppAccess,
  UnoComputerAppAccessInput,
  UnoComputerShareAppInput,
  UnoComputerUnshareAppInput,
  UnoComputerResizeInput,
  UnoComputerResizeOptions,
  UnoComputerResizeResult,
  UnoComputerBoostInput,
  UnoComputerBoostResult,
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
  removeComputerApp,
  setComputerAppAiLimit,
  openComputerApp,
  computerAppAccess,
  type KnownInstall,
} from "./unoComputer.ts";
import { readResizeOptions, resizeComputer } from "./unoComputerResize.ts";
import { endBoost as endComputerBoost, startBoost } from "./unoComputerBoost.ts";

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
  /** Remove an App Store app; its data stays unless `deleteData` is true. */
  readonly removeApp: (
    input: UnoComputerRemoveAppInput,
  ) => Effect.Effect<UnoComputerRemoveAppResult, UnoCloudFetchError>;
  readonly setAppAiLimit: (
    input: UnoComputerSetAppAiLimitInput,
  ) => Effect.Effect<UnoComputerSetAppAiLimitResult, UnoCloudFetchError>;
  /** A one-time link that opens the app already signed in with the Uno account. */
  readonly openApp: (
    input: UnoComputerOpenAppInput,
  ) => Effect.Effect<UnoComputerOpenAppResult, UnoCloudFetchError>;
  readonly appAccess: (
    input: UnoComputerAppAccessInput,
  ) => Effect.Effect<UnoComputerAppAccess, UnoCloudFetchError>;
  readonly shareApp: (
    input: UnoComputerShareAppInput,
  ) => Effect.Effect<UnoComputerAppAccess, UnoCloudFetchError>;
  readonly unshareApp: (
    input: UnoComputerUnshareAppInput,
  ) => Effect.Effect<UnoComputerAppAccess, UnoCloudFetchError>;
  /**
   * Питание СВОЕЙ машины токеном машины. `false` — не наш случай (чужой бокс
   * или токена нет): тогда питание идёт ключом аккаунта через `uno.cloud`.
   */
  readonly resizeOptions: (
    input?: UnoComputerTargetInput,
  ) => Effect.Effect<UnoComputerResizeOptions>;
  readonly resize: (
    input: UnoComputerResizeInput,
  ) => Effect.Effect<UnoComputerResizeResult, UnoCloudFetchError>;
  /** Boost ×2 for an hour; a refusal is an answer (`refused`). */
  readonly boost: (
    input: UnoComputerBoostInput,
  ) => Effect.Effect<UnoComputerBoostResult, UnoCloudFetchError>;
  readonly endBoost: (
    input?: UnoComputerTargetInput,
  ) => Effect.Effect<UnoComputerBoostResult, UnoCloudFetchError>;
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
              allowLowMemory: input.allowLowMemory,
            }),
          catch: toFetchError,
        });
        if (boxId !== null && result.deploymentId !== null) {
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

    // Uninterruptible: the console finishes a removal even when the browser
    // that asked for it goes away (tab closed, reload, reconnect) — deleting an
    // app's data can take a while. Interrupted here, the daemon would skip
    // forgetting its own install record, and the removed app would stay on
    // the home screen as "an install this daemon started" until a restart.
    const removeApp: UnoComputerServiceShape["removeApp"] = (input) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const boxId = yield* resolveBoxId(input);
          const ctx = yield* context(boxId);
          const result = yield* Effect.tryPromise({
            try: () =>
              removeComputerApp({
                ...ctx,
                boxId,
                deploymentId: input.deploymentId,
                deleteData: input.deleteData === true,
              }),
            catch: toFetchError,
          });
          // Otherwise the app list would bring it back as "an install this daemon started".
          for (let i = known.length - 1; i >= 0; i--) {
            if (known[i]!.deploymentId === input.deploymentId) known.splice(i, 1);
          }
          return result;
        }),
      );

    const setAppAiLimit: UnoComputerServiceShape["setAppAiLimit"] = (input) =>
      Effect.gen(function* () {
        const boxId = yield* resolveBoxId(input);
        const ctx = yield* context(boxId);
        return yield* Effect.tryPromise({
          try: () =>
            setComputerAppAiLimit({
              ...ctx,
              boxId,
              deploymentId: input.deploymentId,
              limitUsd: input.limitUsd,
            }),
          catch: toFetchError,
        });
      });

    const openApp: UnoComputerServiceShape["openApp"] = (input) =>
      Effect.gen(function* () {
        const boxId = yield* resolveBoxId(input);
        const ctx = yield* context(boxId);
        const fallbackUrl = known.find((k) => k.deploymentId === input.deploymentId)?.url ?? null;
        return yield* Effect.tryPromise({
          try: () =>
            openComputerApp({ ...ctx, boxId, deploymentId: input.deploymentId, fallbackUrl }),
          catch: toFetchError,
        });
      });

    const access = (
      input: { readonly boxId?: number | undefined; readonly deploymentId: number },
      action: Parameters<typeof computerAppAccess>[0]["action"],
    ) =>
      Effect.gen(function* () {
        const boxId = yield* resolveBoxId(input);
        const ctx = yield* context(boxId);
        return yield* Effect.tryPromise({
          try: () => computerAppAccess({ ...ctx, boxId, deploymentId: input.deploymentId, action }),
          catch: toFetchError,
        });
      });
    const appAccess: UnoComputerServiceShape["appAccess"] = (input) =>
      access(input, { kind: "list" });
    const shareApp: UnoComputerServiceShape["shareApp"] = (input) =>
      access(input, { kind: "share", login: input.login });
    const unshareApp: UnoComputerServiceShape["unshareApp"] = (input) =>
      access(input, { kind: "unshare", userId: input.userId });

    const resizeOptions: UnoComputerServiceShape["resizeOptions"] = (input) =>
      Effect.gen(function* () {
        const boxId = yield* resolveBoxId(input);
        const ctx = yield* context(boxId);
        return yield* run(() => readResizeOptions({ ...ctx, boxId }));
      });

    const resize: UnoComputerServiceShape["resize"] = (input) =>
      Effect.gen(function* () {
        const boxId = yield* resolveBoxId(input);
        const ctx = yield* context(boxId);
        return yield* Effect.tryPromise({
          try: () =>
            resizeComputer({
              ...ctx,
              boxId,
              shape: { ramMb: input.ramMb, vcpu: input.vcpu, diskGb: input.diskGb },
            }),
          catch: toFetchError,
        });
      });

    // Uninterruptible: the computer that restarts into the boost may be the one
    // this daemon runs on, and the browser that asked may be gone by then.
    const boost: UnoComputerServiceShape["boost"] = (input) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const boxId = yield* resolveBoxId(input);
          const ctx = yield* context(boxId);
          return yield* Effect.tryPromise({
            try: () =>
              startBoost({ ...ctx, boxId, ...(input.hours ? { hours: input.hours } : {}) }),
            catch: toFetchError,
          });
        }),
      );

    const endBoost: UnoComputerServiceShape["endBoost"] = (input) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const boxId = yield* resolveBoxId(input);
          const ctx = yield* context(boxId);
          return yield* Effect.tryPromise({
            try: () => endComputerBoost({ ...ctx, boxId }),
            catch: toFetchError,
          });
        }),
      );

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
      resizeOptions,
      resize,
      boost,
      endBoost,
      powerOwnBox,
      resolveBoxId,
      getState,
      metrics,
      activity,
      apps,
      installApp,
      installStatus,
      removeApp,
      setAppAiLimit,
      openApp,
      appAccess,
      shareApp,
      unshareApp,
    } satisfies UnoComputerServiceShape;
  });

export const UnoComputerServiceLive = Layer.effect(UnoComputerService, makeUnoComputerService());
