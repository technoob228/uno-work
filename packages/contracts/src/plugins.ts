/**
 * Plugins — declarative self-extension manifests for the Uno Work daemon.
 *
 * A plugin is a single JSON file in the daemon's `plugins/` directory. The
 * manifest is intentionally declarative (hooks + crons running shell actions)
 * so an agent session can extend the harness by writing one file — no build
 * step, no dynamic code loading in the daemon process.
 */
import { Effect, Schema } from "effect";

/** Shell action executed by a hook or cron. */
export const PluginShellAction = Schema.Struct({
  kind: Schema.Literal("shell"),
  /** Command line passed to the user's shell (`/bin/sh -c` on POSIX). */
  command: Schema.String,
  /** Working directory; defaults to the daemon's home directory. */
  cwd: Schema.optional(Schema.String),
  /** Timeout in milliseconds. Defaults to 60 000, capped at 600 000. */
  timeoutMs: Schema.optional(Schema.Number),
});
export type PluginShellAction = typeof PluginShellAction.Type;

/**
 * Event hook. `on` matches `OrchestrationEvent.type` — exact (`"thread.created"`),
 * prefix (`"thread.*"`) or everything (`"*"`).
 */
export const PluginHook = Schema.Struct({
  on: Schema.String,
  run: PluginShellAction,
});
export type PluginHook = typeof PluginHook.Type;

/**
 * Scheduled action. Exactly one of `schedule` (5-field cron, minute
 * resolution) or `every` (duration like `"5m"`, `"1h"`, minimum `"1m"`) must
 * be set — validated at load time, not schema time, so a broken cron surfaces
 * as a per-plugin error instead of rejecting the whole manifest.
 */
export const PluginCron = Schema.Struct({
  id: Schema.optional(Schema.String),
  schedule: Schema.optional(Schema.String),
  every: Schema.optional(Schema.String),
  run: PluginShellAction,
});
export type PluginCron = typeof PluginCron.Type;

export const PluginManifest = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  hooks: Schema.Array(PluginHook).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  crons: Schema.Array(PluginCron).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type PluginManifest = typeof PluginManifest.Type;

/** One recorded hook/cron execution, kept in memory for the settings UI. */
export const ServerPluginRun = Schema.Struct({
  at: Schema.String,
  /** What fired: event type for hooks, cron label for crons. */
  trigger: Schema.String,
  ok: Schema.Boolean,
  detail: Schema.optional(Schema.String),
});
export type ServerPluginRun = typeof ServerPluginRun.Type;

/** Client-facing snapshot of one plugin file (valid or not). */
export const ServerPlugin = Schema.Struct({
  /** Stable id — the file name without `.json`. */
  id: Schema.String,
  fileName: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  valid: Schema.Boolean,
  error: Schema.optional(Schema.String),
  hooks: Schema.Array(Schema.Struct({ on: Schema.String })),
  crons: Schema.Array(Schema.Struct({ label: Schema.String })),
  recentRuns: Schema.Array(ServerPluginRun),
});
export type ServerPlugin = typeof ServerPlugin.Type;

export const PluginsSnapshot = Schema.Struct({
  pluginsDir: Schema.String,
  plugins: Schema.Array(ServerPlugin),
});
export type PluginsSnapshot = typeof PluginsSnapshot.Type;

export class PluginsError extends Schema.TaggedErrorClass<PluginsError>()("PluginsError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Plugins error: ${this.detail}`;
  }
}

export const SetPluginEnabledInput = Schema.Struct({
  pluginId: Schema.String,
  enabled: Schema.Boolean,
});
export type SetPluginEnabledInput = typeof SetPluginEnabledInput.Type;
