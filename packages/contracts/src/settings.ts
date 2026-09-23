import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { EnvironmentId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  UnoModelRoute,
  ProviderOptionSelections,
} from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderInstanceConfig, ProviderInstanceId } from "./providerInstance.ts";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
export const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";

/**
 * Which environments the sidebar draws from.
 *
 * `"active"` keeps the historical behaviour — one environment at a time.
 * `"all"` unions every connected environment and leans on repository-based
 * grouping so the same repo checked out locally and on a server reads as one
 * project rather than two unrelated ones.
 *
 * Only consulted when the `allMachinesSidebar` Labs flag is on — with the flag off
 * the sidebar always behaves as `active`.
 */
export const SidebarEnvironmentScope = Schema.Literals(["active", "all"]);
export type SidebarEnvironmentScope = typeof SidebarEnvironmentScope.Type;
export const DEFAULT_SIDEBAR_ENVIRONMENT_SCOPE: SidebarEnvironmentScope = "active";

/**
 * How the sidebar tree is built out of the two things a chat belongs to: a
 * project and the machine it runs on.
 *
 * `"project"` and `"machine"` are mirrors of one another — the same two-level
 * renderer with the roles swapped. Whichever dimension is *not* the grouping
 * one is carried as a marker on the chat row (a machine chip, or the project
 * name), so it is never lost. The `*_machine` / `*_project` variants spend a
 * third level of nesting to make that dimension a sub-heading instead.
 *
 * Orthogonal to `SidebarProjectGroupingMode`, which decides what counts as one
 * project in the first place; both apply in all four modes.
 */
export const SidebarGroupBy = Schema.Literals([
  "project",
  "machine",
  "project_machine",
  "machine_project",
]);
export type SidebarGroupBy = typeof SidebarGroupBy.Type;
export const DEFAULT_SIDEBAR_GROUP_BY: SidebarGroupBy = "project";

export const SidebarMachineSortOrder = Schema.Literals(["activity", "name", "manual"]);
export type SidebarMachineSortOrder = typeof SidebarMachineSortOrder.Type;
export const DEFAULT_SIDEBAR_MACHINE_SORT_ORDER: SidebarMachineSortOrder = "activity";

/**
 * How many distinct hues machines can be told apart by.
 *
 * Three, because that is what survives validation: a fourth hue puts a pair on
 * screen that readers with the commonest colour-vision deficiencies cannot
 * separate, and violet — the obvious next candidate — is indistinguishable from
 * the blue slot under deuteranopia *and* already carries the app accent. So the
 * monogram is the identity, the hue is reinforcement, and machines past the
 * third get a neutral chip rather than a generated colour.
 */
export const SIDEBAR_MACHINE_COLOR_SLOT_COUNT = 3;

/** `0` is the neutral chip; `1…3` are the validated hues, assigned in order. */
export const SidebarMachineColorSlot = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(SIDEBAR_MACHINE_COLOR_SLOT_COUNT),
);
export type SidebarMachineColorSlot = typeof SidebarMachineColorSlot.Type;

export const SIDEBAR_MACHINE_MONOGRAM_MAX_LENGTH = 3;

/**
 * Per-machine display identity, keyed by environment id.
 *
 * Persisted rather than derived because the colour has to follow the machine,
 * not its position in the current list: recomputing slots when a machine is
 * added or removed would repaint chips the user had already learned. Empty
 * fields mean "keep the derived value" — this record only carries overrides and
 * the pinned slot assignment.
 */
