/**
 * Which model a chat moved from Uno AI starts on, and when that is known.
 *
 * A fresh computer (a free trial made in 8 s) answers its first harness list
 * before any harness was checked: Hermes / Uno Code say "warning, sign-in
 * unknown" for a few seconds. Starting the hand-off then gave it no model,
 * the chat fell back to the machine's default — Claude Code without a login —
 * and answered "Not logged in" (16.10). So: wait until Uno's engine has been
 * checked (or a cap), and never pick a harness that isn't signed in.
 */
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

import { isUsableDefaultProvider, pickUsableDefaultModelSelection } from "../providerModels";

/** How long a hand-off waits for Uno's engine to be checked before going on without it. */
export const UNO_CHECK_CAP_MS = 20_000;

function isUnoEngine(provider: ServerProvider): boolean {
  return provider.driver === "hermes" || provider.driver === "uno";
}

/**
 * The harness hasn't been checked yet in this session: the server's first
 * snapshot (enabled, no version, "warning", sign-in unknown). Once checked it
 * has a version, a sign-in answer or an error.
 */
export function isProviderUnchecked(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.status === "warning" &&
    provider.version === null &&
    provider.auth.status === "unknown"
  );
}

export interface UnoHandoffSelection {
  /** The machine has said enough to start the hand-off now. */
  readonly settled: boolean;
  readonly selection: ModelSelection | null;
}

/**
 * Uno's engine may still come up: unchecked, or checked before the computer's
 * Uno key landed (signed out for now) — worth waiting for up to the cap.
 */
function mayStillAnswer(provider: ServerProvider): boolean {
  return (
    isUnoEngine(provider) &&
    provider.enabled &&
    (isProviderUnchecked(provider) ||
      (provider.status !== "error" && provider.auth.status === "unauthenticated"))
  );
}

export function resolveUnoHandoffSelection(
  providers: ReadonlyArray<ServerProvider>,
  capReached = false,
): UnoHandoffSelection {
  if (providers.length === 0) return { settled: false, selection: null };
  const uno = pickUsableDefaultModelSelection(providers.filter(isUnoEngine));
  if (uno) return { settled: true, selection: uno as ModelSelection };
  if (!capReached && providers.some(mayStillAnswer)) return { settled: false, selection: null };
  // Uno's engine can't answer here: the first signed-in harness, never a logged-out one.
  const other = pickUsableDefaultModelSelection(
    providers.filter((p) => !isUnoEngine(p) && isUsableDefaultProvider(p)),
  );
  if (other) return { settled: true, selection: other as ModelSelection };
  // Nothing signed in at all: still Uno's engine (it says what's missing, and
  // answers once the key lands) rather than the machine default's "Not logged in".
  const fallback = providers.find((p) => isUnoEngine(p) && p.enabled && p.models.length > 0);
  return {
    settled: true,
    selection: fallback
      ? ({ instanceId: fallback.instanceId, model: fallback.models[0]!.slug } as ModelSelection)
      : null,
  };
}
