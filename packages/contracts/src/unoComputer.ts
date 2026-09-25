/**
 * "This computer" — the Uno Work desktop view of the machine the daemon runs on.
 *
 * Uno Work is the screen of the user's computer, so the facts a console shows
 * about a box (status, size, monitor, what it is doing, installed apps, the app
 * catalog) are read here through the daemon, on behalf of this machine, with
 * the same account key `uno.cloud.*` uses. The browser never talks to the
 * control plane directly.
 *
 * Every read carries an `availability` rather than failing: the control-plane
 * routes behind the monitor, the activity feed and the app catalog ship on
 * their own schedule, and a route that does not exist yet must render as
 * "coming soon", not as a red error.
 */
import { Schema } from "effect";

/**
 * - `ok`          — data is here.
 * - `unavailable` — the control plane does not have this route yet (404/405/501):
 *                   the UI says "coming soon".
 * - `offline`     — the route exists but the computer is asleep or off, so there
 *                   is nothing live to read.
 * - `error`       — anything else (network, 5xx); `message` says what.
 */
export const UnoComputerAvailability = Schema.Literals(["ok", "unavailable", "offline", "error"]);
export type UnoComputerAvailability = typeof UnoComputerAvailability.Type;

export const UnoComputerPort = Schema.Struct({
  /** Port inside the computer. */
  port: Schema.Number,
  /** Port on the public address, when forwarded. */
  externalPort: Schema.NullOr(Schema.Number),
  protocol: Schema.String,
});
export type UnoComputerPort = typeof UnoComputerPort.Type;

/* ------------------------------------------------------------------ *
 * Boost ×2 for an hour
 *
 * The computer restarts into twice its size for an hour and restarts once
 * more back. The control plane sends `boost` on `GET /boxes/{id}` only when
 * the feature is on for the account — absent means nothing about boost shows.
 * ------------------------------------------------------------------ */

/**
 * - `off`      — not boosted; `ramMb`/`vcpu` are what a boost would give;
 * - `starting` — restarting into the boosted size;
 * - `active`   — boosted until `endsAt`;
 * - `ending`   — restarting back to the normal size.
 */
export const UnoComputerBoostState = Schema.Literals(["off", "starting", "active", "ending"]);
export type UnoComputerBoostState = typeof UnoComputerBoostState.Type;

export const UnoComputerBoost = Schema.Struct({
  /** Can a boost start now; when false and off, `reason` says why. */
  available: Schema.Boolean,
  state: UnoComputerBoostState,
  /** The boosted size. */
  ramMb: Schema.Number,
  vcpu: Schema.Number,
  /** The normal size it returns to. */
  baseRamMb: Schema.Number,
  baseVcpu: Schema.Number,
  hours: Schema.Number,
  startedAt: Schema.NullOr(Schema.String),
  /** Set while starting / active / ending. */
  endsAt: Schema.NullOr(Schema.String),
  /** Boost hours of the account's plan for a calendar month (UTC); 0 = the plan has none. */
  hoursPerMonth: Schema.Number,
  hoursUsed: Schema.Number,
  hoursLeft: Schema.Number,
  /** When this month's hours come back (1st of next month, 00:00 UTC); null if unknown. */
  periodResetsAt: Schema.NullOr(Schema.String),
  /** Plain words why a boost can't start; null when it can. */
  reason: Schema.NullOr(Schema.String),
});
export type UnoComputerBoost = typeof UnoComputerBoost.Type;

/**
 * Economy mode ("runs only when needed"): the computer sleeps when nobody uses
 * it and wakes in about a second when something needs it — Uno Work opening, a
 * Telegram/Slack message through Uno, a visit to one of its apps. Absent on the
 * box when the console does not offer it to this account yet.
 */
export const UnoComputerEconomy = Schema.Struct({
  enabled: Schema.Boolean,
  /** Cannot be turned off on this plan (the free trial computer). */
  locked: Schema.Boolean,
  /** "plan" — the plan's default, "owner" — the person chose. */
  source: Schema.String,
  idleTimeoutS: Schema.Number,
  defaultIdleTimeoutS: Schema.Number,
  /** off | awake | sleeping | waking | stopped */
  state: Schema.String,
  /** When an awake computer will sleep if nothing happens; null while busy. */
  sleepAfter: Schema.NullOr(Schema.String),
  /** What keeps it awake right now: agent:1, clients:2, terminal:1, run, app:… */
  busy: Schema.Array(Schema.String),
  lastSleepAt: Schema.NullOr(Schema.String),
  lastWakeAt: Schema.NullOr(Schema.String),
  /** work | telegram | slack | http | schedule | run | api */
  lastWakeSource: Schema.NullOr(Schema.String),
});
export type UnoComputerEconomy = typeof UnoComputerEconomy.Type;

