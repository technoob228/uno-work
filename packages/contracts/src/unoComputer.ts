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
});
export type UnoComputerAppTemplate = typeof UnoComputerAppTemplate.Type;

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

export const UnoComputerInstalledApp = Schema.Struct({
  /** Stable key for the list: `service:<id>` or `port:<n>`. */
  key: Schema.String,
  name: Schema.String,
  /** Catalog template this came from, when known. */
  templateId: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(Schema.String),
  state: UnoComputerInstalledAppState,
  url: Schema.NullOr(Schema.String),
  /** Last deployment, so a running install can be re-attached after a reload. */
  deploymentId: Schema.NullOr(Schema.Number),
  /** What to know after install. */
  notes: Schema.optional(Schema.NullOr(Schema.String)),
  /** How to sign in: login, generated password, invite link. Owner-only. */
  credentials: Schema.optional(Schema.Array(UnoComputerAppCredential)),
});
export type UnoComputerInstalledApp = typeof UnoComputerInstalledApp.Type;

export const UnoComputerApps = Schema.Struct({
  catalog: Schema.Struct({
    availability: UnoComputerAvailability,
    message: Schema.NullOr(Schema.String),
    templates: Schema.Array(UnoComputerAppTemplate),
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

export const UnoMachineAppAction = Schema.Literals(["start", "stop", "publish", "unpublish"]);
export type UnoMachineAppAction = typeof UnoMachineAppAction.Type;

export const UnoMachineAppActionInput = Schema.Struct({
  appId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  action: UnoMachineAppAction,
});
export type UnoMachineAppActionInput = typeof UnoMachineAppActionInput.Type;

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
