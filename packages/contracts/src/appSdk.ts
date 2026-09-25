/**
 * Uno App SDK — "the AI of this computer" for apps on it (docs/app-sdk.md).
 *
 * The daemon serves a local App API to apps that ask for AI in their manifest
 * (`~/.uno/apps/<id>.json` → `"ai": {...}`). These schemas are what the
 * Settings → Apps page reads and changes: which apps use AI, how much they
 * spent, their limit, how much they may do on their own, and revoking them.
 */
import { Schema } from "effect";

import { AiProviderKeySummary, ByokProviderId } from "./aiProviders.ts";
import { ModelSelection } from "./orchestration.ts";

/** Default local port of the App API (loopback and the docker bridge only). */
export const APP_SDK_DEFAULT_PORT = 3779;

/**
 * Gateway model an app gets for `model: "default"` until the person picks
 * another in Settings → Apps. Cheap and multilingual on purpose: apps run
 * unattended and often.
 */
export const APP_SDK_DEFAULT_CHAT_MODEL = "deepseek/deepseek-v3.2";

/** What an app may spend a month when neither the manifest nor the person says less. */
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
 * Which cloud folder an app uses:
 * - `account`  — `<appId>/`, shared by every computer of the account that has
 *                the same app (the default);
 * - `computer` — `<appId>@computer-<box>/`, this computer's own.
 * Switching moves no files: the app sees the other folder from then on.
 */
export const AppStorageScope = Schema.Literals(["account", "computer"]);
export type AppStorageScope = typeof AppStorageScope.Type;

/**
 * An app's folder in the account's cloud (`"storage"` in the manifest):
 * Cloud storage → bucket `apps` → `<appId>/` (or `<appId>@computer-<box>/`).
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
  /** The folder the app uses now, inside the bucket, e.g. `photos/`. */
  prefix: Schema.String,
  scope: AppStorageScope,
});
export type AppStorageInfo = typeof AppStorageInfo.Type;

/**
 * Where an app's answers (`/v1/chat/completions`, `/v1/models`) come from —
 * chosen per app in Settings → Apps; the app's code doesn't change:
 *
 * - `uno`      — the Uno AI gateway with the machine's key (default). The
 *                app's spending limit applies, the account's credits pay;
 * - `local`    — an OpenAI-compatible server on this computer (Ollama, LM
 *                Studio, vLLM, llama.cpp…) at `baseUrl`. Free, no limit;
 * - `personal` — Personal AI, a model on the account's own GPU (Uno GPU),
 *                paid by the hour while it is on. No per-app limit;
 * - `byok`     — a key the person stored in Settings → Agents (`keyProvider`:
 *                xAI, OpenRouter, OpenAI or a custom base URL). That provider
 *                bills the person; no per-app limit.
 *
 * Transcription follows `byok`; for `local` / `personal` it stays on the Uno
 * gateway (metered). Tasks (`/v1/tasks`) always run on the agent chosen for
 * jobs, whatever the provider.
 */
export const AppAiProviderKind = Schema.Literals(["uno", "local", "personal", "byok"]);
export type AppAiProviderKind = typeof AppAiProviderKind.Type;

export const APP_AI_PROVIDER_KINDS: ReadonlyArray<AppAiProviderKind> = [
  "uno",
  "local",
  "personal",
  "byok",
];

export const APP_AI_PROVIDER_LABELS: Readonly<Record<AppAiProviderKind, string>> = {
  uno: "Uno AI",
  local: "AI on this computer",
  personal: "Personal AI (your GPU)",
  byok: "Your own key",
};

export const AppAiProviderChoice = Schema.Struct({
  kind: AppAiProviderKind,
  /** `local`: the server's OpenAI base URL, e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: Schema.optionalKey(Schema.String),
  /** `byok`: which stored key. */
  keyProvider: Schema.optionalKey(ByokProviderId),
  /**
   * The model an app gets for `"default"` (or no model). Absent/empty: the
   * gateway's "Model for answers", or the first model the provider lists.
   */
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type AppAiProviderChoice = typeof AppAiProviderChoice.Type;

/** An OpenAI-compatible AI server found on (or added to) this computer. */
export const LocalAiEndpoint = Schema.Struct({
  /** `ollama`, `lmstudio`, `vllm`, `llamacpp`, `jan`, … or `manual`. */
  id: Schema.String,
  /** "Ollama", "LM Studio", … */
  label: Schema.String,
  baseUrl: Schema.String,
  models: Schema.Array(Schema.String),
  /** False: typed in by the person (and maybe not answering right now). */
  detected: Schema.Boolean,
  /** Answered its `/models` on the last look. */
  reachable: Schema.Boolean,
});
export type LocalAiEndpoint = typeof LocalAiEndpoint.Type;

export const PersonalAiOption = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  priceUsdPerHour: Schema.Number,
});
export type PersonalAiOption = typeof PersonalAiOption.Type;

/** What apps on this computer could use for answers right now. */
export const AppAiProviders = Schema.Struct({
  /** False: no Uno AI key on this computer. */
  unoConnected: Schema.Boolean,
  local: Schema.Array(LocalAiEndpoint),
  personal: Schema.Array(PersonalAiOption),
  /** Keys the person stored (configured ones only; never the key itself). */
  keys: Schema.Array(AiProviderKeySummary),
  checkedAt: Schema.NullOr(Schema.String),
});
export type AppAiProviders = typeof AppAiProviders.Type;

export const AppAiModelsInput = Schema.Struct({
  kind: AppAiProviderKind,
  baseUrl: Schema.optionalKey(Schema.String),
  keyProvider: Schema.optionalKey(ByokProviderId),
});
export type AppAiModelsInput = typeof AppAiModelsInput.Type;

