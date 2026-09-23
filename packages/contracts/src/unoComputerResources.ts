/**
 * "What is using my computer" — the drill-down behind the processor, memory,
 * disk and network tiles of "This computer".
 *
 * Read by the daemon from the OS it runs on (/proc on Linux, ps/vm_stat on a
 * Mac), grouped the way a person thinks about a computer — an app, a
 * container, a service, a chat's agent, the system — rather than as a flat
 * process table. Nothing here is read from the control plane.
 *
 * Every action names something the daemon found itself (a group id from the
 * last snapshot, a pid + start token, a fixed clean-up target); the daemon
 * looks it up again before touching anything and never runs a command the
 * browser sent.
 */
import { Schema } from "effect";

/* ------------------------------------------------------------------ *
 * Live usage
 * ------------------------------------------------------------------ */

/** One reading of the whole machine, a few seconds apart, kept by the daemon. */
export const UnoResourcesPoint = Schema.Struct({
  t: Schema.String,
  cpuPct: Schema.NullOr(Schema.Number),
  memUsedMb: Schema.NullOr(Schema.Number),
  /** Bytes per second in / out over the network; null where it isn't read (a Mac). */
  netRxBps: Schema.NullOr(Schema.Number),
  netTxBps: Schema.NullOr(Schema.Number),
});
export type UnoResourcesPoint = typeof UnoResourcesPoint.Type;

export const UnoResourcesMemory = Schema.Struct({
  totalMb: Schema.Number,
  /** Held by programs; what has to shrink for memory to run out less. */
  usedMb: Schema.Number,
  /** Files kept in memory to be fast; given back the moment a program needs it. */
  cacheMb: Schema.Number,
  /** Not used for anything right now. */
  freeMb: Schema.Number,
  /** What programs can still get: free + the cache that can be given back. */
  availableMb: Schema.Number,
  swapTotalMb: Schema.Number,
  swapUsedMb: Schema.Number,
});
export type UnoResourcesMemory = typeof UnoResourcesMemory.Type;

export const UnoResourcesDiskVolume = Schema.Struct({
  /** Where it is mounted, spelled for a person ("Home folder", "/"). */
  label: Schema.String,
  mount: Schema.String,
  totalGb: Schema.Number,
  usedGb: Schema.Number,
  freeGb: Schema.Number,
});
export type UnoResourcesDiskVolume = typeof UnoResourcesDiskVolume.Type;

/**
 * - `app`      — registered in `~/.uno/apps` (a person or an agent made it);
 * - `docker`   — a container;
 * - `service`  — a systemd service someone added (or well-known server software);
 * - `chat`     — the agent of an Uno Work chat and everything it started;
 * - `terminal` — a terminal opened in Uno Work;
 * - `unowork`  — Uno Work itself (the daemon, the desktop app);
 * - `program`  — another program of this user (grouped by name / Mac app);
 * - `system`   — what the operating system runs for itself (root, kernel).
 */
export const UnoResourceGroupKind = Schema.Literals([
  "app",
  "docker",
  "service",
  "chat",
  "terminal",
  "unowork",
  "program",
  "system",
]);
export type UnoResourceGroupKind = typeof UnoResourceGroupKind.Type;

export const UnoResourceProcess = Schema.Struct({
  pid: Schema.Number,
  /** Identifies this exact process (pid + start time): a reused pid won't match. */
  startToken: Schema.String,
  name: Schema.String,
  /** Command line, shortened, secrets masked; null for other users' processes. */
  command: Schema.NullOr(Schema.String),
  /** Share of the whole computer's processor (0–100). */
  cpuPct: Schema.Number,
  memMb: Schema.Number,
  /** Runs as the same user as Uno Work (only these can be quit from here). */
  own: Schema.Boolean,
  /** Can be quit from here; `protectedReason` says why not. */
  canQuit: Schema.Boolean,
  protectedReason: Schema.NullOr(Schema.String),
});
export type UnoResourceProcess = typeof UnoResourceProcess.Type;

export const UnoResourceGroupAction = Schema.Literals(["start", "stop", "restart"]);
export type UnoResourceGroupAction = typeof UnoResourceGroupAction.Type;

export const UnoResourceGroup = Schema.Struct({
  /** Stable key: `app:<id>`, `docker:<name>`, `service:<unit>`, `chat:<pid>`, … */
  id: Schema.String,
  kind: UnoResourceGroupKind,
  name: Schema.String,
  /** One short line under the name: "Docker · n8nio/n8n", "Service · notes.service". */
  detail: Schema.NullOr(Schema.String),
  icon: Schema.NullOr(Schema.String),
  cpuPct: Schema.Number,
  memMb: Schema.Number,
  /** Heaviest first; capped, see `processCount`. */
  processes: Schema.Array(UnoResourceProcess),
  processCount: Schema.Number,
  /** Folder the chat's agent works in — the web app matches it to a chat. */
  cwd: Schema.NullOr(Schema.String),
  /** The program on the desktop this is (`UnoMachineApp.id`), when there is one. */
  machineAppId: Schema.NullOr(Schema.String),
  /** What the buttons can do to the whole group. */
  actions: Schema.Array(UnoResourceGroupAction),
  /** Why the group can't be stopped from here, when it can't. */
  actionsBlockedReason: Schema.NullOr(Schema.String),
});
export type UnoResourceGroup = typeof UnoResourceGroup.Type;