export const SidebarMachineIdentity = Schema.Struct({
  monogram: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  colorSlot: SidebarMachineColorSlot.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type SidebarMachineIdentity = typeof SidebarMachineIdentity.Type;

// Cookie/session profile used by the built-in browser pane: one shared
// profile for the whole account, or an isolated profile per project.
export const BrowserProfileScope = Schema.Literals(["account", "project"]);
export type BrowserProfileScope = typeof BrowserProfileScope.Type;
export const DEFAULT_BROWSER_PROFILE_SCOPE: BrowserProfileScope = "account";

export const BrowserAutomationLevel = Schema.Literals(["off", "safe", "full"]);
export type BrowserAutomationLevel = typeof BrowserAutomationLevel.Type;
export const DEFAULT_BROWSER_AUTOMATION_LEVEL: BrowserAutomationLevel = "full";

// Who executes browser-bridge commands from harnesses: a connected app client
// (Electron webview) or the server-side headless Chromium. "auto" prefers a
// connected client and falls back to the server when nobody is subscribed —
// the headless/Telegram scenario.
export const BrowserExecutor = Schema.Literals(["auto", "local", "server"]);
export type BrowserExecutor = typeof BrowserExecutor.Type;
export const DEFAULT_BROWSER_EXECUTOR: BrowserExecutor = "auto";

export const ServerBrowserSettings = Schema.Struct({
  executor: BrowserExecutor.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_EXECUTOR)),
  ),
  // Policy gate for the server-side executor. The client-side gate
  // (ClientSettings.browserAutomationLevel) lives in localStorage and never
  // reaches the server, so the headless executor needs its own.
  serverAutomationLevel: BrowserAutomationLevel.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_AUTOMATION_LEVEL)),
  ),
});
export type ServerBrowserSettings = typeof ServerBrowserSettings.Type;

export const ClientSettingsSchema = Schema.Struct({
  autoOpenPlanSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  browserAutomationLevel: BrowserAutomationLevel.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_AUTOMATION_LEVEL)),
  ),
  browserProfileScope: BrowserProfileScope.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_PROFILE_SCOPE)),
  ),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // The machine the app opens on and offers first (new project, new chat,
  // sidebar switcher). `null` means "not chosen": the app then prefers an
  // online computer of the user's, then the daemon serving the page.
  defaultEnvironmentId: Schema.NullOr(EnvironmentId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // The one-time "Choose your default machine" hint in My machines was closed.
  defaultEnvironmentPromptDismissed: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Labs / feature-flag overrides. A sparse map from flag key to the user's
  // on/off choice; absent keys fall back to each flag's declared default in
  // the app-side registry (apps/web/src/featureFlags.ts). Kept as an open
  // string→boolean map on purpose so adding a new flag is a one-line registry
  // entry with no schema change.
  featureFlags: Schema.Record(Schema.String, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  onboardingCompleted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  unoLastModelRoute: UnoModelRoute.pipe(
    Schema.withDecodingDefault(Effect.succeed("default" as const)),
  ),
  // Model favorites. Historically keyed by provider kind, now
  // widened to `ProviderInstanceId` so users can favorite a specific model
  // on a custom provider instance (e.g. "Codex Personal · gpt-5") without
  // the UI collapsing it into the same bucket as the default Codex. The
  // widening is backward-compatible by construction: prior provider-kind
  // strings satisfy the `ProviderInstanceId` slug schema, so previously
  // persisted favorites decode unchanged and continue to point at the
  // default instance for their kind (because `defaultInstanceIdForDriver(kind)`
  // uses the same slug). The field name is kept as `provider` for storage
  // stability; new call sites should treat the value as an instance id.
  favorites: Schema.Array(
    Schema.Struct({
      provider: ProviderInstanceId,
      model: TrimmedNonEmptyString,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: Schema.Record(
    ProviderInstanceId,
    Schema.Struct({
      hiddenModels: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
      modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarEnvironmentScope: SidebarEnvironmentScope.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_ENVIRONMENT_SCOPE)),
  ),
  sidebarGroupBy: SidebarGroupBy.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_GROUP_BY)),
  ),
  sidebarMachineSortOrder: SidebarMachineSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_MACHINE_SORT_ORDER)),
  ),
  sidebarMachineIdentity: Schema.Record(TrimmedNonEmptyString, SidebarMachineIdentity).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  sidebarMachineOrder: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  // Rows from unreachable machines are dimmed rather than removed by default:
  // a thread that vanishes reads as "that work is gone", which is the opposite
  // of what an offline machine means. Users who want the shorter list opt out.
  sidebarShowUnreachable: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl = "text" | "password" | "textarea" | "switch";

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

