/**
 * May this machine's account run Claude Code on Uno AI?
 *
 * Asks the gateway's `GET /v1/ai/status` with the machine's gateway key: a
 * trial computer (plan `work-trial`, free chat) is refused on /v1/messages,
 * so Claude there must ask for the person's own sign-in instead of looking
 * ready. The answer is cached (the Claude status check runs every few
 * minutes); a gateway that can't be reached keeps the last answer, or
 * "allowed" — the way it was before this check.
 *
 * @module provider/Drivers/unoClaudeAvailability
 */
import { claudeOnUnoAllowedByAiStatus } from "../Layers/ClaudeProvider.ts";

const TIMEOUT_MS = 5_000;
/** A plan changes rarely; an upgrade is picked up within this. */
export const UNO_CLAUDE_AVAILABILITY_TTL_MS = 5 * 60_000;

export function makeUnoClaudeAvailability(deps: {
  readonly baseUrl: string;
  readonly key: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}): () => Promise<boolean> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let answer: boolean | null = null;
  let checkedAt = 0;
  let running: Promise<boolean> | null = null;

  const readOnce = async (): Promise<boolean> => {
    try {
      const response = await doFetch(`${deps.baseUrl}/ai/status`, {
        headers: { authorization: `Bearer ${deps.key}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return answer ?? true;
      const allowed = claudeOnUnoAllowedByAiStatus(await response.json().catch(() => null));
      answer = allowed ?? true;
      return answer;
    } catch {
      return answer ?? true;
    } finally {
      checkedAt = now();
    }
  };

  return () => {
    if (answer !== null && now() - checkedAt < UNO_CLAUDE_AVAILABILITY_TTL_MS) {
      return Promise.resolve(answer);
    }
    running ??= readOnce().finally(() => {
      running = null;
    });
    return running;
  };
}
