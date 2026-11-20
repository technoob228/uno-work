/**
 * The account's default AI (console `GET /auth/me` `default_ai`, picked in
 * onboarding) as this machine knows it.
 *
 * 0.0.84 – 0.0.188 the chats the Uno assistant starts with no model named
 * ran on it. 13.11: an account that picked Codex had them run on GPT-5.6
 * Luna (Codex's first listed model). They now run on the strongest ready
 * model here ({@link strongestReadyModelSelection}: Claude Opus → Codex's
 * strong models → Uno AI premium); the value is kept for what else reads it.
 *
 * The value comes from the account: the daemon reads `/auth/me` itself when
 * it holds an account key (a laptop), and clients push what they read with
 * their own account token (a Work box's daemon only has a gateway key).
 * Kept in `<stateDir>/account-default-ai.json` so it survives restarts.
 *
 * @module manager/Layers/AccountDefaultAi
 */
import type { ModelSelection } from "@t3tools/contracts";
import { Context, Effect, FileSystem, Layer, Path, Ref } from "effect";

import { ServerConfig } from "../../config.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { fetchControlPlaneJson } from "../../unoBoxIdentity.ts";
import { isGatewayScopedKey } from "../../unoGatewayKey.ts";
import { strongestReadyModelSelection } from "../personRouting.ts";

export interface ManagerAccountDefaultAiShape {
  readonly get: () => Effect.Effect<string | null>;
  /** Remember the account's value (null: forget). */
  readonly set: (value: string | null) => Effect.Effect<void>;
  /** Read `/auth/me` with the machine's account key, when it has one. */
  readonly refreshFromAccount: () => Effect.Effect<void>;
  /** What a chat the assistant starts runs on when no row decided: the strongest ready model; null = the project's default. */
  readonly spawnModelSelection: () => Effect.Effect<ModelSelection | null>;
}

export class ManagerAccountDefaultAi extends Context.Service<
  ManagerAccountDefaultAi,
  ManagerAccountDefaultAiShape
>()("t3/manager/AccountDefaultAi") {}

const FILE_NAME = "account-default-ai.json";

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
        const harnessUnoCredits = yield* settings.getSettings.pipe(
          Effect.map((value) => value.harnessUnoCredits),
          Effect.orElseSucceed(() => ({})),
        );
        return strongestReadyModelSelection(providers, harnessUnoCredits);
      });

    return {
      get: () => Ref.get(current),
      set,
      refreshFromAccount,
      spawnModelSelection,
    } satisfies ManagerAccountDefaultAiShape;
  }),
);
