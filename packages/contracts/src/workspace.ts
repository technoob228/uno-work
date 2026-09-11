/**
 * Workspace — the set of machines one person (or one Uno account) works across.
 *
 * The sidebar already unions several environments into one list; this module
 * gives that union a durable identity, a registry of the machines in it, and
 * the rules under which one machine is allowed to touch another.
 *
 * Three things are deliberately *not* modelled here:
 *
 * - **Consensus.** Exactly one machine holds the registry (`registryEnvironmentId`).
 *   Everyone else reads it over the same RPC the UI uses. A workspace whose
 *   registry is unreachable degrades loudly rather than forking into two
 *   divergent truths.
 * - **Transitive trust.** A grant names one source, one target and one
 *   repository. Nothing composes grants, so no chain of individually
 *   reasonable permissions adds up to an unintended one.
 * - **Identity of *people*.** A machine is the principal. Uno account linkage
 *   (below) is how two machines agree they belong to the same workspace, not a
 *   per-user permission system.
 */
import { Schema } from "effect";

import { EnvironmentId } from "./baseSchemas.ts";

/**
 * How a machine got into the workspace.
 *
 * `uno_box` matters beyond bookkeeping: a box can be asleep, and waking it is
 * an action the app can take on the user's behalf, which is not true of an
 * arbitrary SSH host.
 */
export const WorkspaceMachineKind = Schema.Literals(["local", "ssh", "uno_box"]);
export type WorkspaceMachineKind = typeof WorkspaceMachineKind.Type;

/**
 * What a machine is allowed to learn about the workspace.
 *
 * `full` sees every project; `repositories` sees only the canonical repository
 * keys listed on the row. A box handed to a contractor gets the short list.
 */
export const WorkspaceMachineScope = Schema.Literals(["full", "repositories"]);
export type WorkspaceMachineScope = typeof WorkspaceMachineScope.Type;

export const WorkspaceMachine = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /**
   * Two characters, per the design review: the chip stays square and a stack of
   * three does not crowd a chat row.
   */
  monogram: Schema.String,
  /**
   * Index into the machine hue list. Persisted rather than derived — see
   * `sidebarMachineIdentity` in settings.ts for why recomputing repaints chips
   * the user has already learned.
   */
  colorSlot: Schema.Number,
  kind: WorkspaceMachineKind,
  /** Set when `kind` is `uno_box`; the box id in the Uno control plane. */
  unoBoxId: Schema.NullOr(Schema.Number),
  scope: WorkspaceMachineScope,
  /** Canonical repository keys visible to this machine when scope is `repositories`. */
  repositories: Schema.Array(Schema.String),
  addedAt: Schema.String,
  lastSeenAt: Schema.NullOr(Schema.String),
});
export type WorkspaceMachine = typeof WorkspaceMachine.Type;

/**
 * Default answer to "may another machine write here".
 *
 * `request` is the shipped default: a peer may ask, and a human approves each
 * time. `allow` is the standing version of that approval and lives only in an
 * explicit grant — the approval dialog itself never offers "always", because
 * the moment someone is deciding a single request is the worst moment to widen
 * a permission permanently.
 */
export const CrossEnvironmentWriteMode = Schema.Literals(["deny", "request", "allow"]);
export type CrossEnvironmentWriteMode = typeof CrossEnvironmentWriteMode.Type;

export const WorkspaceCapability = Schema.Literals([
  "view_status",
  "view_threads",
  "read_transcript",
  "create_threads",
  "write",
]);
export type WorkspaceCapability = typeof WorkspaceCapability.Type;

/**
 * How a peer reaches this machine. Shown in the UI on purpose: a laptop behind
 * NAT can only be reached through the registry, and hiding that turns a
 * structural fact into "it is broken".
 */
export const WorkspaceTransport = Schema.Literals(["direct", "registry"]);
export type WorkspaceTransport = typeof WorkspaceTransport.Type;

/** `*` means "any" in `fromEnvironmentId`, `toEnvironmentId` and `repositoryKey`. */
export const WORKSPACE_GRANT_WILDCARD = "*";

