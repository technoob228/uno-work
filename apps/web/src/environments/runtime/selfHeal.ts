import type { EnvironmentId } from "@t3tools/contracts";

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
 */

const SELF_HEAL_BACKOFF_BASE_MS = 1_000;
const SELF_HEAL_BACKOFF_MAX_MS = 64_000;

interface SelfHealDeps {
  readonly performReconnect: (environmentId: EnvironmentId) => Promise<void>;
  readonly isAuthRequiredError: (error: unknown) => boolean;
  readonly onAuthRequired: (environmentId: EnvironmentId) => void;
}

interface SelfHealEntry {
  inflight: Promise<void> | null;
  consecutiveFailures: number;
  nextAllowedAt: number;
}

let deps: SelfHealDeps | null = null;
const entries = new Map<EnvironmentId, SelfHealEntry>();
const authBlocked = new Set<EnvironmentId>();

export function configureSelfHeal(nextDeps: SelfHealDeps): void {
  deps = nextDeps;
}

export function getSelfHealBackoffDelayMs(consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures, 1) - 1, 6);
  return Math.min(SELF_HEAL_BACKOFF_BASE_MS * 2 ** exponent, SELF_HEAL_BACKOFF_MAX_MS);
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
  };
  entries.set(environmentId, created);
  return created;
}

export function isSelfHealAuthBlocked(environmentId: EnvironmentId): boolean {
  return authBlocked.has(environmentId);
}

/**
 * Called by the manual reconnect path: the user is here, so interactive auth
 * is allowed again and the backoff ladder starts over.
 */
export function resetSelfHeal(environmentId: EnvironmentId): void {
  authBlocked.delete(environmentId);
  const entry = entries.get(environmentId);
  if (entry) {
    entry.consecutiveFailures = 0;
    entry.nextAllowedAt = 0;
  }
}

export function markSelfHealAuthRequired(environmentId: EnvironmentId): void {
  authBlocked.add(environmentId);
}

/** Resets backoff gates (not auth blocks) so a resume can retry immediately. */
export function resetSelfHealBackoffs(): void {
  for (const entry of entries.values()) {
    entry.consecutiveFailures = 0;
    entry.nextAllowedAt = 0;
  }
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
  if (authBlocked.has(environmentId)) {
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
    if (authBlocked.has(environmentId)) {
      return;
    }
    try {
      await configured.performReconnect(environmentId);
      entry.consecutiveFailures = 0;
      entry.nextAllowedAt = 0;
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
}