/**
 * - `ok`          — containers are listed with their names;
 * - `no-access`   — docker runs, but this user may not ask it (not in the docker group);
 * - `not-running` — docker isn't installed or isn't running.
 */
export const UnoResourcesDockerAccess = Schema.Literals(["ok", "no-access", "not-running"]);
export type UnoResourcesDockerAccess = typeof UnoResourcesDockerAccess.Type;

export const UnoComputerResources = Schema.Struct({
  /** linux | darwin | win32 */
  platform: Schema.String,
  sampledAt: Schema.String,
  cpuCount: Schema.Number,
  cpuPct: Schema.NullOr(Schema.Number),
  /** 1-minute load average, when the OS has one. */
  load1: Schema.NullOr(Schema.Number),
  memory: UnoResourcesMemory,
  volumes: Schema.Array(UnoResourcesDiskVolume),
  netRxBps: Schema.NullOr(Schema.Number),
  netTxBps: Schema.NullOr(Schema.Number),
  /** The last minutes, oldest first, one point every few seconds. */
  history: Schema.Array(UnoResourcesPoint),
  historyStepS: Schema.Number,
  groups: Schema.Array(UnoResourceGroup),
  processCount: Schema.Number,
  docker: UnoResourcesDockerAccess,
  /** Honest note when the list is partial (a Mac, no docker access). */
  notes: Schema.Array(Schema.String),
});
export type UnoComputerResources = typeof UnoComputerResources.Type;

/* ------------------------------------------------------------------ *
 * Disk
 * ------------------------------------------------------------------ */

export const UnoDiskEntry = Schema.Struct({
  name: Schema.String,
  /** Absolute path, inside the home folder. */
  path: Schema.String,
  bytes: Schema.Number,
  isDir: Schema.Boolean,
});
export type UnoDiskEntry = typeof UnoDiskEntry.Type;

/**
 * Something that can be emptied safely (it fills itself up again when
 * needed), or that is shown so the person knows where the space went.
 */
export const UnoDiskCleanable = Schema.Struct({
  /** Fixed ids only: the daemon knows what each one means. */
  id: Schema.String,
  label: Schema.String,
  description: Schema.String,
  /** What cleaning frees, as measured now; null while unknown. */
  bytes: Schema.NullOr(Schema.Number),
  canClean: Schema.Boolean,
  /** Why it can't be cleaned from here (needs admin, nothing to clean). */
  blockedReason: Schema.NullOr(Schema.String),
});
export type UnoDiskCleanable = typeof UnoDiskCleanable.Type;

export const UnoDiskDockerUsage = Schema.Struct({
  access: UnoResourcesDockerAccess,
  imagesBytes: Schema.NullOr(Schema.Number),
  containersBytes: Schema.NullOr(Schema.Number),
  volumesBytes: Schema.NullOr(Schema.Number),
  buildCacheBytes: Schema.NullOr(Schema.Number),
  /** What `prune` of unused images and build cache would give back. */
  reclaimableBytes: Schema.NullOr(Schema.Number),
});
export type UnoDiskDockerUsage = typeof UnoDiskDockerUsage.Type;

export const UnoDiskUsageInput = Schema.Struct({
  /** Folder to look into (absolute, inside home); absent = the home folder. */
  path: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  /** Look again even if a recent answer is cached. */
  rescan: Schema.optional(Schema.Boolean),
});
export type UnoDiskUsageInput = typeof UnoDiskUsageInput.Type;

export const UnoDiskUsage = Schema.Struct({
  home: Schema.String,
  /** The folder these entries are inside. */
  path: Schema.String,
  /** Sizes are being measured; `entries` is the last answer (maybe empty). */
  scanning: Schema.Boolean,
  scannedAt: Schema.NullOr(Schema.String),
  /** Everything inside `path`. */
  totalBytes: Schema.NullOr(Schema.Number),
  /** Biggest first. */
  entries: Schema.Array(UnoDiskEntry),
  /** Folders that couldn't be read (another user's). */
  unreadable: Schema.Number,
  volumes: Schema.Array(UnoResourcesDiskVolume),
  /** Only in the answer for the home folder. */
  cleanables: Schema.Array(UnoDiskCleanable),
  docker: UnoDiskDockerUsage,
  /** Space used outside the home folder (the system, programs, docker). */
  outsideHomeBytes: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
});
export type UnoDiskUsage = typeof UnoDiskUsage.Type;

export const UnoDiskCleanInput = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type UnoDiskCleanInput = typeof UnoDiskCleanInput.Type;

export const UnoDiskCleanResult = Schema.Struct({
  freedBytes: Schema.Number,
  message: Schema.String,
});
export type UnoDiskCleanResult = typeof UnoDiskCleanResult.Type;

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

export const UnoResourceActionInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("process"),
    pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(1)),
    startToken: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    /** `quit` asks politely (SIGTERM); `force` doesn't wait (SIGKILL). */
    signal: Schema.Literals(["quit", "force"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("group"),
    groupId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
    action: UnoResourceGroupAction,
  }),
]);
export type UnoResourceActionInput = typeof UnoResourceActionInput.Type;

export const UnoResourceActionResult = Schema.Struct({
  /** False when a quit process is still there after a few seconds. */
  done: Schema.Boolean,
  message: Schema.String,
});
export type UnoResourceActionResult = typeof UnoResourceActionResult.Type;
