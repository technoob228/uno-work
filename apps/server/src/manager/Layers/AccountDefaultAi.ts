/**
 * The account's default AI (console `GET /auth/me` `default_ai`, picked in
 * onboarding) as this machine knows it — for the chats the Uno assistant
 * starts (0.0.84): they run on the person's own AI, falling back to the
 * target project's default when that AI isn't usable here (not installed,
 * not signed in).
 *
 * The value comes from the account: the daemon reads `/auth/me` itself when
 * it holds an account key (a laptop), and clients push what they read with
 * their own account token (a Work box's daemon only has a gateway key).
 * Kept in `<stateDir>/account-default-ai.json` so it survives restarts.
 *
 * @module manager/Layers/AccountDefaultAi
 */
import type { ModelSelection } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { harnessForAccountDefaultAi } from "@t3tools/shared/assistantLlm";
import { Context, Effect, FileSystem, Layer, Path, Ref } from "effect";

import { ServerConfig } from "../../config.ts";
import { isUsableForDefault, resolveModel } from "../../provider/autoBootstrapModelSelection.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { fetchControlPlaneJson } from "../../unoBoxIdentity.ts";
import { isGatewayScopedKey } from "../../unoGatewayKey.ts";

export interface ManagerAccountDefaultAiShape {
  readonly get: () => Effect.Effect<string | null>;
  /** Remember the account's value (null: forget). */
  readonly set: (value: string | null) => Effect.Effect<void>;
  /** Read `/auth/me` with the machine's account key, when it has one. */
  readonly refreshFromAccount: () => Effect.Effect<void>;
  /** What a chat the assistant starts runs on; null = use the project's default. */
  readonly spawnModelSelection: () => Effect.Effect<ModelSelection | null>;
}

export class ManagerAccountDefaultAi extends Context.Service<
  ManagerAccountDefaultAi,
  ManagerAccountDefaultAiShape
>()("t3/manager/AccountDefaultAi") {}

const FILE_NAME = "account-default-ai.json";

/** The account value → a selection this machine can run, or null. */
export function spawnSelectionForDefaultAi(
  value: string | null,
  providers: Parameters<typeof isUsableForDefault>[0][],
): ModelSelection | null {
  const instance = harnessForAccountDefaultAi(value);
  if (instance === null) return null;
  const provider = providers.find((entry) => entry.instanceId === instance);
  if (provider === undefined || !isUsableForDefault(provider)) return null;
  const model = resolveModel(provider);
  return model === null ? null : { instanceId: ProviderInstanceId.make(instance), model };
}

export const ManagerAccountDefaultAiLive = Layer.effect(
  ManagerAccountDefaultAi,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const providerRegistry = yield* ProviderRegistry;
    const settings = yield* ServerSettingsService;
    const file = path.join(config.stateDir, FILE_NAME);

    const initial = yield* fs.readFileString(file).pipe(
      Effect.map((raw) => {
        try {
          const parsed = JSON.parse(raw) as { value?: unknown };
          return typeof parsed.value === "string" ? parsed.value : null;
        } catch {
          return null;
        }
      }),
      Effect.orElseSucceed(() => null),
    );
    const current = yield* Ref.make<string | null>(initial);

    const set: ManagerAccountDefaultAiShape["set"] = (value) =>
      Effect.gen(function* () {
        const previous = yield* Ref.getAndSet(current, value);
        if (previous === value) return;
        yield* fs
          .writeFileString(
            file,
            `${JSON.stringify({ value, updatedAt: new Date().toISOString() })}\n`,
          )
          .pipe(Effect.ignore);
        yield* Effect.logInfo("account default AI", { value });
      });

    const refreshFromAccount: ManagerAccountDefaultAiShape["refreshFromAccount"] = () =>
      Effect.gen(function* () {
        const apiKey =
          (yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null)))?.uno.apiKey.trim() ??
          "";
        if (apiKey.length === 0 || isGatewayScopedKey(apiKey)) return;
        const me = yield* Effect.tryPromise(() => fetchControlPlaneJson("/auth/me", apiKey)).pipe(
          Effect.orElseSucceed(() => null),
        );
        const value =
          me !== null && typeof me === "object"
            ? (me as Record<string, unknown>)["default_ai"]
            : null;
        if (typeof value === "string" && value.length > 0) yield* set(value);
      });

    const spawnModelSelection: ManagerAccountDefaultAiShape["spawnModelSelection"] = () =>
      Effect.gen(function* () {
        const providers = yield* providerRegistry.getProviders;
        return spawnSelectionForDefaultAi(yield* Ref.get(current), [...providers]);
      });

    return {
      get: () => Ref.get(current),
      set,
      refreshFromAccount,
      spawnModelSelection,
    } satisfies ManagerAccountDefaultAiShape;
  }),
);