export const WorkspaceGrant = Schema.Struct({
  grantId: Schema.String,
  fromEnvironmentId: Schema.String,
  toEnvironmentId: Schema.String,
  repositoryKey: Schema.String,
  capabilities: Schema.Array(WorkspaceCapability),
  transport: WorkspaceTransport,
  /**
   * `deny` wins over every other row regardless of specificity, so a single
   * "never touch this" cannot be re-enabled by adding a narrower allow.
   */
  mode: CrossEnvironmentWriteMode,
  /** Whether the capability additionally requires holding the claim on the target. */
  requiresClaim: Schema.Boolean,
  createdAt: Schema.String,
});
export type WorkspaceGrant = typeof WorkspaceGrant.Type;

export const WorkspacePolicy = Schema.Struct({
  crossEnvironmentWrite: CrossEnvironmentWriteMode,
  /** Guard against "HK pushes CM, CM pushes HK" running all night. */
  maxForwardHops: Schema.Number,
  dropOwnEcho: Schema.Boolean,
  crossEnvironmentTurnsPerHour: Schema.Number,
  maxConcurrentCrossEnvironment: Schema.Number,
  /** Master switch; off means every peer command is refused before policy runs. */
  acceptPeerCommands: Schema.Boolean,
});
export type WorkspacePolicy = typeof WorkspacePolicy.Type;

export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = {
  crossEnvironmentWrite: "request",
  maxForwardHops: 3,
  dropOwnEcho: true,
  crossEnvironmentTurnsPerHour: 20,
  maxConcurrentCrossEnvironment: 4,
  acceptPeerCommands: true,
};

/**
 * A claim is an advisory lock on a unit of work, keyed by
 * `<repositoryKey>|<slug>` so two machines can hold different parts of the same
 * repository. Advisory because the holder is a person's agent, not a
 * transaction: we surface who holds what and let a human break the tie.
 */
export const WorkspaceClaim = Schema.Struct({
  claimId: Schema.String,
  claimKey: Schema.String,
  holderEnvironmentId: EnvironmentId,
  reason: Schema.String,
  acquiredAt: Schema.String,
  expiresAt: Schema.String,
});
export type WorkspaceClaim = typeof WorkspaceClaim.Type;

export const WorkspaceRequestKind = Schema.Literals([
  "post_message",
  "create_thread",
  "read_transcript",
]);
export type WorkspaceRequestKind = typeof WorkspaceRequestKind.Type;

export const WorkspaceRequestStatus = Schema.Literals([
  "pending",
  "approved",
  "rejected",
  "expired",
]);
export type WorkspaceRequestStatus = typeof WorkspaceRequestStatus.Type;

export const WorkspaceRequest = Schema.Struct({
  requestId: Schema.String,
  kind: WorkspaceRequestKind,
  fromEnvironmentId: EnvironmentId,
  toEnvironmentId: EnvironmentId,
  repositoryKey: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  reason: Schema.String,
  /**
   * What would actually be delivered, already defanged. Shown behind "show me
   * what arrives" so approving is not a blind act.
   */
  payloadPreview: Schema.String,
  status: WorkspaceRequestStatus,
  /** Single-use: a decision consumes it, so an approval cannot be replayed. */
  nonce: Schema.String,
  hops: Schema.Number,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
});
export type WorkspaceRequest = typeof WorkspaceRequest.Type;

export const WorkspaceUsage = Schema.Struct({
  crossEnvironmentTurnsLastHour: Schema.Number,
  concurrentCrossEnvironment: Schema.Number,
});
export type WorkspaceUsage = typeof WorkspaceUsage.Type;

