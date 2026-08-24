/**
 * PluginRuntime — executes plugin hooks and crons.
 *
 * Hooks subscribe to the hot orchestration event stream and run their shell
 * action whenever `hook.on` matches the event type. Crons are evaluated by a
 * 30-second sweep (`schedule` fires at most once per matching minute, `every`
 * fires when its interval has elapsed; neither fires immediately on boot).
 *
 * Shell actions run detached from the event stream (bounded concurrency) so a
 * slow command never stalls event delivery. Every execution is recorded in the
 * registry for the Extensions settings page.
 */
import type { OrchestrationEvent, PluginShellAction, ServerPluginRun } from "@t3tools/contracts";
import { Context, Duration, Effect, Layer, Option, Ref, Schedule, Stream } from "effect";
import type { Scope } from "effect";
import { clamp } from "effect/Number";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as OS from "node:os";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { collectStreamAsString } from "../provider/providerSnapshot.ts";
import { cronMatches, cronMinuteKey, parseCronExpression, parseEveryDuration } from "./cron.ts";
import { PluginRegistry } from "./PluginRegistry.ts";

const CRON_SWEEP_INTERVAL_MS = 30 * 1000;
const MAX_CONCURRENT_RUNS = 4;
const DEFAULT_ACTION_TIMEOUT_MS = 60 * 1000;
const MAX_ACTION_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_ACTION_TIMEOUT_MS = 1000;
const RUN_DETAIL_MAX_CHARS = 2000;
const EVENT_ENV_MAX_CHARS = 32_000;

export const PLUGIN_ID_ENV = "UNO_PLUGIN_ID";
export const PLUGIN_TRIGGER_ENV = "UNO_PLUGIN_TRIGGER";
export const PLUGIN_EVENT_ENV = "UNO_PLUGIN_EVENT";
export const PLUGIN_EVENT_TYPE_ENV = "UNO_PLUGIN_EVENT_TYPE";

