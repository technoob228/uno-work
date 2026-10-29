/**
 * Browser bridge on a bad link: what the client remembers to resume, and how
 * it hands command results back.
 *
 * - Resume: per computer, the sequence of the last bridge event seen. A
 *   resubscribe (reconnect, new connection) passes it, and the server replays
 *   recent events published while the socket was down (browserBridge.ts).
 * - Results: the result POST is retried with a timeout, so a result produced
 *   during a link drop still reaches the agent instead of it timing out.
 */
import type { BrowserBridgeStreamEvent, EnvironmentId } from "@t3tools/contracts";

const lastSeenSequenceByEnvironment = new Map<EnvironmentId, number>();

export function readBridgeResumeCursor(environmentId: EnvironmentId): number | null {
  return lastSeenSequenceByEnvironment.get(environmentId) ?? null;
}

/**
 * The last event seen, not the highest: after a server restart sequences start
 * over and the cursor must follow. Still-open secret / approval requests are
 * re-sent on every subscribe with their original (older) sequence; those do
 * not move the cursor back.
 */
export function noteBridgeEventSeen(
  environmentId: EnvironmentId,
  event: BrowserBridgeStreamEvent,
): void {
  const current = lastSeenSequenceByEnvironment.get(environmentId);
  const isOpenRequestReplay =
    (event.type === "secretRequest" || event.type === "toolApprovalRequest") &&
    current !== undefined &&
    event.sequence <= current;
  if (isOpenRequestReplay) return;
  lastSeenSequenceByEnvironment.set(environmentId, event.sequence);
}

export function resetBridgeDeliveryForTests(): void {
  lastSeenSequenceByEnvironment.clear();
}

export const RESULT_POST_TIMEOUT_MS = 15_000;
export const RESULT_POST_RETRY_DELAYS_MS: ReadonlyArray<number> = [1_000, 2_000, 4_000, 8_000];

export interface ResultPostDeps {
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
}

const defaultDeps: ResultPostDeps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * POST a command result; retries network errors, timeouts and 5xx. A 4xx
 * (404: the command already got a result or timed out) is final. Returns
 * whether the server accepted it.
 */
export async function postBridgeResult(
  url: string,
  body: string,
  deps: ResultPostDeps = defaultDeps,
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await deps.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(RESULT_POST_TIMEOUT_MS),
      });
      if (response.ok) return true;
      if (response.status < 500) return false;
    } catch {
      // Link dropped or the request timed out: try again.
    }
    const delay = RESULT_POST_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return false;
    await deps.sleep(delay);
  }
}
