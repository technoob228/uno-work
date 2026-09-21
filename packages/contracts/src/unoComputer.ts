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

export const UnoComputerAppSetting = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  secret: Schema.Boolean,
  defaultValue: Schema.NullOr(Schema.String),
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
});
export type UnoComputerAppTemplate = typeof UnoComputerAppTemplate.Type;

export const UnoComputerInstalledAppState = Schema.Literals([
  "running",
  "installing",
  "failed",
  "unknown",
]);
export type UnoComputerInstalledAppState = typeof UnoComputerInstalledAppState.Type;

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
});
export type UnoComputerInstallAppInput = typeof UnoComputerInstallAppInput.Type;

export const UnoComputerInstallAppResult = Schema.Struct({
  deploymentId: Schema.Number,
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
