/**
 * UnoBoxProvision — the background job behind `uno.cloud.createBox`.
 *
 * Creating a box is billable, so the job is deliberately linear and
 * retry-free where money is involved: exactly one launch call per job. The
 * retries that do exist (polling box status, minting the pairing link) are
 * read-only against the control plane and bounded by wall-clock caps.
 *
 * Everything the job touches — HTTP client, clock, sleep, status sink — is
 * injected so the state machine can be tested end to end without a network.
 *
 *   creating → starting → waiting_daemon → ready
 *                                        ↘ failed
 *
 * `ready` is only announced once the box's *public* address answers as an Uno
 * Work daemon (`/.well-known/t3/environment`), not merely once the control
 * plane minted a pairing link: the edge publishes the hostname a little after
 * the daemon inside is up, and a browser sent to it too early hangs on a
 * request that never answers. If the address stays silent past its budget the
 * job still ends in `ready` (the box exists and is billed) with
 * `addressReady: false`, so the client keeps retrying instead of reporting a
 * failure for a machine that is merely slow.
 */
import {
  UNO_BOX_DEFAULT_DISK_GB,
  UNO_BOX_DEFAULT_RAM_MB,
  UNO_BOX_DEFAULT_VCPU,
  UNO_WORK_GOLDEN_IMAGE_ID,
  type UnoBox,
  type UnoBoxConnection,
  type UnoBoxCreateJobStatus,
} from "@t3tools/contracts";

import {
  controlPlaneErrorStatus,
  parseUnoBox,
  parseUnoBoxConnection,
  parseUnoWorkImage,
} from "./unoCloud.ts";

export interface UnoBoxLaunchBody {
  readonly name: string;
  readonly ram_mb: number;
  readonly vcpu: number;
  readonly disk_gb: number;
}

export interface UnoBoxPlainCreateBody extends UnoBoxLaunchBody {
  readonly template: string;
  readonly network_profile: string;
}

/**
 * The slice of the control plane the job needs. Every method resolves with
 * the raw JSON payload and rejects with an `Error` whose message is
 * user-presentable (see `fetchControlPlaneJson`).
 */
export interface UnoBoxProvisionClient {
  /** `GET /api/v1/work/image` — the control plane's current Uno Work image. */
  readonly getWorkImage: () => Promise<unknown>;
  readonly launchImage: (imageId: number, body: UnoBoxLaunchBody) => Promise<unknown>;
  readonly createPlainBox: (body: UnoBoxPlainCreateBody) => Promise<unknown>;
  readonly getBox: (boxId: number) => Promise<unknown>;
  /** `GET /api/v1/boxes/{id}/ports` */
  readonly listPorts: (boxId: number) => Promise<unknown>;
  /** `POST /api/v1/boxes/{id}/ports` — the control plane allows duplicates, so list first. */
  readonly openPort: (boxId: number, port: number) => Promise<unknown>;
  readonly createWorkSession: (boxId: number) => Promise<unknown>;
  /**
   * One read of `<baseUrl>/.well-known/t3/environment`, with its own short
   * timeout. Resolves true only when the address answers as an Uno Work
   * daemon; never rejects.
   */
  readonly probeDaemonAddress: (baseUrl: string) => Promise<boolean>;
}

export interface UnoBoxProvisionTiming {
  /** How often to re-read the box while it is not `running` yet. */
  readonly statusPollIntervalMs: number;
  /** Give up waiting for `running` after this long. */
  readonly statusPollTimeoutMs: number;
  /** How often to retry minting the pairing link while the daemon boots. */
  readonly pairingRetryIntervalMs: number;
  /** Give up waiting for the daemon after this long. */
  readonly pairingTimeoutMs: number;
  /** How often to re-check the box's public address once the link exists. */
  readonly addressProbeIntervalMs: number;
  /** Total time the public address may take to answer before handing over anyway. */
  readonly addressReadyBudgetMs: number;
  /**
   * The pairing link is short-lived (the control plane mints it for ~2 min).
   * When waiting for the address took longer than this, mint a fresh one so the
   * client does not receive a link that is about to expire.
   */
  readonly pairingRefreshAfterMs: number;
}

