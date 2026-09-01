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

import { ProjectId, ThreadId } from "./baseSchemas.ts";

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
 * How much of the host chat an embedded panel chat shows.
 *
 * - `full` — the normal timeline;
 * - `answers-only` — finished assistant answers only, tool/activity noise hidden
 *   (approvals and questions live in the composer and stay visible either way);
 * - `composer-only` — no timeline at all, just the input.
 */
export const PLUGIN_PANEL_CHAT_VISIBILITIES = ["full", "answers-only", "composer-only"] as const;
export const PluginPanelChatVisibility = Schema.Literals(PLUGIN_PANEL_CHAT_VISIBILITIES);
export type PluginPanelChatVisibility = typeof PluginPanelChatVisibility.Type;

/**
 * Host chat embedded next to the panel ("custom AI interface"): the plugin
 * draws its own UI, the chat itself is always rendered by the host.
 *
 * `visibility` is `Schema.String` on purpose — a typo has to surface as a
 * per-plugin validation error in the registry (with the list of valid values),
 * not as an unreadable schema decode failure for the whole manifest.
 */
export const PluginPanelChat = Schema.Struct({
  /** Same `pluginId + threadTag → threadId` mapping as `plugins.sendToThread`. */
  threadTag: Schema.String,
  visibility: Schema.optional(Schema.String),
});
export type PluginPanelChat = typeof PluginPanelChat.Type;

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
  /** Optional embedded host chat rendered next to the panel. */
  chat: Schema.optional(PluginPanelChat),
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
  panel: Schema.optional(
    Schema.Struct({
      title: Schema.String,
      /** Present when the panel asks for an embedded host chat (already validated). */
      chat: Schema.optional(
        Schema.Struct({
          threadTag: Schema.String,
          visibility: PluginPanelChatVisibility,
        }),
      ),
    }),
  ),
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

/**
 * `plugins.sendToThread` — a plugin panel asks the agent to do something.
 *
 * The panel itself has no session and no idea what a thread is: the app takes
 * the postMessage call from the sandboxed iframe, adds the project of the tab
 * and forwards it here. `threadTag` lets a panel keep talking to one and the
 * same thread ("panel" by default) instead of spawning a new one per click.
 */
export const PluginSendToThreadInput = Schema.Struct({
  pluginId: Schema.String,
  projectId: ProjectId,
  text: Schema.String,
  threadTag: Schema.optional(Schema.String),
});
export type PluginSendToThreadInput = typeof PluginSendToThreadInput.Type;

export const PluginSendToThreadResult = Schema.Struct({
  threadId: ThreadId,
  /** False when an existing thread for this `threadTag` was reused. */
  created: Schema.Boolean,
  /** Manifest `name` — the client shows it in the toast. */
  pluginName: Schema.String,
  threadTag: Schema.String,
});
export type PluginSendToThreadResult = typeof PluginSendToThreadResult.Type;

/**
 * `plugins.resolvePanelThread` — which thread does the chat embedded next to a
 * panel talk to?
 *
 * Same `pluginId + threadTag → threadId` mapping as `plugins.sendToThread`, so
 * the panel and its chat always look at one and the same thread. Unlike
 * `sendToThread` it never starts a turn: it only reuses (or creates) the thread
 * the embedded chat then renders.
 */
export const PluginResolvePanelThreadInput = Schema.Struct({
  pluginId: Schema.String,
  projectId: ProjectId,
  threadTag: Schema.optional(Schema.String),
});
export type PluginResolvePanelThreadInput = typeof PluginResolvePanelThreadInput.Type;

export const PluginResolvePanelThreadResult = Schema.Struct({
  threadId: ThreadId,
  /** False when an existing thread for this `threadTag` was reused. */
  created: Schema.Boolean,
  pluginName: Schema.String,
  threadTag: Schema.String,
});
export type PluginResolvePanelThreadResult = typeof PluginResolvePanelThreadResult.Type;