export const WorkspaceIdentity = Schema.Struct({
  workspaceId: Schema.String,
  name: Schema.String,
  /**
   * Monotonic revision of the registry contents. Bumped on every mutation so a
   * client can tell "I am looking at stale data" from "nothing has changed".
   */
  epoch: Schema.Number,
  registryEnvironmentId: Schema.NullOr(EnvironmentId),
  /** Uno account id, when the daemon has an API key configured. */
  unoAccountId: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type WorkspaceIdentity = typeof WorkspaceIdentity.Type;

export const WorkspaceState = Schema.Struct({
  identity: WorkspaceIdentity,
  machines: Schema.Array(WorkspaceMachine),
  claims: Schema.Array(WorkspaceClaim),
  grants: Schema.Array(WorkspaceGrant),
  policy: WorkspacePolicy,
  pendingRequests: Schema.Array(WorkspaceRequest),
  usage: WorkspaceUsage,
});
export type WorkspaceState = typeof WorkspaceState.Type;

/* ------------------------------------------------------------------ *
 * Instruction layers (design screen 7)
 * ------------------------------------------------------------------ */

/**
 * Agent instructions come from three places, innermost last:
 *
 * 1. `repository` — `AGENTS.md` in git, read-only here.
 * 2. `workspace` — one text for every machine, stored in the registry.
 * 3. `machine` — this machine only; **overrides** the workspace text.
 *
 * The merged result is written to `.t3code/UNO_WORKSPACE.md` (generated,
 * gitignored) and `AGENTS.md` gets three pointer lines between markers. Text
 * outside the markers is never touched, and a user who deletes the markers does
 * not get them back.
 */
export const WorkspaceInstructionLayerKind = Schema.Literals([
  "repository",
  "workspace",
  "machine",
]);
export type WorkspaceInstructionLayerKind = typeof WorkspaceInstructionLayerKind.Type;

export const WorkspaceInstructionLayer = Schema.Struct({
  kind: WorkspaceInstructionLayerKind,
  /** Empty for a layer that exists but has no text yet. */
  text: Schema.String,
  editable: Schema.Boolean,
  /** Where the text comes from, for the subtitle in the UI. */
  source: Schema.String,
});
export type WorkspaceInstructionLayer = typeof WorkspaceInstructionLayer.Type;

export const WorkspaceInstructions = Schema.Struct({
  environmentId: EnvironmentId,
  layers: Schema.Array(WorkspaceInstructionLayer),
  merged: Schema.String,
});
export type WorkspaceInstructions = typeof WorkspaceInstructions.Type;

/* ------------------------------------------------------------------ *
 * Uno cloud (account + boxes)
 * ------------------------------------------------------------------ */

/**
 * Control plane for the account and its boxes.
 *
 * Deliberately not `UNO_GATEWAY_BASE_URL` (api.getuno.xyz): that host is the
 * LLM gateway and a legacy mirror of the account API, and it answers 404 for
 * every `/api/v1/*` route — boxes included. Verified against a live account:
 * `/auth/me` works on both, `/api/v1/boxes` only here.
 */
export const UNO_CONTROL_PLANE_BASE_URL = "https://console.uno4.dev";

export const UnoAccount = Schema.Struct({
  userId: Schema.Number,
  username: Schema.String,
  email: Schema.NullOr(Schema.String),
  balance: Schema.Number,
  llmBalance: Schema.Number,
  role: Schema.String,
});
export type UnoAccount = typeof UnoAccount.Type;

export const UnoBox = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  status: Schema.String,
  os: Schema.String,
  ramMb: Schema.Number,
  vcpu: Schema.Number,
  diskGb: Schema.Number,
  /** Ready-to-run command, e.g. `ssh -p 30000 uno@45.182.189.80`. */
  ssh: Schema.NullOr(Schema.String),
  publicIp: Schema.NullOr(Schema.String),
  internalIp: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.String),
  sleepDeadlineAt: Schema.NullOr(Schema.String),
});
export type UnoBox = typeof UnoBox.Type;

/**
 * Parsed form of `UnoBox.ssh`. Null when the control plane did not return a
 * command we recognise — better to show "no SSH endpoint yet" than to guess a
 * port and fail during a connection attempt.
 */
export const UnoBoxSshTarget = Schema.Struct({
  host: Schema.String,
  port: Schema.Number,
  user: Schema.String,
});
export type UnoBoxSshTarget = typeof UnoBoxSshTarget.Type;

export const UnoCloudState = Schema.Struct({
  /** False when no API key is configured — not an error, just not linked yet. */
  connected: Schema.Boolean,
  account: Schema.NullOr(UnoAccount),
  boxes: Schema.Array(UnoBox),
  fetchedAt: Schema.String,
  /** Set when the key exists but the control plane refused or was unreachable. */
  error: Schema.NullOr(Schema.String),
});
export type UnoCloudState = typeof UnoCloudState.Type;