export const UnoComputerBox = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  /** Control-plane status: running | sleeping | stopped | provisioning | … */
  status: Schema.String,
  os: Schema.String,
  ramMb: Schema.Number,
  vcpu: Schema.Number,
  diskGb: Schema.Number,
  /** When the computer last woke up; null when asleep/off or not reported. */
  startedAt: Schema.NullOr(Schema.String),
  /** Web address of the computer, when it has one. */
  address: Schema.NullOr(Schema.String),
  /** Ready-to-run SSH command for the "For engineers" door. */
  ssh: Schema.NullOr(Schema.String),
  ports: Schema.Array(UnoComputerPort),
  /** Boost ×2; absent when boost is not offered to this account. */
  boost: Schema.optional(UnoComputerBoost),
  /** Economy mode; absent when the console does not offer it yet. */
  economy: Schema.optional(UnoComputerEconomy),
});
export type UnoComputerBox = typeof UnoComputerBox.Type;

export const UnoComputerCandidate = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  status: Schema.String,
});
export type UnoComputerCandidate = typeof UnoComputerCandidate.Type;

export const UnoComputerState = Schema.Struct({
  /** False when the daemon has no Uno account key. */
  linked: Schema.Boolean,
  /** True when `box` is the machine this daemon runs on. */
  own: Schema.Boolean,
  box: Schema.NullOr(UnoComputerBox),
  /**
   * When the daemon is not on an Uno computer (a laptop), the account's
   * computers the user can look at instead.
   */
  candidates: Schema.Array(UnoComputerCandidate),
  error: Schema.NullOr(Schema.String),
  fetchedAt: Schema.String,
});
export type UnoComputerState = typeof UnoComputerState.Type;

/** Every per-computer call takes an optional box; absent = this machine. */
export const UnoComputerTargetInput = Schema.Struct({
  boxId: Schema.optional(Schema.Number),
});
export type UnoComputerTargetInput = typeof UnoComputerTargetInput.Type;

export const UnoComputerMetricsPoint = Schema.Struct({
  t: Schema.String,
  cpuPct: Schema.Number,
  memMb: Schema.Number,
});
export type UnoComputerMetricsPoint = typeof UnoComputerMetricsPoint.Type;

export const UnoComputerMetrics = Schema.Struct({
  availability: UnoComputerAvailability,
  message: Schema.NullOr(Schema.String),
  sampledAt: Schema.NullOr(Schema.String),
  uptimeS: Schema.NullOr(Schema.Number),
  cpuPct: Schema.NullOr(Schema.Number),
  vcpu: Schema.NullOr(Schema.Number),
  memUsedMb: Schema.NullOr(Schema.Number),
  memLimitMb: Schema.NullOr(Schema.Number),
  diskUsedGb: Schema.NullOr(Schema.Number),
  diskTotalGb: Schema.NullOr(Schema.Number),
  history: Schema.Array(UnoComputerMetricsPoint),
});
export type UnoComputerMetrics = typeof UnoComputerMetrics.Type;

export const UnoComputerActivityInput = Schema.Struct({
  boxId: Schema.optional(Schema.Number),
  tail: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(200)),
  ),
});
export type UnoComputerActivityInput = typeof UnoComputerActivityInput.Type;

export const UnoComputerActivity = Schema.Struct({
  availability: UnoComputerAvailability,
  message: Schema.NullOr(Schema.String),
  /** journal | docker — where the lines came from. */
  source: Schema.NullOr(Schema.String),
  lines: Schema.Array(Schema.String),
});
export type UnoComputerActivity = typeof UnoComputerActivity.Type;

export const UnoComputerAppSettingOption = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
});
export type UnoComputerAppSettingOption = typeof UnoComputerAppSettingOption.Type;

