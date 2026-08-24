/**
 * Plugins — declarative self-extension manifests for the Uno Work daemon.
 *
 * A plugin is either a single JSON file in the daemon's `plugins/` directory
 * (`<id>.json`) or a directory with a `plugin.json` inside (`<id>/plugin.json`
 * plus arbitrary assets). The manifest is intentionally declarative (hooks +
 * crons running shell actions, plus an optional static `panel`) so an agent
 * session can extend the harness by writing files — no build step, no dynamic
 * code loading in the daemon process.
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

/**
 * Static panel shipped with the plugin: a tab in the app's right-hand preview
 * pane rendering `path` (relative to the plugin directory) inside a sandboxed
 * iframe. Only the directory form of a plugin can declare a panel — a flat
 * `<id>.json` has nowhere to keep the assets.
 */
export const PluginPanel = Schema.Struct({
  /** Tab title. */
  title: Schema.String,
  /** Entry file relative to the plugin directory, e.g. `panel/index.html`. */
  path: Schema.String,
});
export type PluginPanel = typeof PluginPanel.Type;

export const PluginManifest = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  panel: Schema.optional(PluginPanel),
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

/** Client-facing snapshot of one plugin (valid or not). */
export const ServerPlugin = Schema.Struct({
  /** Stable id — the file name without `.json`, or the directory name. */
  id: Schema.String,
  fileName: Schema.String,
  /**
   * Present when the plugin ships a panel; the client opens it at
   * `/api/plugins/<id>/panel/` (the daemon resolves the manifest entry file).
   */
  panel: Schema.optional(Schema.Struct({ title: Schema.String })),
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
