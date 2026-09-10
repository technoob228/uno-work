/**
 * Client side of "create a new Uno box": start the daemon's background job,
 * poll it to a terminal state, then register the box as a saved environment
 * exactly the way the Connect button does.
 *
 * The polling loop is a pure function over a `getStatus` callback so the
 * state handling can be unit-tested without a daemon.
 */
import {
  UNO_BOX_DEFAULT_DISK_GB,
  UNO_BOX_DEFAULT_RAM_MB,
  UNO_BOX_DEFAULT_VCPU,
  type EnvironmentId,
  type UnoBoxCreateJobState,
  type UnoBoxCreateJobStatus,
} from "@t3tools/contracts";

import { ensureEnvironmentApi } from "./environmentApi";
import { addSavedEnvironment, type SavedEnvironmentRecord } from "./environments/runtime";

export type UnoBoxSizePreset = "small" | "medium";

export interface UnoBoxSizeSpec {
  readonly label: string;
  readonly description: string;
  readonly ramMb: number;
  readonly vcpu: number;
  readonly diskGb: number;
}

export const UNO_BOX_SIZE_PRESETS: Record<UnoBoxSizePreset, UnoBoxSizeSpec> = {
  small: {
    label: "Small",
    description: "2 GB RAM · 1 vCPU · 10 GB",
    ramMb: UNO_BOX_DEFAULT_RAM_MB,
    vcpu: UNO_BOX_DEFAULT_VCPU,
    diskGb: UNO_BOX_DEFAULT_DISK_GB,
  },
  medium: {
    label: "Medium",
    description: "4 GB RAM · 2 vCPU · 20 GB",
    ramMb: 4096,
    vcpu: 2,
    diskGb: 20,
  },
};

export const UNO_BOX_NAME_MAX_LENGTH = 40;

/**
 * Box names travel into hostnames on the control plane, so keep them DNS-ish:
 * lowercase, digits and dashes, no leading/trailing dash.
 */
export function normalizeUnoBoxName(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, UNO_BOX_NAME_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug;
}

export function describeUnoBoxCreateJobState(state: UnoBoxCreateJobState): string {
  switch (state) {
    case "creating":
      return "Creating the box…";
    case "starting":
      return "Box created, waiting for it to boot…";
    case "waiting_daemon":
      return "Box is running, waiting for Uno Work to answer…";
    case "ready":
      return "Box is ready.";
    case "failed":
      return "Box creation failed.";
  }
}

export function isTerminalUnoBoxCreateJobStatus(status: UnoBoxCreateJobStatus): boolean {
  return status.state === "ready" || status.state === "failed";
}

export interface WaitForUnoBoxCreateJobOptions {
  readonly intervalMs?: number;
  /** Client-side safety net above the daemon's own caps (3 min boot + 2 min daemon). */
  readonly timeoutMs?: number;
  /** Consecutive status-read failures tolerated before giving up (reconnects, blips). */
  readonly maxConsecutiveErrors?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly onStatus?: (status: UnoBoxCreateJobStatus) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 6 * 60 * 1000;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls `getStatus` until the job is `ready` or `failed` and returns that
 * terminal status. Throws only when the status itself cannot be read for a
 * sustained stretch or the client-side timeout passes — never re-creates.
 */
export async function waitForUnoBoxCreateJob(
  getStatus: (jobId: string) => Promise<UnoBoxCreateJobStatus>,
  jobId: string,
  options: WaitForUnoBoxCreateJobOptions = {},
): Promise<UnoBoxCreateJobStatus> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const maxConsecutiveErrors = options.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());

  const deadline = now() + timeoutMs;
  let consecutiveErrors = 0;
  let lastError: unknown = null;

  for (;;) {
    try {
      const status = await getStatus(jobId);
      consecutiveErrors = 0;
      options.onStatus?.(status);
      if (isTerminalUnoBoxCreateJobStatus(status)) return status;
    } catch (cause) {
      consecutiveErrors += 1;
      lastError = cause;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        throw new Error(
          `Lost track of the box creation job: ${cause instanceof Error ? cause.message : String(cause)}. The box may still be created — check the box list.`,
          { cause },
        );
      }
    }
    if (now() >= deadline) {
      throw new Error(
        "Box creation is taking longer than expected. It may still finish — check the box list in a minute." +
          (lastError instanceof Error ? ` (${lastError.message})` : ""),
      );
    }
    await sleep(intervalMs);
  }
}

export interface CreateUnoBoxInput {
  readonly name: string;
  readonly preset: UnoBoxSizePreset;
  readonly onStatus?: (status: UnoBoxCreateJobStatus) => void;
}

export interface CreateUnoBoxResult {
  readonly status: UnoBoxCreateJobStatus;
  readonly record: SavedEnvironmentRecord;
}

/**
 * The full "Create a new box" flow against the environment that holds the Uno
 * account (normally the primary one). One `createBox` call per invocation;
 * the caller is responsible for not invoking it twice for one click.
 */
export async function createUnoBoxAndConnect(
  environmentId: EnvironmentId,
  input: CreateUnoBoxInput,
): Promise<CreateUnoBoxResult> {
  const api = ensureEnvironmentApi(environmentId);
  const name = normalizeUnoBoxName(input.name);
  if (name.length === 0) {
    throw new Error("Give the box a name (letters, digits and dashes).");
  }
  const size = UNO_BOX_SIZE_PRESETS[input.preset];

  const { jobId } = await api.unoCloud.createBox({
    name,
    ramMb: size.ramMb,
    vcpu: size.vcpu,
    diskGb: size.diskGb,
    purpose: "work",
  });

  const status = await waitForUnoBoxCreateJob(
    (id) => api.unoCloud.createBoxStatus({ jobId: id }),
    jobId,
    input.onStatus ? { onStatus: input.onStatus } : {},
  );

  if (status.state !== "ready" || !status.connection) {
    throw new Error(status.message ?? describeUnoBoxCreateJobState(status.state));
  }

  const record = await addSavedEnvironment({
    label: status.box?.name ?? name,
    pairingUrl: status.connection.url,
  });
  return { status, record };
}