export const UnoComputerAppSetting = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  secret: Schema.Boolean,
  defaultValue: Schema.NullOr(Schema.String),
  /** Must be filled in (when the field applies, see showIf). */
  required: Schema.optional(Schema.Boolean),
  /** A choice: render a picker, not a text box. */
  options: Schema.optional(Schema.Array(UnoComputerAppSettingOption)),
  /** The field only applies when another field has this value. */
  showIf: Schema.optional(
    Schema.NullOr(Schema.Struct({ name: Schema.String, value: Schema.String })),
  ),
});
export type UnoComputerAppSetting = typeof UnoComputerAppSetting.Type;

/**
 * What an app asks of the computer's AI (its manifest's `"ai"`): answers
 * (`chat`), agent jobs (`tasks`) and at most how much it may spend a month on
 * Uno AI (`limitUsd`; null = the default $10). Shown before install and on
 * its tile.
 */
/** An app's official phone apps (App Store / Google Play) and how to connect them. */
export const UnoAppMobile = Schema.Struct({
  ios: Schema.NullOr(Schema.String),
  android: Schema.NullOr(Schema.String),
  /** The store name when it differs from the app (Bitwarden for Vaultwarden). */
  appName: Schema.NullOr(Schema.String),
  /** How to connect after install ("choose Self-hosted, enter your address"). */
  note: Schema.NullOr(Schema.String),
});
export type UnoAppMobile = typeof UnoAppMobile.Type;

export const UnoAppAiUse = Schema.Struct({
  chat: Schema.Boolean,
  tasks: Schema.Boolean,
  limitUsd: Schema.NullOr(Schema.Number),
});
export type UnoAppAiUse = typeof UnoAppAiUse.Type;

export const UnoComputerAppTemplate = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  category: Schema.String,
  icon: Schema.String,
  minRamMb: Schema.Number,
  minDiskGb: Schema.Number,
  settings: Schema.Array(UnoComputerAppSetting),
  /** What to know after install (how to sign in, limits). */
  notes: Schema.optional(Schema.NullOr(Schema.String)),
  /** Storefront (console with App Store v2; older consoles leave these out). */
  /** Place in the store: lower = higher. 0 = unknown. */
  rank: Schema.optional(Schema.Number),
  /** In the "Recommended" row. */
  featured: Schema.optional(Schema.Boolean),
  /** Built by Uno (Notetaker). */
  madeByUno: Schema.optional(Schema.Boolean),
  /** One plain line on what the app gives you. */
  tagline: Schema.optional(Schema.NullOr(Schema.String)),
  /** Other words people search it by ("google drive", "1password"). */
  keywords: Schema.optional(Schema.Array(Schema.String)),
  /** The brand logo, served by Uno (absolute URL). */
  iconUrl: Schema.optional(Schema.NullOr(Schema.String)),
  /** Signs in with the Uno account: "oidc" — inside the app, "edge" — at its door. */
  sso: Schema.optional(Schema.NullOr(Schema.Literals(["oidc", "edge"]))),
  /** Uses this computer's AI (catalog `ai`); null/absent = no AI. */
  ai: Schema.optional(Schema.NullOr(UnoAppAiUse)),
  /** Who makes it: "uno" (Made by Uno — first in the store) or "community". */
  publisher: Schema.optional(Schema.NullOr(Schema.Literals(["uno", "community"]))),
  /** Official phone apps that connect to this app's address; null — none. */
  mobile: Schema.optional(Schema.NullOr(UnoAppMobile)),
});
export type UnoComputerAppTemplate = typeof UnoComputerAppTemplate.Type;

export const UnoComputerAppCategory = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** For developers: shown last, never in "Recommended". */
  technical: Schema.Boolean,
});
export type UnoComputerAppCategory = typeof UnoComputerAppCategory.Type;

export const UnoComputerInstalledAppState = Schema.Literals([
  "running",
  "installing",
  "failed",
  "unknown",
]);
export type UnoComputerInstalledAppState = typeof UnoComputerInstalledAppState.Type;

export const UnoComputerAppCredential = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  /** Hidden until "Show"; always copyable. */
  secret: Schema.Boolean,
  /** The value is an address (an invite link). */
  link: Schema.Boolean,
});
export type UnoComputerAppCredential = typeof UnoComputerAppCredential.Type;

/** An app's own AI key. `limitUsd` null = no limit. */
export const UnoComputerAppAiKey = Schema.Struct({
  limitUsd: Schema.NullOr(Schema.Number),
  spentUsd: Schema.Number,
});
export type UnoComputerAppAiKey = typeof UnoComputerAppAiKey.Type;

