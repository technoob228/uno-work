import * as Crypto from "node:crypto";

import { CommandId } from "@t3tools/contracts";
import { Duration, Effect, Layer, Option, Schedule } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_ACTIVE_TURN_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${Crypto.randomUUID()}`);

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly activeTurnThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const activeTurnThresholdMs = Math.max(
      1,
      options?.activeTurnThresholdMs ?? DEFAULT_ACTIVE_TURN_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = Date.now();
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          if (idleDurationMs < activeTurnThresholdMs) {
            yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
              threadId: binding.threadId,
              activeTurnId: thread.session.activeTurnId,
              idleDurationMs,
            });
            continue;
          }

          const activeTurnId = thread.session.activeTurnId;
          const createdAt = new Date(now).toISOString();
          const detail = `Provider turn timed out after ${Math.round(
            idleDurationMs / 60_000,
          )} minutes without activity.`;
          yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.reaper.active-turn-stop-failed", {
                threadId: binding.threadId,
                provider: binding.provider,
                activeTurnId,
                idleDurationMs,
                cause,
              }),
            ),
          );
          yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: serverCommandId("provider-active-turn-timeout-interrupt"),
              threadId: binding.threadId,
              turnId: activeTurnId,
              createdAt,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("provider.session.reaper.active-turn-interrupt-dispatch-failed", {
                  threadId: binding.threadId,
                  activeTurnId,
                  error,
                }),
              ),
            );
          yield* orchestrationEngine
            .dispatch({
              type: "thread.session.set",
              commandId: serverCommandId("provider-active-turn-timeout-session"),
              threadId: binding.threadId,
              session: {
                ...thread.session,
                status: "error",
                activeTurnId: null,
                lastError: detail,
                lastErrorClass: "transport_error",
                updatedAt: createdAt,
              },
              createdAt,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("provider.session.reaper.active-turn-session-dispatch-failed", {
                  threadId: binding.threadId,
                  activeTurnId,
                  error,
                }),
              ),
            );
          yield* Effect.logInfo("provider.session.reaper.active-turn-timed-out", {
            threadId: binding.threadId,
            provider: binding.provider,
            activeTurnId,
            idleDurationMs,
            activeTurnThresholdMs,
          });
          reapedCount += 1;
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          activeTurnThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
