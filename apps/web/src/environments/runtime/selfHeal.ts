import type { EnvironmentId } from "@t3tools/contracts";

import { isRemoteEnvironmentAuthHttpError } from "../remote/api";

/**
 * Single-flight, backoff-gated self-healing for saved environment
 * connections. Triggers arrive from three directions — desktop tunnel state
 * events, transport-level recovery failures, and browser resume — and all of
 * them join one heal run per environment. Failed runs push the next allowed
 * attempt out exponentially (1s→64s) so a dead environment is retried
 * politely; a successful run (or an explicit manual reconnect) resets the
 * ladder.
 *
 * Environments whose reconnect requires interactive credentials are marked
 * auth-blocked: self-healing skips them entirely until a manual reconnect
 * clears the block. This is what keeps a dead cached password from turning
 * into a password prompt storm.
 *
 * Environments that fail in a way no retry can fix (the machine's ssh host
 * key changed, its address no longer resolves, its auth endpoints are gone)
 * are marked "needs attention" the same way: automatic retries stop until
 * the person presses Reconnect. Before this, such an environment was retried
 * forever (thousands of failures a day in one user's log).
 */

const SELF_HEAL_BACKOFF_BASE_MS = 1_000;
const SELF_HEAL_BACKOFF_MAX_MS = 64_000;

export type PermanentFailureKind = "host-key-changed" | "address-not-found" | "endpoint-missing";

export interface PermanentFailure {
  readonly kind: PermanentFailureKind;
  /** Shown to the person in place of the raw error. */
  readonly message: string;
  /** Failures of this kind in a row before automatic retries stop… */
  readonly confirmAfter: number;
  /** …and how long that streak must have lasted (rules out a short outage). */
  readonly minStreakMs: number;
}

const HOST_KEY_CHANGED_RE =
  /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key for .* has changed/i;
const ADDRESS_NOT_FOUND_RE =
  /Could not resolve hostname|ENOTFOUND|EAI_NONAME|nodename nor servname|Name or service not known|ERR_NAME_NOT_RESOLVED/i;
const SSH_HTTP_NOT_FOUND_RE = /\[ssh_http:404\]/;

/**
 * Failures a later retry will not fix. Ambiguous ones (DNS can fail while the
 * Wi-Fi reconnects; an edge can 404 for a moment) only count after a long
 * enough streak. Everything else (timeouts, refused connections, 5xx) is
 * transient and keeps the normal backoff.
 */
export function classifyPermanentFailure(error: unknown): PermanentFailure | null {
  const message = error instanceof Error ? error.message : String(error);
  if (HOST_KEY_CHANGED_RE.test(message)) {
    return {
      kind: "host-key-changed",
      message:
        "This computer's security key has changed, so Uno Work stopped connecting to it automatically. If you expected this (for example, it was reinstalled), press Reconnect.",
      confirmAfter: 1,
      minStreakMs: 0,
    };
  }
  if (ADDRESS_NOT_FOUND_RE.test(message)) {
    return {
      kind: "address-not-found",
      message:
        "Uno Work can't find this computer's address anymore, so it stopped trying automatically. Check that the computer still exists, then press Reconnect.",
      confirmAfter: 5,
      minStreakMs: 10 * 60_000,
    };
  }
  if (
    (isRemoteEnvironmentAuthHttpError(error) && error.status === 404) ||
    SSH_HTTP_NOT_FOUND_RE.test(message)
  ) {
    return {
      kind: "endpoint-missing",
      message:
        "This computer no longer answers like an Uno Work computer, so Uno Work stopped trying automatically. Press Reconnect to try again.",
      confirmAfter: 3,
      minStreakMs: 2 * 60_000,
    };
  }
  return null;
}

interface SelfHealDeps {
  readonly performReconnect: (environmentId: EnvironmentId) => Promise<void>;
  readonly isAuthRequiredError: (error: unknown) => boolean;
  readonly onAuthRequired: (environmentId: EnvironmentId) => void;
  readonly onNeedsAttention?: (environmentId: EnvironmentId, failure: PermanentFailure) => void;
  /** Address lookups fail while the device itself is offline; those do not count. */
  readonly isDeviceOnline?: () => boolean;
}

interface PermanentFailureStreak {
  readonly kind: PermanentFailureKind;
  count: number;
  readonly firstAt: number;
}

interface SelfHealEntry {
  inflight: Promise<void> | null;
  consecutiveFailures: number;
  nextAllowedAt: number;
  permanentStreak: PermanentFailureStreak | null;
}

let deps: SelfHealDeps | null = null;
const entries = new Map<EnvironmentId, SelfHealEntry>();
const authBlocked = new Set<EnvironmentId>();
const attentionBlocked = new Map<EnvironmentId, PermanentFailure>();

export function configureSelfHeal(nextDeps: SelfHealDeps): void {
  deps = nextDeps;
}

/**
 * The ceiling doubles 1s -> 64s; the delay is a random point in the upper half
 * of it ("equal jitter"): never quicker than half the ceiling, and machines
 * that dropped together (a node or Contabo restart) do not all come back in
 * the same second. `random` is in [0, 1). Upstream t3code 9333509c91.
 */