export const DEFAULT_UNO_BOX_PROVISION_TIMING: UnoBoxProvisionTiming = {
  statusPollIntervalMs: 5_000,
  statusPollTimeoutMs: 180_000,
  pairingRetryIntervalMs: 5_000,
  pairingTimeoutMs: 120_000,
  addressProbeIntervalMs: 3_000,
  addressReadyBudgetMs: 90_000,
  pairingRefreshAfterMs: 45_000,
};

export interface UnoBoxProvisionDeps {
  readonly client: UnoBoxProvisionClient;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** Called on every transition with the full status; the last call is terminal. */
  readonly onStatus: (status: UnoBoxCreateJobStatus) => void;
  readonly timing?: Partial<UnoBoxProvisionTiming>;
}

export interface UnoBoxProvisionInput {
  readonly jobId: string;
  readonly name: string;
  readonly ramMb?: number | undefined;
  readonly vcpu?: number | undefined;
  readonly diskGb?: number | undefined;
  /**
   * Image to launch from (`settings.uno.goldenImageId`). When unset, the
   * control plane's current Uno Work image is used, falling back to the id
   * built into this release.
   */
  readonly goldenImageId?: number | null | undefined;
}

/** Plain-box fallback: what the console would create from its own "New box" form. */
const PLAIN_BOX_TEMPLATE = "ubuntu-24.04";
const PLAIN_BOX_NETWORK_PROFILE = "nat";

/** The daemon listens here; the edge publishes `https://<box>.app.uno4.dev` only for an open port. */
const UNO_WORK_DAEMON_PORT = 80;

function hasInboundPort(raw: unknown, port: number): boolean {
  const list = (raw as { ports?: unknown } | null)?.ports;
  return (
    Array.isArray(list) &&
    list.some((entry) => (entry as { internal_port?: unknown } | null)?.internal_port === port)
  );
}

const BOX_RUNNING_STATUSES: ReadonlySet<string> = new Set(["running"]);
const BOX_DEAD_STATUSES: ReadonlySet<string> = new Set(["error", "failed", "deleted", "destroyed"]);
const IMAGE_DEAD_STATES: ReadonlySet<string> = new Set(["error", "failed", "deleted"]);

