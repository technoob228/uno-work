/**
 * MaterialsService — the materials reading job (`materialsJob.ts`) bound to
 * this daemon: Uno AI through the gateway key, Cloud storage through the
 * machine token (the account key only when a person put one in Settings,
 * like Files does).
 *
 * @module setupTools/MaterialsService
 */
import { UNO_GATEWAY_BASE_URL } from "@t3tools/contracts";
import { Context, Effect, Layer } from "effect";

import { ServerSettingsService } from "../serverSettings.ts";
import { UnoGatewayKey } from "../unoGatewayKey.ts";
import {
  gatewayModelFromSelection,
  makeCloudMaterialsUpload,
  makeGatewayMaterialsModel,
} from "./materialsAdapters.ts";
import {
  makeMaterialsJobs,
  MaterialsJobError,
  type MaterialsJobDeps,
  type MaterialsJobView,
} from "./materialsJob.ts";

export interface MaterialsServiceShape {
  readonly start: (input: {
    readonly projectPath: string;
    readonly links: ReadonlyArray<string>;
  }) => Effect.Effect<{ readonly jobId: string }, MaterialsJobError>;
  readonly get: (jobId: string) => Effect.Effect<MaterialsJobView | null>;
}

export class MaterialsService extends Context.Service<MaterialsService, MaterialsServiceShape>()(
  "t3/setupTools/MaterialsService",
) {}

export const makeMaterialsService = (overrides: Partial<MaterialsJobDeps> = {}) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const gatewayKey = yield* UnoGatewayKey;
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
    const readSettings = () =>
      runPromise(settings.getSettings.pipe(Effect.orElseSucceed(() => null)));

    const jobs = makeMaterialsJobs({
      model: async () => {
        const key = await runPromise(gatewayKey.harnessKey().pipe(Effect.orElseSucceed(() => "")));
        if (key.length === 0) return null;
        const current = await readSettings();
        return makeGatewayMaterialsModel({
          baseUrl: UNO_GATEWAY_BASE_URL,
          apiKey: key,
          model: gatewayModelFromSelection(
            current?.textGenerationModelSelection,
            (instanceId) =>
              (current?.providerInstances as Record<string, { driver?: string }> | undefined)?.[
                instanceId
              ]?.driver,
          ),
        });
      },
      cloud: async (projectName) => {
        const current = await readSettings();
        const token = current?.uno.boxToken?.trim() || current?.uno.apiKey.trim() || "";
        // A gateway-only key can't reach Cloud storage: that's "not linked".
        if (token.length === 0 || token.startsWith("unollm_")) return null;
        return makeCloudMaterialsUpload({ token }, projectName);
      },
      ...overrides,
    });

    return {
      start: (input) =>
        Effect.tryPromise({
          try: () => jobs.start(input),
          catch: (cause) =>
            cause instanceof MaterialsJobError
              ? cause
              : new MaterialsJobError(
                  500,
                  "internal",
                  cause instanceof Error ? cause.message : String(cause),
                ),
        }),
      get: (jobId) => Effect.sync(() => jobs.get(jobId)),
    } satisfies MaterialsServiceShape;
  });

export const MaterialsServiceLive = Layer.effect(MaterialsService, makeMaterialsService());