export const AppAiModels = Schema.Struct({
  models: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  error: Schema.NullOr(Schema.String),
});
export type AppAiModels = typeof AppAiModels.Type;

export const AppAiApp = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.NullOr(Schema.String),
  /** What the manifest asks for. */
  chat: Schema.Boolean,
  tasks: Schema.Boolean,
  /** May put notifications into the Inbox (`"notify": true`). Absent on older daemons. */
  notify: Schema.optional(Schema.Boolean),
  status: AppAiStatus,
  /** Uno AI spend cap per month (UTC); the month's spending resets on the 1st. */
  limitUsd: Schema.Number,
  /** True when the person set the limit (rather than the manifest). */
  limitSetByPerson: Schema.Boolean,
  /** Everything counted against the limit: chat + tasks. */
  spentUsd: Schema.Number,
  /** Answers and transcription (metered by the daemon). */
  chatSpentUsd: Schema.Number,
  /** Agent tasks on the Uno AI gateway (the gateway's own numbers, by app label). */
  tasksSpentUsd: Schema.Number,
  /**
   * The limit is monthly: `spentUsd` / `chatSpentUsd` / `tasksSpentUsd` are
   * this month's (`period`, "2026-09", UTC); on the 1st they start from zero.
   */
  period: Schema.optional(Schema.String),
  /** Everything the app ever spent on Uno AI, this month included. */
  lifetimeSpentUsd: Schema.optional(Schema.Number),
  requests: Schema.Number,
  tasksStarted: Schema.Number,
  /** The most a task of this app may do on its own. */
  taskToolsCap: AppTaskTools,
  lastUsedAt: Schema.NullOr(Schema.String),
  /** Where the app's token lives, for people who wire a container by hand. */
  keyDir: Schema.String,
  /** Cloud storage of the app; null = the manifest doesn't ask for it. */
  storage: Schema.NullOr(AppStorageInfo),
  /** Where its answers come from (absent on older daemons = Uno AI). */
  provider: Schema.optional(AppAiProviderChoice),
  /** "Uno AI · deepseek/deepseek-v3.2", "Ollama on this computer · qwen3:4b". */
  providerLabel: Schema.optional(Schema.String),
  /** True when its answers spend Uno AI and so count against its limit. */
  metered: Schema.optional(Schema.Boolean),
  /**
   * The app serves an in-page chat (`<uno-chat>` through the SDK); `guarded`
   * — its backend checks sign-in (`allow`). An unguarded one on the internet
   * lets anyone with the link spend the app's AI: Settings and the tile warn.
   */
  chatWidget: Schema.optional(
    Schema.NullOr(Schema.Struct({ guarded: Schema.Boolean, seenAt: Schema.String })),
  ),
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
  /** What apps can use for answers here (absent on older daemons). */
  providers: Schema.optional(AppAiProviders),
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
  /** Shared cloud folder or this computer's own; files are not moved. */
  storageScope: Schema.optionalKey(AppStorageScope),
  /**
   * Delete every file in the app's current cloud folder (asked when the app
   * is removed). Allowed after the app's manifest is gone.
   */
  deleteCloudFiles: Schema.optionalKey(Schema.Boolean),
  /** Where the app's answers come from from now on. */
  provider: Schema.optionalKey(AppAiProviderChoice),
});
export type AppAiUpdateInput = typeof AppAiUpdateInput.Type;

/** One reading of the account's running Uno AI total (it only grows). */
export const UnoAiSpendSample = Schema.Struct({
  at: Schema.String,
  totalUsd: Schema.Number,
});
export type UnoAiSpendSample = typeof UnoAiSpendSample.Type;

/**
 * Home's "Uno AI spend": credits left and the running total as this computer
 * has read it over the last days (a day's spend = how much it grew that day).
 * "no-key" — no Uno AI on this machine; "unavailable" — the gateway doesn't
 * say; "unknown" — not read yet / offline.
 */
export const UnoAiSpend = Schema.Struct({
  status: Schema.Literals(["ok", "no-key", "unavailable", "unknown"]),
  creditsUsd: Schema.NullOr(Schema.Number),
  samples: Schema.Array(UnoAiSpendSample),
  checkedAt: Schema.NullOr(Schema.String),
});
export type UnoAiSpend = typeof UnoAiSpend.Type;

/**
 * Uno AI hours right now (`GET /v1/ai/status`, spec ai-hours.md): hours
 * left, AI power, requests in flight and whether they run slower than full
 * speed. "unavailable" — the gateway has no AI hours (older backend or the
 * flag is off): the interface shows nothing then.
 */
export const UnoAiStatus = Schema.Struct({
  status: Schema.Literals(["ok", "no-key", "unavailable", "unknown"]),
  hoursLeftMinutes: Schema.NullOr(Schema.Number),
  /** Max+AI: no hours limit; after the month's full-speed hours AI runs at standard speed. */
  unlimited: Schema.Boolean,
  fullSpeedHoursLeft: Schema.NullOr(Schema.Number),
  usedTodayMinutes: Schema.NullOr(Schema.Number),
  /** AI power multiplier: 1, 2, 4, 8. */
  power: Schema.NullOr(Schema.Number),
  inFlight: Schema.NullOr(Schema.Number),
  throttled: Schema.Boolean,
  speedPct: Schema.NullOr(Schema.Number),
  renewsAt: Schema.NullOr(Schema.String),
  plan: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.String),
});
export type UnoAiStatus = typeof UnoAiStatus.Type;
