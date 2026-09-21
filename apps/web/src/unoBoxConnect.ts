/**
 * "Connect this Uno box" as one resilient flow, shared by the Connect button,
 * "Create a new box", My machines and reconnecting a box that fell asleep.
 *
 *   asleep?  → wake it (uno.cloud.boxPower) and wait for `running`
 *   running  → mint a one-time pairing link (uno.cloud.connectBox)
 *            → pair the browser with the box's daemon (addSavedEnvironment)
 *
 * Every step that can fail because the machine is merely slow — the edge not
 * routing the hostname yet, the daemon still booting, a 502 from a box that is
 * waking — is retried with a *fresh* pairing link until a shared budget runs
 * out. Past the budget the flow throws `UnoBoxStillStartingError`, which the UI
 * shows as "Still starting — we'll keep trying", never as a failure.
 *
 * Everything the flow touches is injected (`UnoBoxConnectDeps`), so the retry
 * and wake rules are unit-tested without a daemon or a network.
 *
 * @module unoBoxConnect
 */
import type { EnvironmentId, UnoBox, UnoBoxConnection, UnoCloudState } from "@t3tools/contracts";

import { ensureEnvironmentApi } from "./environmentApi";
import { addSavedEnvironment, type SavedEnvironmentRecord } from "./environments/runtime";
import { isRemoteEnvironmentAuthHttpError } from "./environments/remote/api";
import { describeMachineError } from "./machineErrors";

export type UnoBoxConnectPhase =
  /** Asking Uno to wake the box, then waiting for it to report `running`. */
  | "waking"
  /** Minting the link and pairing with the daemon (first attempt). */
  | "connecting"
  /** A previous attempt hit a "still starting" failure; trying again. */
  | "retrying";

export interface UnoBoxConnectProgress {
  readonly phase: UnoBoxConnectPhase;
  readonly attempt: number;
  /** Plain-language reason for the last retry, when there was one. */
  readonly lastProblem: string | null;
}

/** Box power states that a wake (or start) brings back. */
const WAKE_ACTION_BY_STATUS: Readonly<Record<string, "wake" | "start">> = {
  sleeping: "wake",
  suspended: "wake",
  paused: "wake",
  hibernated: "wake",
  stopped: "start",
  off: "start",
};

const RUNNING_STATUSES: ReadonlySet<string> = new Set(["running", "active", "on"]);
const DEAD_STATUSES: ReadonlySet<string> = new Set(["error", "failed", "deleted", "destroyed"]);

export function boxNeedsWake(status: string): "wake" | "start" | null {
  return WAKE_ACTION_BY_STATUS[status.trim().toLowerCase()] ?? null;
}

export function isBoxRunning(status: string): boolean {
  return RUNNING_STATUSES.has(status.trim().toLowerCase());
}

export function isBoxDead(status: string): boolean {
  return DEAD_STATUSES.has(status.trim().toLowerCase());
}

/**
 * The box exists (and may be billed), but it did not answer within the
 * budget. Not a failure: the caller keeps the machine and offers to keep
 * trying.
 */
export class UnoBoxStillStartingError extends Error {
  readonly boxId: number;
  readonly lastError: unknown;

  constructor(boxId: number, lastError: unknown) {
    super(
      "The computer is still starting. It is already in your machines list; we'll keep trying to connect.",
    );
    this.name = "UnoBoxStillStartingError";
    this.boxId = boxId;
    this.lastError = lastError;
  }
}

export function isUnoBoxStillStartingError(error: unknown): error is UnoBoxStillStartingError {
  return error instanceof UnoBoxStillStartingError;
}