export const UnoComputerInstalledApp = Schema.Struct({
  /** Stable key for the list: `service:<id>` or `port:<n>`. */
  key: Schema.String,
  name: Schema.String,
  /** Catalog template this came from, when known. */
  templateId: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(Schema.String),
  /** Brand logo of the catalog template, when Uno has one. */
  iconUrl: Schema.optional(Schema.NullOr(Schema.String)),
  state: UnoComputerInstalledAppState,
  url: Schema.NullOr(Schema.String),
  /** Last deployment, so a running install can be re-attached after a reload. */
  deploymentId: Schema.NullOr(Schema.Number),
  /** What to know after install. */
  notes: Schema.optional(Schema.NullOr(Schema.String)),
  /** How to sign in: login, generated password, invite link. Owner-only. */
  credentials: Schema.optional(Schema.Array(UnoComputerAppCredential)),
  /** An App Store install the person can remove ("Remove" on the card). */
  removable: Schema.optional(Schema.Boolean),
  /** The app's web port inside the computer: a program found on it is this app, not another tile. */
  webPort: Schema.optional(Schema.NullOr(Schema.Number)),
  /** Docker compose project of the app's containers (`uno-memos`). */
  composeProject: Schema.optional(Schema.NullOr(Schema.String)),
  /** The app's own AI key (Open WebUI, Notetaker): what it spent and its limit. */
  aiKey: Schema.optional(Schema.NullOr(UnoComputerAppAiKey)),
  /**
   * How the app signs in with the Uno account: "oidc" — the app itself signs in
   * with Uno (Open opens it already signed in); "edge" — the address is closed
   * behind Uno sign-in, then the app's own sign-in. null — only its own sign-in.
   */
  sso: Schema.optional(Schema.NullOr(Schema.Literals(["oidc", "edge"]))),
  /** How many people (Uno accounts) the owner shared the app with. */
  sharedWith: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type UnoComputerInstalledApp = typeof UnoComputerInstalledApp.Type;

export const UnoComputerApps = Schema.Struct({
  catalog: Schema.Struct({
    availability: UnoComputerAvailability,
    message: Schema.NullOr(Schema.String),
    templates: Schema.Array(UnoComputerAppTemplate),
    /** Store sections in tab order (empty with an older console). */
    categories: Schema.optional(Schema.Array(UnoComputerAppCategory)),
  }),
  installed: Schema.Struct({
    availability: UnoComputerAvailability,
    message: Schema.NullOr(Schema.String),
    apps: Schema.Array(UnoComputerInstalledApp),
  }),
});
export type UnoComputerApps = typeof UnoComputerApps.Type;

export const UnoComputerInstallAppInput = Schema.Struct({
  boxId: Schema.optional(Schema.Number),
  templateId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  settings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Install even though the computer has less memory than the app asks for. */
  allowLowMemory: Schema.optional(Schema.Boolean),
});
export type UnoComputerInstallAppInput = typeof UnoComputerInstallAppInput.Type;

export const UnoComputerInstallAppResult = Schema.Struct({
  /** null when the install did not start and needs the person's answer (confirm). */
  deploymentId: Schema.NullOr(Schema.Number),
  /**
   * Set when Uno asks to confirm first — today only "low_memory": the app wants
   * more memory than this computer has. Resend with allowLowMemory to proceed.
   */
  confirm: Schema.optional(
    Schema.NullOr(Schema.Struct({ kind: Schema.String, message: Schema.String })),
  ),
});
export type UnoComputerInstallAppResult = typeof UnoComputerInstallAppResult.Type;

export const UnoComputerInstallStatusInput = Schema.Struct({
  deploymentId: Schema.Number,
  /** Only lines after this sequence number are returned. */
  afterSeq: Schema.optional(Schema.Number),
});
export type UnoComputerInstallStatusInput = typeof UnoComputerInstallStatusInput.Type;

export const UnoComputerInstallLine = Schema.Struct({
  seq: Schema.Number,
  text: Schema.String,
});
export type UnoComputerInstallLine = typeof UnoComputerInstallLine.Type;

export const UnoComputerInstallStatus = Schema.Struct({
  deploymentId: Schema.Number,
  state: Schema.Literals(["installing", "running", "failed"]),
  /** Raw deployment status from the control plane (queued, building, success, …). */
  status: Schema.String,
  lines: Schema.Array(UnoComputerInstallLine),
  /** Pass back as `afterSeq` on the next poll. */
  nextSeq: Schema.Number,
  /** Where the app answers, once running and known. */
  url: Schema.NullOr(Schema.String),
});
export type UnoComputerInstallStatus = typeof UnoComputerInstallStatus.Type;

/** Remove an App Store app. Its data stays unless `deleteData` is explicitly true. */
export const UnoComputerRemoveAppInput = Schema.Struct({
  boxId: Schema.optional(Schema.Number),
  deploymentId: Schema.Number,
  deleteData: Schema.optional(Schema.Boolean),
});
export type UnoComputerRemoveAppInput = typeof UnoComputerRemoveAppInput.Type;

export const UnoComputerRemoveAppResult = Schema.Struct({
  removed: Schema.Boolean,
  templateId: Schema.NullOr(Schema.String),
  dataDeleted: Schema.Boolean,
});
export type UnoComputerRemoveAppResult = typeof UnoComputerRemoveAppResult.Type;

/** Set (or, with null, remove) the spending limit of an app's own AI key. */
export const UnoComputerSetAppAiLimitInput = Schema.Struct({
  boxId: Schema.optional(Schema.Number),
  deploymentId: Schema.Number,
  limitUsd: Schema.NullOr(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100_000)),
  ),
});
export type UnoComputerSetAppAiLimitInput = typeof UnoComputerSetAppAiLimitInput.Type;