export function isTerminalUnoBoxCreateJobState(state: UnoBoxCreateJobStatus["state"]): boolean {
  return state === "ready" || state === "failed";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toLaunchBody(input: UnoBoxProvisionInput): UnoBoxLaunchBody {
  return {
    name: input.name,
    ram_mb: input.ramMb ?? UNO_BOX_DEFAULT_RAM_MB,
    vcpu: input.vcpu ?? UNO_BOX_DEFAULT_VCPU,
    disk_gb: input.diskGb ?? UNO_BOX_DEFAULT_DISK_GB,
  };
}

type ImageChoice =
  | { readonly kind: "launch"; readonly imageId: number }
  | { readonly kind: "dead"; readonly imageId: number; readonly state: string };

/**
 * Which image to launch. The golden image belongs to a service account, so it
 * never shows up in the user's own `GET /api/v1/images` — looking it up there
 * made every account except the owner fall back to a plain box without the
 * daemon. The control plane lets any account launch its Uno Work image, and
 * `GET /api/v1/work/image` names it; older control planes without that route
 * get the id built into this release.
 */
async function chooseImage(
  client: UnoBoxProvisionClient,
  override: number | null | undefined,
): Promise<ImageChoice> {
  if (override != null) return { kind: "launch", imageId: override };
  let workImage: ReturnType<typeof parseUnoWorkImage> = null;
  try {
    workImage = parseUnoWorkImage(await client.getWorkImage());
  } catch {
    workImage = null;
  }
  if (!workImage) return { kind: "launch", imageId: UNO_WORK_GOLDEN_IMAGE_ID };
  if (IMAGE_DEAD_STATES.has(workImage.state.toLowerCase())) {
    return { kind: "dead", imageId: workImage.id, state: workImage.state };
  }
  return { kind: "launch", imageId: workImage.id };
}

/**
 * Runs one provisioning job to completion and returns its terminal status.
 * Never throws: every failure path ends in a `failed` status with a message,
 * because the caller is a fire-and-forget background task.
 */
export async function runUnoBoxProvisionJob(
  input: UnoBoxProvisionInput,
  deps: UnoBoxProvisionDeps,
): Promise<UnoBoxCreateJobStatus> {
  const timing: UnoBoxProvisionTiming = { ...DEFAULT_UNO_BOX_PROVISION_TIMING, ...deps.timing };
  const { client } = deps;

  let current: UnoBoxCreateJobStatus = { jobId: input.jobId, state: "creating" };
  const emit = (next: Omit<UnoBoxCreateJobStatus, "jobId">): UnoBoxCreateJobStatus => {
    current = { jobId: input.jobId, ...next };
    deps.onStatus(current);
    return current;
  };
  const fail = (
    message: string,
    extra?: Pick<UnoBoxCreateJobStatus, "boxId" | "box" | "daemonInstallRequired">,
  ) => emit({ state: "failed", message, ...extra });

  emit({ state: "creating", message: "Launching a box from the Uno Work image…" });

  // --- 1. Decide what to create. Read-only; nothing is billed here.
  const choice = await chooseImage(client, input.goldenImageId);
  const imageId = choice.imageId;
  if (choice.kind === "dead") {
    return fail(
      `The Uno Work image #${imageId} is not usable right now (state: ${choice.state}). Nothing was created.`,
    );
  }

  // --- 2. One launch call. A 404 means the image does not exist for this
  // account and nothing was created, so a plain box is the only other create
  // call a job can make.
  let box: UnoBox | null = null;
  let useGoldenImage = true;
  const body = toLaunchBody(input);
  try {
    box = parseUnoBox(await client.launchImage(imageId, body));
  } catch (cause) {
    if (controlPlaneErrorStatus(cause) !== 404) {
      return fail(`Could not create the box: ${errorMessage(cause)}`);
    }
    useGoldenImage = false;
  }
  if (!useGoldenImage) {
    try {
      box = parseUnoBox(
        await client.createPlainBox({
          ...body,
          template: PLAIN_BOX_TEMPLATE,
          network_profile: PLAIN_BOX_NETWORK_PROFILE,
        }),
      );
    } catch (cause) {
      return fail(`Could not create the box: ${errorMessage(cause)}`);
    }
  }
  if (!box) {
    return fail(
      "The control plane accepted the request but did not return a box. Check the box list before trying again.",
    );
  }
  const boxId = box.id;
  emit({
    state: "starting",
    boxId,
    box,
    message: useGoldenImage ? "Box created, waiting for it to boot…" : "Plain box created…",
  });

  // --- 3. Wait for `running` (read-only polling, wall-clock capped).
  const pollDeadline = deps.now() + timing.statusPollTimeoutMs;
  let lastPollError: string | null = null;
  while (!BOX_RUNNING_STATUSES.has(box.status)) {
    if (BOX_DEAD_STATUSES.has(box.status)) {
      return fail(`Box #${boxId} entered status "${box.status}" while booting.`, { boxId, box });
    }
    if (deps.now() >= pollDeadline) {
      return fail(
        `Box #${boxId} did not reach "running" within ${Math.round(timing.statusPollTimeoutMs / 60_000)} minutes` +
          (lastPollError ? ` (last error: ${lastPollError})` : "") +
          ". It may still come up — check the box list.",
        { boxId, box },
      );
    }
    await deps.sleep(timing.statusPollIntervalMs);
    try {
      const next = parseUnoBox(await client.getBox(boxId));
      if (next) {
        box = next;
        lastPollError = null;
        emit({ state: "starting", boxId, box, message: `Box status: ${box.status}` });
      }
    } catch (cause) {
      lastPollError = errorMessage(cause);
    }
  }

  if (!useGoldenImage) {
    return fail(
      `Box #${boxId} was created from a plain ${PLAIN_BOX_TEMPLATE} template because the Uno Work image #${imageId} was not found on this account. ` +
        "The Uno Work daemon is not installed on it, so it cannot be paired yet — install the daemon, then use Connect from the box list.",
      { boxId, box, daemonInstallRequired: true },
    );
  }

  // --- 4. Publish the daemon port. A box from an image has no inbound ports,
  // and without one the control plane has no hostname to put in the pairing
  // link ("no published hostname yet"), so every attempt below would fail.
  let hasDaemonPort = false;
  try {
    hasDaemonPort = hasInboundPort(await client.listPorts(boxId), UNO_WORK_DAEMON_PORT);
  } catch {
    hasDaemonPort = false;
  }
  if (!hasDaemonPort) {
    try {
      await client.openPort(boxId, UNO_WORK_DAEMON_PORT);
    } catch (cause) {
      return fail(
        `Box #${boxId} is running but port ${UNO_WORK_DAEMON_PORT} could not be opened for Uno Work (${errorMessage(cause)}). ` +
          "Open it from the box list, then use Connect.",
        { boxId, box },
      );
    }
  }

  // --- 5. Mint the pairing link. The daemon inside the box boots after the VM
  // reports running, so the first attempts are expected to fail.
  emit({ state: "waiting_daemon", boxId, box, message: "Box is running, waiting for Uno Work…" });
  const pairingDeadline = deps.now() + timing.pairingTimeoutMs;
  let lastPairingError: string | null = null;
  let connection: UnoBoxConnection | null = null;
  for (;;) {
    try {
      connection = parseUnoBoxConnection(await client.createWorkSession(boxId), boxId);
      if (connection) break;
      lastPairingError = "the control plane did not return a pairing link";
    } catch (cause) {
      lastPairingError = errorMessage(cause);
    }
    if (deps.now() >= pairingDeadline) {
      return fail(
        `Box #${boxId} is running but Uno Work did not answer within ${Math.round(timing.pairingTimeoutMs / 60_000)} minutes` +
          (lastPairingError ? ` (${lastPairingError})` : "") +
          ". Give it a minute, then use Connect from the box list.",
        { boxId, box },
      );
    }
    await deps.sleep(timing.pairingRetryIntervalMs);
  }

  // --- 6. Wait until the public address serves the daemon. The link alone
  // proves the daemon runs *inside* the box; the browser needs the edge route.
  emit({
    state: "waiting_daemon",
    boxId,
    box,
    connection,
    message: "Connecting to your computer…",
  });
  const baseUrl = pairingBaseUrl(connection);
  const mintedAt = deps.now();
  const addressDeadline = mintedAt + timing.addressReadyBudgetMs;
  let addressReady = baseUrl === null;
  while (!addressReady) {
    addressReady = await client.probeDaemonAddress(baseUrl!).catch(() => false);
    if (addressReady || deps.now() >= addressDeadline) break;
    await deps.sleep(timing.addressProbeIntervalMs);
  }

  // A link that waited long enough to be close to expiry is replaced. Failing
  // to mint a new one is not fatal: the client re-mints on its own retries.
  if (deps.now() - mintedAt >= timing.pairingRefreshAfterMs) {
    try {
      connection =
        parseUnoBoxConnection(await client.createWorkSession(boxId), boxId) ?? connection;
    } catch {
      // keep the older link
    }
  }

  return emit({
    state: "ready",
    boxId,
    box,
    connection,
    addressReady,
    message: addressReady
      ? null
      : "Your computer is created but still starting up. We'll keep trying to connect.",
  });
}

/** Origin of the pairing link (`https://<box>/pair#token=…` → `https://<box>`), or null if unparsable. */
export function pairingBaseUrl(connection: UnoBoxConnection): string | null {
  try {
    return new URL(connection.url).origin;
  } catch {
    return connection.hostname.length > 0 ? `https://${connection.hostname}` : null;
  }
}