export const CodexSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Codex binary used by this instance.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME path",
        description: "Custom Codex home and config directory.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow home path",
        description:
          "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
        providerSettingsForm: {
          placeholder: "~/.codex-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "shadowHomePath"],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude binary used by this instance.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Claude HOME path",
        description:
          "Custom HOME used when running this Claude instance. Keeps .claude.json and .claude separate.",
        providerSettingsForm: { placeholder: "~", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: {
          placeholder: "e.g. --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "launchArgs"],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const CursorSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("agent").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Cursor agent binary.",
        providerSettingsForm: { placeholder: "agent", clearWhenEmpty: "omit" },
      }),
    ),
    apiEndpoint: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API endpoint",
        description: "Override the Cursor API endpoint for this instance.",
        providerSettingsForm: {
          placeholder: "https://...",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "apiEndpoint"],
  },
);
export type CursorSettings = typeof CursorSettings.Type;

export const HermesSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("hermes").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Hermes Agent binary (hermes-agent[acp]).",
        providerSettingsForm: { placeholder: "hermes", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath"],
  },
);
export type HermesSettings = typeof HermesSettings.Type;

export const OpenCodeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the OpenCode binary.",
        providerSettingsForm: {
          placeholder: "opencode",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server URL",
        description: "Leave blank to let Uno Work spawn the server when needed.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:4096",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverPassword: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server password",
        description: "Stored in plain text on disk.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "serverUrl", "serverPassword"],
  },
);
export type OpenCodeSettings = typeof OpenCodeSettings.Type;

export const UnoProviderSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("uno-code").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Uno Code binary.",
        providerSettingsForm: {
          placeholder: "uno-code",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server URL",
        description: "Leave blank to let Uno Work spawn the server when needed.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:4096",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverPassword: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server password",
        description: "Stored in plain text on disk.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "serverUrl", "serverPassword"],
  },
);
export type UnoProviderSettings = typeof UnoProviderSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const UNO_GATEWAY_BASE_URL = "https://api.getuno.xyz/v1";

/**
 * Personal AI — модели на личном GPU аккаунта (Uno GPU). OpenAI-совместимый
 * вход — `${UNO_PERSONAL_AI_BASE_URL}/v1`, список/старт/стоп —
 * `${UNO_PERSONAL_AI_BASE_URL}/personal/models`. Ключ — тот же ключ шлюза.
 */
export const UNO_PERSONAL_AI_BASE_URL = "https://gpu.uno4.dev";

/**
 * Уровень доступа агентских сессий к аккаунту Uno. Демон чеканит на боксе
 * scoped-токен этого уровня и кладёт его в env харнесов; "off" выключает
 * выдачу целиком.
 *
 * "purchase" больше не чеканится: агентский ключ не должен уметь заказывать
 * платные продукты — покупка остаётся явным действием человека в UI, которое
 * идёт ключом аккаунта, а не ключом из окружения агента. Литерал оставлен,
 * чтобы уже сохранённые настройки читались; уровень приводится к допустимому
 * через {@link clampUnoAgentAccessLevel}.
 */
export const UnoAgentAccessLevel = Schema.Literals(["off", "read", "manage", "purchase"]);
export type UnoAgentAccessLevel = typeof UnoAgentAccessLevel.Type;

/** Уровни, которые демон вправе чеканить для агентских сессий. */
export const MINTABLE_UNO_AGENT_ACCESS_LEVELS = ["off", "read", "manage"] as const;
export type MintableUnoAgentAccessLevel = (typeof MINTABLE_UNO_AGENT_ACCESS_LEVELS)[number];