export function hookMatches(on: string, eventType: string): boolean {
  if (on === "*") return true;
  if (on === eventType) return true;
  return on.endsWith(".*") && eventType.startsWith(on.slice(0, -1));
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}… [truncated]`;
}

function serializeEventForEnv(event: OrchestrationEvent): string {
  const serialized = JSON.stringify(event);
  if (serialized.length <= EVENT_ENV_MAX_CHARS) return serialized;
  return JSON.stringify({ type: event.type, truncated: true });
}

export interface PluginRuntimeShape {
  /** Start the event worker and cron sweep within the provided scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class PluginRuntime extends Context.Service<PluginRuntime, PluginRuntimeShape>()(
  "t3/plugins/PluginRuntime",
) {}

export interface PluginRuntimeLiveOptions {
  readonly cronSweepIntervalMs?: number;
}

const makePluginRuntime = (options?: PluginRuntimeLiveOptions) =>
  Effect.gen(function* () {
    const registry = yield* PluginRegistry;
    const engine = yield* OrchestrationEngineService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runSemaphore = yield* Semaphore.make(MAX_CONCURRENT_RUNS);
    const everyLastRunRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const scheduleLastFiredRef = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

    const cronSweepIntervalMs = Math.max(
      1000,
      options?.cronSweepIntervalMs ?? CRON_SWEEP_INTERVAL_MS,
    );

    const executeShellAction = (input: {
      readonly pluginId: string;
      readonly trigger: string;
      readonly action: PluginShellAction;
      readonly extraEnv: Record<string, string>;
    }) =>
      Effect.gen(function* () {
        const timeoutMs = clamp(input.action.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS, {
          minimum: MIN_ACTION_TIMEOUT_MS,
          maximum: MAX_ACTION_TIMEOUT_MS,
        });
        const cwd = input.action.cwd ?? OS.homedir();
        const env = {
          ...process.env,
          ...input.extraEnv,
          [PLUGIN_ID_ENV]: input.pluginId,
          [PLUGIN_TRIGGER_ENV]: input.trigger,
        };
        const command =
          process.platform === "win32"
            ? ChildProcess.make("cmd.exe", ["/d", "/s", "/c", input.action.command], { env, cwd })
            : ChildProcess.make("/bin/sh", ["-c", input.action.command], { env, cwd });

        const outcome = yield* Effect.gen(function* () {
          const child = yield* spawner.spawn(command);
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              collectStreamAsString(child.stdout),
              collectStreamAsString(child.stderr),
              child.exitCode.pipe(Effect.map(Number)),
            ],
            { concurrency: "unbounded" },
          );
          return { stdout, stderr, exitCode };
        }).pipe(Effect.scoped, Effect.timeoutOption(Duration.millis(timeoutMs)), Effect.result);

        const at = new Date().toISOString();
        let run: ServerPluginRun;
        if (outcome._tag === "Failure") {
          run = {
            at,
            trigger: input.trigger,
            ok: false,
            detail: truncate(String(outcome.failure), RUN_DETAIL_MAX_CHARS),
          };
        } else if (Option.isNone(outcome.success)) {
          run = {
            at,
            trigger: input.trigger,
            ok: false,
            detail: `timed out after ${timeoutMs}ms`,
          };
        } else {
          const { stdout, stderr, exitCode } = outcome.success.value;
          const output = truncate(
            [stdout, stderr].filter(Boolean).join("\n").trim(),
            RUN_DETAIL_MAX_CHARS,
          );
          run = {
            at,
            trigger: input.trigger,
            ok: exitCode === 0,
            ...(output.length > 0 || exitCode !== 0
              ? {
                  detail:
                    exitCode === 0 ? output : `exit ${exitCode}${output ? `: ${output}` : ""}`,
                }
              : {}),
          };
        }

        yield* registry.recordRun(input.pluginId, run);
        yield* Effect.logInfo("plugins.action.completed", {
          pluginId: input.pluginId,
          trigger: input.trigger,
          ok: run.ok,
        });
      });

    const forkAction = (input: {
      readonly pluginId: string;
      readonly trigger: string;
      readonly action: PluginShellAction;
      readonly extraEnv: Record<string, string>;
    }) =>
      runSemaphore
        .withPermits(1)(executeShellAction(input))
        .pipe(
          Effect.catchDefect((defect: unknown) =>
            Effect.logWarning("plugins.action.defect", { pluginId: input.pluginId, defect }),
          ),
          Effect.forkScoped,
          Effect.asVoid,
        );

    const processEvent = (event: OrchestrationEvent) =>
      Effect.gen(function* () {
        const plugins = yield* registry.getLoadedPlugins;
        for (const plugin of plugins) {
          const manifest = plugin.manifest;
          if (manifest === undefined || !manifest.enabled) continue;
          for (const hook of manifest.hooks) {
            if (!hookMatches(hook.on, event.type)) continue;
            yield* forkAction({
              pluginId: plugin.id,
              trigger: event.type,
              action: hook.run,
              extraEnv: {
                [PLUGIN_EVENT_ENV]: serializeEventForEnv(event),
                [PLUGIN_EVENT_TYPE_ENV]: event.type,
              },
            });
          }
        }
      });

    const cronSweep = Effect.gen(function* () {
      const now = new Date();
      const plugins = yield* registry.getLoadedPlugins;
      for (const plugin of plugins) {
        const manifest = plugin.manifest;
        if (manifest === undefined || !manifest.enabled) continue;
        for (const [index, cron] of manifest.crons.entries()) {
          const key = `${plugin.id}:${cron.id ?? index}`;
          if (cron.schedule !== undefined) {
            const spec = parseCronExpression(cron.schedule);
            if (spec === undefined || !cronMatches(spec, now)) continue;
            const minuteKey = cronMinuteKey(now);
            const lastFired = (yield* Ref.get(scheduleLastFiredRef)).get(key);
            if (lastFired === minuteKey) continue;
            yield* Ref.update(scheduleLastFiredRef, (fired) => new Map(fired).set(key, minuteKey));
            yield* forkAction({
              pluginId: plugin.id,
              trigger: `cron ${cron.schedule}`,
              action: cron.run,
              extraEnv: {},
            });
          } else if (cron.every !== undefined) {
            const interval = parseEveryDuration(cron.every);
            if (interval === undefined) continue;
            const lastRun = (yield* Ref.get(everyLastRunRef)).get(key);
            if (lastRun === undefined) {
              // First sighting: arm the timer without firing immediately.
              yield* Ref.update(everyLastRunRef, (runs) => new Map(runs).set(key, now.getTime()));
              continue;
            }
            if (now.getTime() - lastRun < interval) continue;
            yield* Ref.update(everyLastRunRef, (runs) => new Map(runs).set(key, now.getTime()));
            yield* forkAction({
              pluginId: plugin.id,
              trigger: `every ${cron.every}`,
              action: cron.run,
              extraEnv: {},
            });
          }
        }
      }
    });

    const start: PluginRuntimeShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Stream.runForEach(engine.streamDomainEvents, processEvent).pipe(
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("plugins.event-worker-defect", { defect }),
            ),
          ),
        );

        yield* Effect.forkScoped(
          cronSweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("plugins.cron-sweep-failed", { error }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("plugins.cron-sweep-defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(cronSweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("plugins.runtime.started", { cronSweepIntervalMs });
      });

    return { start } satisfies PluginRuntimeShape;
  });

export const makePluginRuntimeLive = (options?: PluginRuntimeLiveOptions) =>
  Layer.effect(PluginRuntime, makePluginRuntime(options));

export const PluginRuntimeLive = makePluginRuntimeLive();
