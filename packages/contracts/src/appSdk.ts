/**
 * Uno App SDK — "the AI of this computer" for apps on it (docs/app-sdk.md).
 *
 * The daemon serves a local App API to apps that ask for AI in their manifest
 * (`~/.uno/apps/<id>.json` → `"ai": {...}`). These schemas are what the
 * Settings → Apps page reads and changes: which apps use AI, how much they
 * spent, their limit, how much they may do on their own, and revoking them.
 */
import { Schema } from "effect";

import { ModelSelection } from "./orchestration.ts";

/** Default local port of the App API (loopback and the docker bridge only). */
export const APP_SDK_DEFAULT_PORT = 3779;

/**
 * Gateway model an app gets for `model: "default"` until the person picks
 * another in Settings → Apps. Cheap and multilingual on purpose: apps run
 * unattended and often.
 */
export const APP_SDK_DEFAULT_CHAT_MODEL = "deepseek/deepseek-v3.2";

/** What an app may spend when neither the manifest nor the person says less. */
export const APP_SDK_DEFAULT_LIMIT_USD = 10;

/**
 * How much an agent task started by an app may do without the person:
 * - `read` — plan mode, changes nothing;
 * - `ask`  — every edit and command waits for approval in Work;
 * - `edit` — edits files on its own, commands wait for approval;
 * - `full` — does everything on its own.
 */
export const AppTaskTools = Schema.Literals(["read", "ask", "edit", "full"]);
export type AppTaskTools = typeof AppTaskTools.Type;

export const APP_TASK_TOOLS_ORDER: ReadonlyArray<AppTaskTools> = ["read", "ask", "edit", "full"];

/** The ceiling an app gets until the person changes it. */
export const APP_TASK_TOOLS_DEFAULT_CAP: AppTaskTools = "edit";

/** The narrower of two policies. */
export function narrowAppTaskTools(requested: AppTaskTools, cap: AppTaskTools): AppTaskTools {
  return APP_TASK_TOOLS_ORDER.indexOf(requested) <= APP_TASK_TOOLS_ORDER.indexOf(cap)
    ? requested
    : cap;
}

/**
 * - `active`       — the app has a token and may use what its manifest asks for;
 * - `over-limit`   — spent its AI limit, calls get 402 until the person raises it;
 * - `revoked`      — the person turned its AI off; the manifest must not bring it back;
 */
export const AppAiStatus = Schema.Literals(["active", "over-limit", "revoked"]);
export type AppAiStatus = typeof AppAiStatus.Type;

/**
 * An app's folder in the account's cloud (`"storage"` in the manifest):
 * Cloud storage → bucket `apps` → `<appId>/`.
 */
export const AppStorageInfo = Schema.Struct({
  limitBytes: Schema.Number,
  /** True when the person set the limit (rather than the manifest). */
  limitSetByPerson: Schema.Boolean,
  /** Last measured size of the app's folder; null until measured. */
  usedBytes: Schema.NullOr(Schema.Number),
  files: Schema.NullOr(Schema.Number),
  /** The `apps` bucket, for "Open in Files"; null until it exists. */
  bucketId: Schema.NullOr(Schema.Number),
  /** Folder inside the bucket, e.g. `photos/`. */
  prefix: Schema.String,
});
export type AppStorageInfo = typeof AppStorageInfo.Type;

export const AppAiApp = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.NullOr(Schema.String),
  /** What the manifest asks for. */
  chat: Schema.Boolean,
  tasks: Schema.Boolean,
  status: AppAiStatus,
  limitUsd: Schema.Number,
  /** True when the person set the limit (rather than the manifest). */
  limitSetByPerson: Schema.Boolean,
  /** Everything counted against the limit: chat + tasks. */
  spentUsd: Schema.Number,
  /** Answers and transcription (metered by the daemon). */
  chatSpentUsd: Schema.Number,
  /** Agent tasks on the Uno AI gateway (the gateway's own numbers, by app label). */
  tasksSpentUsd: Schema.Number,
  requests: Schema.Number,
  tasksStarted: Schema.Number,
  /** The most a task of this app may do on its own. */
  taskToolsCap: AppTaskTools,
  lastUsedAt: Schema.NullOr(Schema.String),
  /** Where the app's token lives, for people who wire a container by hand. */
  keyDir: Schema.String,
  /** Cloud storage of the app; null = the manifest doesn't ask for it. */
  storage: Schema.NullOr(AppStorageInfo),
});
export type AppAiApp = typeof AppAiApp.Type;

/**
 * Whether what apps' tasks spend is known: "metered" — the gateway reports it
 * per app; "unavailable" — this gateway can't yet (tasks aren't counted);
 * "no-key" — no Uno AI on this machine; "unknown" — not asked yet / offline.
 */
export const AppTaskSpendStatus = Schema.Literals(["metered", "unavailable", "no-key", "unknown"]);
export type AppTaskSpendStatus = typeof AppTaskSpendStatus.Type;

export const AppAiOverview = Schema.Struct({
  apps: Schema.Array(AppAiApp),
  /** Loopback address of the App API, e.g. `http://127.0.0.1:3779`; null when it is not listening. */
  apiUrl: Schema.NullOr(Schema.String),
  /** Address containers use (`http://host.docker.internal:3779`), null without docker. */
  dockerUrl: Schema.NullOr(Schema.String),
  /** False when this machine has no Uno AI key — chat answers 503 then. */
  gatewayConnected: Schema.Boolean,
  /** The model apps get when they ask for "default". */
  chatModel: Schema.String,
  /** The harness/model the person chose for tasks; null = the machine's default. */
  taskModelSelection: Schema.NullOr(ModelSelection),
  /** What tasks actually run on when the person chose nothing (null = no agent ready). */
  taskModelDefault: Schema.NullOr(ModelSelection),
  taskSpend: AppTaskSpendStatus,
  /**
   * False when tasks run on an agent that doesn't use Uno AI (Claude Code,
   * Codex, Cursor, OpenCode — the person's own subscription or keys): such
   * tasks cost Uno nothing and don't count against an app's limit.
   */
  taskHarnessUsesUnoAi: Schema.Boolean,
});
export type AppAiOverview = typeof AppAiOverview.Type;

export const AppAiUpdateInput = Schema.Struct({
  appId: Schema.String,
  /** New limit in USD; null returns to the manifest's limit. */
  limitUsd: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** true = turn the app's AI off and rotate its token; false = allow again. */
  revoked: Schema.optionalKey(Schema.Boolean),
  taskToolsCap: Schema.optionalKey(AppTaskTools),
  /** Start counting from zero (keeps the limit). */
  resetSpent: Schema.optionalKey(Schema.Boolean),
  /** Cloud storage limit in GB; null returns to the manifest's limit. */
  storageLimitGb: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export type AppAiUpdateInput = typeof AppAiUpdateInput.Type;