/**
 * Приводит сохранённый уровень к тому, что можно выдать агенту. Легаси
 * "purchase" понижается до "manage": scope `infra:purchase` в окружение
 * агента не попадает никогда.
 */
export function clampUnoAgentAccessLevel(level: UnoAgentAccessLevel): MintableUnoAgentAccessLevel {
  return level === "purchase" ? "manage" : level;
}

export const UnoAccountSettings = Schema.Struct({
  apiKey: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  agentAccess: UnoAgentAccessLevel.pipe(
    Schema.withDecodingDefault(Effect.succeed("read" as const satisfies UnoAgentAccessLevel)),
  ),
  /**
   * Хранить сохранённые логины (Credentials) в аккаунте Uno, чтобы они были
   * одни и те же на всех машинах пользователя — на боксе с браузерной версией
   * и на десктопе. Выключено по умолчанию: пароли покидают машину только по
   * явному согласию. Требует `apiKey`.
   */
  credentialsSync: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Control-plane image id to launch new work boxes from. `null` means the
   * built-in default (`UNO_WORK_GOLDEN_IMAGE_ID` in `workspace.ts`); set it
   * when an account has its own golden image.
   */
  goldenImageId: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /**
   * Номер Uno-бокса, на котором живёт демон. Пишет консоль при входе в Work
   * (fishcode `box/work_box_token.go`); вручную не задаётся.
   */
  boxId: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /**
   * Узкий токен `uno_agt_` на СВОЙ бокс (чтение, питание, порты — без
   * удаления, покупок и аккаунта). Пишет консоль рядом с ключом ИИ; им ходит
   * экран «This computer», когда в `apiKey` лежит ключ ИИ `unollm_`, который
   * консоль не принимает. Клиенту не отдаётся (`redactServerSettingsForClient`).
   */
  boxToken: Schema.optionalKey(Schema.String),
});
export type UnoAccountSettings = typeof UnoAccountSettings.Type;

/**
 * A sidebar pin: an app, a file, a folder or a link, one click away in every
 * sidebar mode. Chats are pinned on the chat itself (`pinnedAt`), not here.
 * Kept on the machine (like `machineOnboarded`): the same computer is opened
 * from app.uno4.work, its own address, the desktop app and a phone.
 */
export const UnoPinKind = Schema.Literals(["app", "file", "folder", "link"]);
export type UnoPinKind = typeof UnoPinKind.Type;

export const UnoPin = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  kind: UnoPinKind,
  title: Schema.String.check(Schema.isMaxLength(200)),
  /** App or link: its web address. File or folder: an absolute path. */
  target: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  /** App icon (an emoji or a letter), when the app has one. */
  icon: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(64)))),
});
export type UnoPin = typeof UnoPin.Type;

export const MAX_UNO_PINS = 50;

/**
 * Settings → Apps → "AI for apps": what an app gets from the App SDK when it
 * does not name a model or a harness (docs/app-sdk.md).
 */
export const AppsAiSettings = Schema.Struct({
  /** Gateway model for `/v1/chat/completions` with model "default"; "" = built-in default. */
  chatModel: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Harness + model for app tasks; absent/null = the machine's default harness. */
  taskModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
});
export type AppsAiSettings = typeof AppsAiSettings.Type;

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // The first-run setup was finished or skipped on this machine. Kept on the
  // machine, not in the browser: one computer is opened from app.uno4.work,
  // its own address and a phone, and each has its own localStorage.
  machineOnboarded: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Sidebar pins (apps, files, folders, links) — see `UnoPin`.
  pins: Schema.Array(UnoPin).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  // Where a chat's agent may spawn threads through the bridge
  // (`POST /api/threads`): only its own project, or any project.
  agentThreadsScope: Schema.Literals(["own-project", "any-project"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("own-project" as const)),
  ),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const satisfies ThreadEnvMode)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("uno"),
        model:
          DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[ProviderDriverKind.make("uno")] ??
          DEFAULT_GIT_TEXT_GENERATION_MODEL,
      }),
    ),
  ),

  // Legacy single-instance-per-driver settings. Continues to be the source
  // of truth until `providerInstances` (below) lands per-driver migration
  // shims and the server starts hydrating instances from it. Driver-specific
  // schemas live here for the duration of the migration; once each driver
  // owns its config in its own package, this struct shrinks to nothing and
  // is removed entirely.
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    hermes: HermesSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    uno: UnoProviderSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  browser: ServerBrowserSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  uno: UnoAccountSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  appsAi: AppsAiSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  shadowHomePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  launchArgs: Schema.optionalKey(Schema.String),
});

const CursorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  apiEndpoint: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const HermesSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OpenCodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  serverUrl: Schema.optionalKey(Schema.String),
  serverPassword: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerSettingsPatch = Schema.Struct({
  // Server settings
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  machineOnboarded: Schema.optionalKey(Schema.Boolean),
  pins: Schema.optionalKey(Schema.Array(UnoPin)),
  agentThreadsScope: Schema.optionalKey(Schema.Literals(["own-project", "any-project"])),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  addProjectBaseDirectory: Schema.optionalKey(Schema.String),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(Schema.String),
      otlpMetricsUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  browser: Schema.optionalKey(
    Schema.Struct({
      executor: Schema.optionalKey(BrowserExecutor),
      serverAutomationLevel: Schema.optionalKey(BrowserAutomationLevel),
    }),
  ),
  appsAi: Schema.optionalKey(
    Schema.Struct({
      chatModel: Schema.optionalKey(Schema.String),
      taskModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
    }),
  ),
  uno: Schema.optionalKey(
    Schema.Struct({
      apiKey: Schema.optionalKey(Schema.String),
      agentAccess: Schema.optionalKey(UnoAgentAccessLevel),
      credentialsSync: Schema.optionalKey(Schema.Boolean),
      goldenImageId: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      cursor: Schema.optionalKey(CursorSettingsPatch),
      hermes: Schema.optionalKey(HermesSettingsPatch),
      opencode: Schema.optionalKey(OpenCodeSettingsPatch),
      uno: Schema.optionalKey(OpenCodeSettingsPatch),
    }),
  ),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export const ClientSettingsPatch = Schema.Struct({
  autoOpenPlanSidebar: Schema.optionalKey(Schema.Boolean),
  browserAutomationLevel: Schema.optionalKey(BrowserAutomationLevel),
  browserProfileScope: Schema.optionalKey(BrowserProfileScope),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  defaultEnvironmentId: Schema.optionalKey(Schema.NullOr(EnvironmentId)),
  defaultEnvironmentPromptDismissed: Schema.optionalKey(Schema.Boolean),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  diffWordWrap: Schema.optionalKey(Schema.Boolean),
  featureFlags: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
  unoLastModelRoute: Schema.optionalKey(UnoModelRoute),
  favorites: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        provider: ProviderInstanceId,
        model: TrimmedNonEmptyString,
      }),
    ),
  ),
  providerModelPreferences: Schema.optionalKey(
    Schema.Record(
      ProviderInstanceId,
      Schema.Struct({
        hiddenModels: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
        modelOrder: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
      }),
    ),
  ),
  sidebarEnvironmentScope: Schema.optionalKey(SidebarEnvironmentScope),
  sidebarGroupBy: Schema.optionalKey(SidebarGroupBy),
  sidebarMachineSortOrder: Schema.optionalKey(SidebarMachineSortOrder),
  sidebarMachineIdentity: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarMachineIdentity),
  ),
  sidebarMachineOrder: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  sidebarShowUnreachable: Schema.optionalKey(Schema.Boolean),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  timestampFormat: Schema.optionalKey(TimestampFormat),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
