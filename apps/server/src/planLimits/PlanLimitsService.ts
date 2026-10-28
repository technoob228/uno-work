/**
 * PlanLimitsService — Home's "AI plan limits": how much of the person's own
 * Claude and ChatGPT plan is used, from this computer's Claude Code and
 * Codex sign-ins (`uno.computer.planLimits`).
 *
 * One reader per daemon (its 5-minute cache and the Keychain's "don't ask
 * again" live here, not per connection); the CLIs' homes are taken from the
 * settings on every read. The reading itself, and what it never does with
 * the tokens, is in `planLimitsReader.ts`.
 *
 * @module planLimits/PlanLimitsService
 */
import os from "node:os";
import nodePath from "node:path";

import type { PlanLimits, PlanLimitsInput } from "@t3tools/contracts";
import { Context, Effect, Layer } from "effect";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  makeMacClaudeKeychain,
  openPlanLimitsReader,
  planLimitsHomes,
} from "./planLimitsReader.ts";

export interface PlanLimitsServiceShape {
  /** Never fails: a computer without sign-ins has no accounts. */
  readonly read: (input: PlanLimitsInput) => Effect.Effect<PlanLimits>;
}

export class PlanLimitsService extends Context.Service<PlanLimitsService, PlanLimitsServiceShape>()(
  "t3/planLimits/PlanLimitsService",
) {}

export const makePlanLimitsService = () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const reader = yield* Effect.promise(() =>
      openPlanLimitsReader({
        cacheFile: nodePath.join(config.stateDir, "plan-limits.json"),
        keychain: process.platform === "darwin" ? makeMacClaudeKeychain() : null,
      }),
    );

    const read: PlanLimitsServiceShape["read"] = (input) =>
      settings.getSettings.pipe(
        Effect.map((current) => planLimitsHomes(current, os.homedir(), process.env)),
        Effect.flatMap((homes) =>
          Effect.promise(() =>
            reader.read({ homes, ...(input.signInsOnly ? { signInsOnly: true } : {}) }),
          ),
        ),
        Effect.orElseSucceed((): PlanLimits => ({ accounts: [] })),
      );

    return { read } satisfies PlanLimitsServiceShape;
  });

export const PlanLimitsServiceLive = Layer.effect(PlanLimitsService, makePlanLimitsService());