/**
 * A one-time pairing handle for a specific box's Uno Work daemon, minted by the
 * control plane (`POST /api/v1/boxes/{id}/work/session`). Feeding `url` to
 * `addSavedEnvironment` connects the box as a remote environment — no manual
 * host/token entry. The link is single-use and short-lived.
 */
export const UnoBoxConnection = Schema.Struct({
  boxId: Schema.Number,
  /** Full pairing URL, e.g. `https://<host>/pair#token=...`. */
  url: Schema.String,
  hostname: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
});
export type UnoBoxConnection = typeof UnoBoxConnection.Type;

/* ------------------------------------------------------------------ *
 * Uno cloud: creating a box ("Move this project to a box")
 * ------------------------------------------------------------------ */

/**
 * Golden image with the Uno Work daemon and harnesses preinstalled (port 80
 * serves the daemon). Launching from it is what makes a fresh box pairable
 * without any manual install step. Overridable per account via
 * `settings.uno.goldenImageId`.
 */
export const UNO_WORK_GOLDEN_IMAGE_ID = 122;

/** Sensible defaults for a first work box: enough for a harness plus a repository clone. */
export const UNO_BOX_DEFAULT_RAM_MB = 2048;
export const UNO_BOX_DEFAULT_VCPU = 1;
export const UNO_BOX_DEFAULT_DISK_GB = 10;

/**
 * Lifecycle of a background "create box" job in the daemon:
 *
 * creating → starting → waiting_daemon → ready
 *                                      ↘ failed (any step)
 *
 * `creating` = the launch call is in flight; `starting` = the box exists but
 * is not `running` yet; `waiting_daemon` = running, but the daemon inside has
 * not answered a pairing request yet.
 */
export const UnoBoxCreateJobState = Schema.Literals([
  "creating",
  "starting",
  "waiting_daemon",
  "ready",
  "failed",
]);
export type UnoBoxCreateJobState = typeof UnoBoxCreateJobState.Type;

export const UnoBoxCreateJobStatus = Schema.Struct({
  jobId: Schema.String,
  state: UnoBoxCreateJobState,
  /** Known as soon as the control plane has answered the launch call. */
  boxId: Schema.optional(Schema.NullOr(Schema.Number)),
  box: Schema.optional(Schema.NullOr(UnoBox)),
  /** Present only in `ready`. */
  connection: Schema.optional(Schema.NullOr(UnoBoxConnection)),
  /** Human-readable detail — the failure reason, or a progress hint. */
  message: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * Set when the golden image was unavailable and a plain box was created
   * instead: the box exists (and is billed) but has no daemon, so the flow
   * stops in `failed` rather than pretending it can be paired.
   */
  daemonInstallRequired: Schema.optional(Schema.Boolean),
});
export type UnoBoxCreateJobStatus = typeof UnoBoxCreateJobStatus.Type;

export function parseUnoBoxSshTarget(command: string | null): UnoBoxSshTarget | null {
  if (!command) return null;
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;
  const portMatch = /-p\s+(\d+)/.exec(trimmed);
  const destinationMatch = /([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)/.exec(trimmed);
  if (!destinationMatch) return null;
  const user = destinationMatch[1];
  const host = destinationMatch[2];
  if (!user || !host) return null;
  const port = portMatch?.[1] ? Number.parseInt(portMatch[1], 10) : 22;
  if (!Number.isFinite(port) || port <= 0) return null;
  return { host, port, user };
}

/**
 * Two letters for the chip. Digits are kept because boxes are commonly named
 * `box-12`, where the number is the only part that distinguishes them.
 */
export function deriveMachineMonogram(label: string): string {
  const cleaned = label.trim();
  if (cleaned.length === 0) return "··";
  const words = cleaned.split(/[\s._-]+/u).filter((word) => word.length > 0);
  if (words.length >= 2) {
    const first = words[0]?.[0] ?? "";
    const second = words[1]?.[0] ?? "";
    const combined = `${first}${second}`.toUpperCase();
    if (combined.length === 2) return combined;
  }
  const alphanumeric = cleaned.replace(/[^A-Za-z0-9]/gu, "");
  if (alphanumeric.length >= 2) return alphanumeric.slice(0, 2).toUpperCase();
  if (alphanumeric.length === 1) return `${alphanumeric.toUpperCase()}·`;
  return "··";
}