export function getSelfHealBackoffDelayMs(
  consecutiveFailures: number,
  random: number = Math.random(),
): number {
  const exponent = Math.min(Math.max(consecutiveFailures, 1) - 1, 6);
  const ceiling = Math.min(SELF_HEAL_BACKOFF_BASE_MS * 2 ** exponent, SELF_HEAL_BACKOFF_MAX_MS);
  const clamped = Math.min(Math.max(random, 0), 1);
  return Math.round(ceiling / 2 + (ceiling / 2) * clamped);
}

function getEntry(environmentId: EnvironmentId): SelfHealEntry {
  const existing = entries.get(environmentId);
  if (existing) {
    return existing;
  }
  const created: SelfHealEntry = {
    inflight: null,
    consecutiveFailures: 0,
    nextAllowedAt: 0,
    permanentStreak: null,
  };
  entries.set(environmentId, created);
  return created;
}

export function isSelfHealAuthBlocked(environmentId: EnvironmentId): boolean {
  return authBlocked.has(environmentId);
}

/** Set while automatic reconnects are stopped for a permanent failure. */
export function getSelfHealNeedsAttention(environmentId: EnvironmentId): PermanentFailure | null {
  return attentionBlocked.get(environmentId) ?? null;
}

/**
 * Feeds one failed connection step (heal run, ws token issue, …) into the
 * permanent-failure detector. Returns true when this failure stopped
 * automatic retries for the environment.
 */
export function noteSavedEnvironmentFailure(environmentId: EnvironmentId, error: unknown): boolean {
  if (attentionBlocked.has(environmentId)) {
    return true;
  }
  const failure = classifyPermanentFailure(error);
  if (!failure) {
    return false;
  }
  if (failure.kind === "address-not-found" && deps?.isDeviceOnline?.() === false) {
    return false;
  }
  const entry = getEntry(environmentId);
  const now = Date.now();
  const streak =
    entry.permanentStreak?.kind === failure.kind
      ? entry.permanentStreak
      : { kind: failure.kind, count: 0, firstAt: now };
  streak.count += 1;
  entry.permanentStreak = streak;
  if (streak.count < failure.confirmAfter || now - streak.firstAt < failure.minStreakMs) {
    return false;
  }
  attentionBlocked.set(environmentId, failure);
  try {
    deps?.onNeedsAttention?.(environmentId, failure);
  } catch {
    // Listener errors must not break the heal loop.
  }
  return true;
}

/** A connection that worked proves earlier failures were not permanent. */
export function noteSavedEnvironmentHealthy(environmentId: EnvironmentId): void {
  const entry = entries.get(environmentId);
  if (entry) {
    entry.permanentStreak = null;
  }
}

/**
 * Called by the manual reconnect path: the user is here, so interactive auth
 * is allowed again and the backoff ladder starts over.
 */
export function resetSelfHeal(environmentId: EnvironmentId): void {
  authBlocked.delete(environmentId);
  attentionBlocked.delete(environmentId);
  const entry = entries.get(environmentId);
  if (entry) {
    entry.consecutiveFailures = 0;
    entry.nextAllowedAt = 0;
    entry.permanentStreak = null;
  }
}

export function markSelfHealAuthRequired(environmentId: EnvironmentId): void {
  authBlocked.add(environmentId);
}

export function healSavedEnvironment(
  environmentId: EnvironmentId,
  reason: string,
  options?: { readonly immediate?: boolean },
): Promise<void> {
  const configured = deps;
  if (!configured) {
    return Promise.resolve();
  }
  if (authBlocked.has(environmentId) || attentionBlocked.has(environmentId)) {
    return Promise.resolve();
  }
  const entry = getEntry(environmentId);
  if (entry.inflight) {
    return entry.inflight;
  }

  if (options?.immediate) {
    entry.nextAllowedAt = 0;
  }
  const waitMs = Math.max(0, entry.nextAllowedAt - Date.now());

  const run = (async () => {
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    if (authBlocked.has(environmentId) || attentionBlocked.has(environmentId)) {
      return;
    }
    try {
      await configured.performReconnect(environmentId);
      entry.consecutiveFailures = 0;
      entry.nextAllowedAt = 0;
      entry.permanentStreak = null;
    } catch (error) {
      entry.consecutiveFailures += 1;
      entry.nextAllowedAt = Date.now() + getSelfHealBackoffDelayMs(entry.consecutiveFailures);
      if (configured.isAuthRequiredError(error)) {
        authBlocked.add(environmentId);
        try {
          configured.onAuthRequired(environmentId);
        } catch {
          // Listener errors must not break the heal loop.
        }
        return;
      }
      if (noteSavedEnvironmentFailure(environmentId, error)) {
        return;
      }
      console.warn("Saved environment self-heal failed", {
        environmentId,
        reason,
        attempt: entry.consecutiveFailures,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })().finally(() => {
    if (entry.inflight === run) {
      entry.inflight = null;
    }
  });

  entry.inflight = run;
  return run;
}

export function resetSelfHealForTests(): void {
  deps = null;
  entries.clear();
  authBlocked.clear();
  attentionBlocked.clear();
}