export interface UnoBoxConnectDeps {
  readonly getState: (refresh: boolean) => Promise<UnoCloudState>;
  readonly boxPower: (boxId: number, action: "wake" | "start") => Promise<UnoCloudState>;
  readonly mintConnection: (boxId: number) => Promise<UnoBoxConnection>;
  readonly pair: (input: {
    readonly label: string;
    readonly pairingUrl: string;
    readonly unoBoxId: number;
  }) => Promise<SavedEnvironmentRecord>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export interface UnoBoxConnectOptions {
  /** Total time for waking + connecting before `UnoBoxStillStartingError`. */
  readonly budgetMs?: number;
  readonly retryIntervalMs?: number;
  readonly wakePollIntervalMs?: number;
  /** A link minted moments ago (e.g. by the create job): used for the first attempt only. */
  readonly initialConnection?: UnoBoxConnection | null;
  readonly onProgress?: (progress: UnoBoxConnectProgress) => void;
  /** Stops retrying when aborted (dialog closed). */
  readonly signal?: AbortSignal;
}

export const UNO_BOX_CONNECT_BUDGET_MS = 90_000;
const DEFAULT_RETRY_INTERVAL_MS = 3_000;
const DEFAULT_WAKE_POLL_INTERVAL_MS = 3_000;

export class UnoBoxConnectAbortedError extends Error {
  constructor() {
    super("Connecting was cancelled.");
    this.name = "UnoBoxConnectAbortedError";
  }
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new UnoBoxConnectAbortedError();
}

function findBox(state: UnoCloudState, boxId: number): UnoBox | null {
  return state.boxes.find((box) => box.id === boxId) ?? null;
}

/**
 * Wake (if needed), then connect with retries. Resolves with the saved
 * environment; throws `UnoBoxStillStartingError` past the budget, or the
 * underlying error when it is not something waiting can fix.
 */
export async function connectUnoBoxWith(
  deps: UnoBoxConnectDeps,
  box: Pick<UnoBox, "id" | "name" | "status">,
  options: UnoBoxConnectOptions = {},
): Promise<SavedEnvironmentRecord> {
  const budgetMs = options.budgetMs ?? UNO_BOX_CONNECT_BUDGET_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const wakePollIntervalMs = options.wakePollIntervalMs ?? DEFAULT_WAKE_POLL_INTERVAL_MS;
  const deadline = deps.now() + budgetMs;
  let attempt = 0;
  let lastProblem: string | null = null;
  let lastError: unknown = null;
  const report = (phase: UnoBoxConnectPhase) =>
    options.onProgress?.({ phase, attempt, lastProblem });

  if (isBoxDead(box.status)) {
    throw new Error(`Box #${box.id} entered status "${box.status}".`);
  }

  // --- Wake. The control plane answers before the box is up, so poll.
  const wakeAction = boxNeedsWake(box.status);
  if (wakeAction) {
    report("waking");
    throwIfAborted(options.signal);
    let state = await deps.boxPower(box.id, wakeAction);
    for (;;) {
      const current = findBox(state, box.id);
      if (current && isBoxRunning(current.status)) break;
      if (current && isBoxDead(current.status)) {
        throw new Error(`Box #${box.id} entered status "${current.status}".`);
      }
      if (deps.now() >= deadline) {
        throw new UnoBoxStillStartingError(box.id, new Error("the box did not wake up in time"));
      }
      await deps.sleep(wakePollIntervalMs);
      throwIfAborted(options.signal);
      state = await deps.getState(true).catch(() => state);
    }
  }

  // --- Connect. Each attempt uses a fresh link: a link is single-use and
  // short-lived, and a failed bootstrap may have consumed it.
  let connection = options.initialConnection ?? null;
  for (;;) {
    throwIfAborted(options.signal);
    attempt += 1;
    report(attempt === 1 ? "connecting" : "retrying");
    try {
      const link = connection ?? (await deps.mintConnection(box.id));
      connection = null;
      return await deps.pair({ label: box.name, pairingUrl: link.url, unoBoxId: box.id });
    } catch (error) {
      connection = null;
      const human = describeMachineError(error);
      // A 401 from the box's own daemon means the one-time link expired or was
      // used up — a fresh link fixes it, so it is retried (a couple of times).
      const staleLink =
        isRemoteEnvironmentAuthHttpError(error) && error.status === 401 && attempt < 3;
      if (!human.transient && !staleLink) throw error;
      lastError = error;
      lastProblem = human.message;
    }
    if (deps.now() + retryIntervalMs >= deadline) {
      throw new UnoBoxStillStartingError(box.id, lastError);
    }
    await deps.sleep(retryIntervalMs);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The flow against the real daemon holding the Uno account (normally the primary one). */
export function connectUnoBox(
  accountEnvironmentId: EnvironmentId,
  box: Pick<UnoBox, "id" | "name" | "status">,
  options: UnoBoxConnectOptions = {},
): Promise<SavedEnvironmentRecord> {
  const api = ensureEnvironmentApi(accountEnvironmentId);
  return connectUnoBoxWith(
    {
      getState: (refresh) => api.unoCloud.getState({ refresh }),
      boxPower: (boxId, action) => api.unoCloud.boxPower({ boxId, action }),
      mintConnection: (boxId) => api.unoCloud.connectBox({ boxId }),
      pair: (input) =>
        addSavedEnvironment({
          label: input.label,
          pairingUrl: input.pairingUrl,
          unoBoxId: input.unoBoxId,
        }),
      sleep: defaultSleep,
      now: () => Date.now(),
    },
    box,
    options,
  );
}

/** What the progress line says for each phase. */
export function describeUnoBoxConnectProgress(progress: UnoBoxConnectProgress): string {
  switch (progress.phase) {
    case "waking":
      return "Waking up…";
    case "connecting":
      return "Connecting…";
    case "retrying":
      return "Still starting — trying again…";
  }
}

/**
 * Retry path for a box known only by id (a "still starting" machine): read its
 * current power state first, so a box that fell asleep meanwhile is woken
 * instead of being hammered with pairing attempts.
 */
export async function connectUnoBoxById(
  accountEnvironmentId: EnvironmentId,
  boxId: number,
  fallbackName: string,
  options: UnoBoxConnectOptions = {},
): Promise<SavedEnvironmentRecord> {
  const api = ensureEnvironmentApi(accountEnvironmentId);
  const state = await api.unoCloud.getState({ refresh: true });
  const box = findBox(state, boxId);
  return connectUnoBox(
    accountEnvironmentId,
    box ?? { id: boxId, name: fallbackName, status: "running" },
    options,
  );
}