export const UnoComputerSetAppAiLimitResult = Schema.Struct({
  aiKey: UnoComputerAppAiKey,
});
export type UnoComputerSetAppAiLimitResult = typeof UnoComputerSetAppAiLimitResult.Type;

/** A link that opens an App Store app already signed in with the Uno account. */
export const UnoComputerOpenAppInput = Schema.Struct({
  boxId: Schema.optional(Schema.Number),
  deploymentId: Schema.Number,
});
export type UnoComputerOpenAppInput = typeof UnoComputerOpenAppInput.Type;

export const UnoComputerOpenAppResult = Schema.Struct({
  /** One-time sign-in link (valid once, for a minute), or the app address. */
  url: Schema.String,
  /** false — `url` is just the address: the app asks for its own sign-in. */
  signedIn: Schema.Boolean,
});
export type UnoComputerOpenAppResult = typeof UnoComputerOpenAppResult.Type;

/** A person the app is shared with (their Uno account). */
export const UnoComputerAppPerson = Schema.Struct({
  userId: Schema.Number,
  name: Schema.String,
  email: Schema.NullOr(Schema.String),
});
export type UnoComputerAppPerson = typeof UnoComputerAppPerson.Type;

export const UnoComputerAppAccessInput = Schema.Struct({
  boxId: Schema.optional(Schema.Number),
  deploymentId: Schema.Number,
});
export type UnoComputerAppAccessInput = typeof UnoComputerAppAccessInput.Type;

export const UnoComputerAppAccess = Schema.Struct({
  people: Schema.Array(UnoComputerAppPerson),
  /** false — installed before Sign in with Uno: reinstall (data is kept) to share it. */
  ready: Schema.Boolean,
});
export type UnoComputerAppAccess = typeof UnoComputerAppAccess.Type;

export const UnoComputerShareAppInput = Schema.Struct({
  boxId: Schema.optional(Schema.Number),
  deploymentId: Schema.Number,
  /** Email (or username) of their Uno account. */
  login: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(254)),
});
export type UnoComputerShareAppInput = typeof UnoComputerShareAppInput.Type;

export const UnoComputerUnshareAppInput = Schema.Struct({
  boxId: Schema.optional(Schema.Number),
  deploymentId: Schema.Number,
  userId: Schema.Number,
});
export type UnoComputerUnshareAppInput = typeof UnoComputerUnshareAppInput.Type;

/** Turn economy mode on/off or change its idle timer (0 = default). */
export const UnoComputerSetEconomyInput = Schema.Struct({
  boxId: Schema.optional(Schema.Number),
  enabled: Schema.optional(Schema.Boolean),
  idleTimeoutS: Schema.optional(Schema.Number),
});
export type UnoComputerSetEconomyInput = typeof UnoComputerSetEconomyInput.Type;

/**
 * A client tells the daemon the person is here (`input: true` after a click or
 * a key press, throttled) or just asks for the latest economy picture
 * (`input: false`). The answer is what the client needs to behave well around
 * sleep: when the computer will sleep, so an idle tab does not wake it back up.
 */
export const UnoEconomyPresenceInput = Schema.Struct({
  input: Schema.Boolean,
});
export type UnoEconomyPresenceInput = typeof UnoEconomyPresenceInput.Type;

export const UnoEconomyPresence = Schema.Struct({
  /** This daemon runs on an Uno computer whose economy mode is on. */
  enabled: Schema.Boolean,
  state: Schema.String,
  sleepAfter: Schema.NullOr(Schema.String),
  idleTimeoutS: Schema.Number,
  busy: Schema.Array(Schema.String),
  /** When the daemon last heard back from the console; null — never. */
  reportedAt: Schema.NullOr(Schema.String),
});
export type UnoEconomyPresence = typeof UnoEconomyPresence.Type;

export const UnoComputerPowerInput = Schema.Struct({
  boxId: Schema.optional(Schema.Number),
  action: Schema.Literals(["wake", "sleep", "start", "stop"]),
});
export type UnoComputerPowerInput = typeof UnoComputerPowerInput.Type;

/* ------------------------------------------------------------------ *
 * Programs found on this machine (the desktop's app grid)
 *
 * The daemon looks at the machine it runs on and turns what it finds into
 * programs: an explicit manifest in `~/.uno/apps/<id>.json`, docker containers
 * with published ports, services the user (or an agent) added to systemd, and
 * any other process listening on a TCP port. Nothing here goes on the internet
 * by itself — "Show on the internet" is a click.
 * ------------------------------------------------------------------ */

/**
 * - `manifest` — registered in `~/.uno/apps/<id>.json` (by a person or an agent);
 * - `docker`   — a container with a published port;
 * - `systemd`  — a service unit someone added (not one the OS ships);
 * - `port`     — any other process listening on TCP.
 */
export const UnoMachineAppSource = Schema.Literals(["manifest", "docker", "systemd", "port"]);
export type UnoMachineAppSource = typeof UnoMachineAppSource.Type;

export const UnoMachineAppStatus = Schema.Literals(["running", "stopped", "unknown"]);
export type UnoMachineAppStatus = typeof UnoMachineAppStatus.Type;

/** One public forward of an app's port. */
export const UnoMachineAppForward = Schema.Struct({
  forwardId: Schema.Number,
  internalPort: Schema.Number,
  externalPort: Schema.NullOr(Schema.Number),
  protocol: Schema.String,
});
export type UnoMachineAppForward = typeof UnoMachineAppForward.Type;

/** The public forwards that make the app reachable from the internet. */
export const UnoMachineAppPublication = Schema.Struct({
  /** Forward of the main (TCP) port; null when only UDP ports are shown (a VPN). */
  forwardId: Schema.NullOr(Schema.Number),
  externalPort: Schema.NullOr(Schema.Number),
  /** Where it answers from outside; null until the forward is applied or for UDP only. */
  url: Schema.NullOr(Schema.String),
  /** The computer's public name, for "connect to host:port" apps. */
  host: Schema.NullOr(Schema.String),
  /** pending | applied | failed — as the control plane reports it. */
  state: Schema.String,
  /** Every forward "Hide" removes, UDP ones (a VPN tunnel) included. */
  forwards: Schema.Array(UnoMachineAppForward),
});
export type UnoMachineAppPublication = typeof UnoMachineAppPublication.Type;

/**
 * A Home widget an app declares in its manifest (\`"widget": {"path": "/widget"}\`):
 * Home shows the app's page at \`path\` in a small sandboxed frame.
 */
export const UnoMachineAppWidget = Schema.Struct({
  /** A path on the app's own address, starting with \`/\` (never a scheme or \`//host\`). */
  path: Schema.String,
  size: Schema.Literals(["small", "medium", "wide"]),
  title: Schema.NullOr(Schema.String),
});
export type UnoMachineAppWidget = typeof UnoMachineAppWidget.Type;

export const UnoMachineApp = Schema.Struct({
  /** Stable key: `manifest:<id>`, `docker:<name>`, `systemd:<unit>`, `port:<n>`. */
  id: Schema.String,
  source: UnoMachineAppSource,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** Emoji or a couple of letters. */
  icon: Schema.NullOr(Schema.String),
  /** `data:image/…` of a validated icon file next to the manifest. */
  iconImage: Schema.NullOr(Schema.String),
  status: UnoMachineAppStatus,
  /** The TCP port it answers on inside the machine, when known. */
  port: Schema.NullOr(Schema.Number),
  /** UDP ports it publishes too (a VPN tunnel); shown on the internet together with `port`. */
  udpPorts: Schema.Array(Schema.Number),
  /** The port answered an HTTP request — it is something to open in a browser. */
  http: Schema.Boolean,
  /** Listens on 127.0.0.1 only: nothing outside the machine can reach it. */
  loopbackOnly: Schema.Boolean,
  /** One short line: "Docker · weejewel/wg-easy", "Service · notes.service", "node". */
  detail: Schema.NullOr(Schema.String),
  /** An address the app declared itself (manifest `url`). */
  url: Schema.NullOr(Schema.String),
  /** `http://localhost:<port>/` — only useful when the browser runs on this machine. */
  localUrl: Schema.NullOr(Schema.String),
  publication: Schema.NullOr(UnoMachineAppPublication),
  canStart: Schema.Boolean,
  canStop: Schema.Boolean,
  /**
   * "Remove" is offered: a docker container the person started themselves
   * (deletes the container, keeps volumes), or an app registered in
   * `~/.uno/apps` — one an AI or the person made on this computer (stops it,
   * deletes its manifest and withdraws its App SDK token).
   */
  canRemove: Schema.optional(Schema.Boolean),
  /** Docker compose project label (`com.docker.compose.project`), for docker apps. */
  composeProject: Schema.optional(Schema.NullOr(Schema.String)),
  /** The person hid it from the home screen ("Hide"); it still runs. */
  hidden: Schema.optional(Schema.Boolean),
  /**
   * A registered app's code folder (its manifest `cwd`), spelled for a person
   * (`~/projects/notes`). Null when the manifest names none.
   */
  codeDir: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * Why Remove can't also delete `codeDir` (it is home itself, a shared
   * folder, another app's…); null when it can.
   */
  codeDirKeepReason: Schema.optional(Schema.NullOr(Schema.String)),
  /** A Home widget the app declares (registered apps only); null/absent = none. */
  widget: Schema.optional(Schema.NullOr(UnoMachineAppWidget)),
});
export type UnoMachineApp = typeof UnoMachineApp.Type;

export const UnoMachineApps = Schema.Struct({
  apps: Schema.Array(UnoMachineApp),
  /** Where manifests go, spelled for a person (`~/.uno/apps`). */
  manifestDir: Schema.String,
  scannedAt: Schema.String,
  /** Why "Show on the internet" can't work on this machine; null when it can. */
  publishBlockedReason: Schema.NullOr(Schema.String),
  /** Manifests that were skipped, and why — shown quietly, never as an error wall. */
  warnings: Schema.Array(Schema.String),
});
export type UnoMachineApps = typeof UnoMachineApps.Type;

export const UnoMachineAppAction = Schema.Literals([
  "start",
  "stop",
  "publish",
  "unpublish",
  "remove",
  /** Take it off the home screen (it keeps running); `unhide` brings it back. */
  "hide",
  "unhide",
]);
export type UnoMachineAppAction = typeof UnoMachineAppAction.Type;

export const UnoMachineAppActionInput = Schema.Struct({
  appId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  action: UnoMachineAppAction,
  /**
   * `remove` of a registered app: also delete its code folder (`codeDir`).
   * Off by default — the code stays on the computer.
   */
  deleteCode: Schema.optional(Schema.Boolean),
});
export type UnoMachineAppActionInput = typeof UnoMachineAppActionInput.Type;

/**
 * Can this web app be shown inside Uno Work (an iframe in the page at
 * `embedderOrigin`)? The browser can't read a cross-origin frame's headers, so
 * the daemon fetches the app and reads `X-Frame-Options` and CSP
 * `frame-ancestors` for it. `unknown` = the app didn't answer; the frame is
 * tried anyway, with "Open in a new tab" at hand.
 */
export const UnoEmbedCheckInput = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  embedderOrigin: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
});
export type UnoEmbedCheckInput = typeof UnoEmbedCheckInput.Type;

export const UnoEmbedCheck = Schema.Struct({
  verdict: Schema.Literals(["ok", "blocked", "unknown"]),
  /** Short human reason for `blocked` / `unknown`. */
  reason: Schema.NullOr(Schema.String),
});
export type UnoEmbedCheck = typeof UnoEmbedCheck.Type;

/** Live load of the machine the daemon runs on, read from the OS directly. */
export const UnoComputerLocalMetrics = Schema.Struct({
  hostname: Schema.String,
  /** linux | darwin | win32 */
  platform: Schema.String,
  cpuPct: Schema.NullOr(Schema.Number),
  cpuCount: Schema.Number,
  memUsedMb: Schema.Number,
  memTotalMb: Schema.Number,
  diskUsedGb: Schema.NullOr(Schema.Number),
  diskTotalGb: Schema.NullOr(Schema.Number),
  uptimeS: Schema.Number,
});
export type UnoComputerLocalMetrics = typeof UnoComputerLocalMetrics.Type;

/* ------------------------------------------------------------------ *
 * Add memory / cores (resize)
 *
 * The control plane decides every limit (plan's biggest computer, account
 * peak, disk quota, the account's own budget guard); the daemon only reads
 * them to offer sizes that can work and to explain a refusal.
 * ------------------------------------------------------------------ */

export const UnoComputerShape = Schema.Struct({
  ramMb: Schema.Number,
  vcpu: Schema.Number,
  diskGb: Schema.Number,
});
export type UnoComputerShape = typeof UnoComputerShape.Type;

export const UnoComputerResizeOptions = Schema.Struct({
  availability: UnoComputerAvailability,
  message: Schema.NullOr(Schema.String),
  current: Schema.NullOr(UnoComputerShape),
  /** The largest this computer can be on the current plan right now. */
  max: Schema.NullOr(UnoComputerShape),
  /** The plan's own ceiling for one computer (what "up to X" says). */
  planMax: Schema.NullOr(UnoComputerShape),
  planName: Schema.NullOr(Schema.String),
  /** RAM goes in steps of this many MB. */
  ramStepMb: Schema.Number,
  /** Where to change the plan (console billing). */
  upgradeUrl: Schema.String,
  /** False when this machine's key can't resize (older token): the UI says why. */
  canResize: Schema.Boolean,
});
export type UnoComputerResizeOptions = typeof UnoComputerResizeOptions.Type;

export const UnoComputerResizeInput = Schema.Struct({
  boxId: Schema.optional(Schema.Number),
  ramMb: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  vcpu: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  diskGb: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
});
export type UnoComputerResizeInput = typeof UnoComputerResizeInput.Type;

/**
 * - `resized`    — done; `shape` is the new size;
 * - `plan_limit` — the plan doesn't allow it; `limit` is what it allows;
 * - `guard`      — the account's own spending guard said no;
 * - `busy`       — the computer is starting / sleeping; try again.
 */
export const UnoComputerResizeResult = Schema.Struct({
  outcome: Schema.Literals(["resized", "plan_limit", "guard", "busy"]),
  message: Schema.String,
  shape: Schema.NullOr(UnoComputerShape),
  limit: Schema.NullOr(UnoComputerShape),
  planName: Schema.NullOr(Schema.String),
  upgradeUrl: Schema.String,
});
export type UnoComputerResizeResult = typeof UnoComputerResizeResult.Type;

/* ------------------------------------------------------------------ *
 * Boost ×2 — start / end
 * ------------------------------------------------------------------ */

export const UnoComputerBoostInput = Schema.Struct({
  boxId: Schema.optional(Schema.Number),
  hours: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(24)),
  ),
});
export type UnoComputerBoostInput = typeof UnoComputerBoostInput.Type;

/**
 * - `started` — the computer is restarting into the boost (or already boosted);
 * - `ended`   — it is restarting back to normal (or was not boosted any more);
 * - `refused` — Uno said no; `message` says why in plain words.
 * `boost` is the fresh boost state when Uno sent it.
 */
export const UnoComputerBoostResult = Schema.Struct({
  outcome: Schema.Literals(["started", "ended", "refused"]),
  message: Schema.NullOr(Schema.String),
  boost: Schema.NullOr(UnoComputerBoost),
});
export type UnoComputerBoostResult = typeof UnoComputerBoostResult.Type;
