/**
 * ProviderCommandReactor - Provider command reaction service interface.
 *
 * Owns background workers that react to orchestration intent events and
 * dispatch provider-side command execution.
 *
 * @module ProviderCommandReactor
 */
import type { ThreadId } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Scope } from "effect";

/**
 * What a prewarm request came to (see {@link ProviderCommandReactorShape.prewarmSession}):
 * - `started` — a harness session was started (or restarted) for the chat;
 * - `already-running` — the chat already had a live session;
 * - `busy` — a turn is in flight, nothing was touched;
 * - `skipped` — not an assistant chat (or it is gone);
 * - `failed` — starting the harness failed (logged).
 */
export type ProviderSessionPrewarmOutcome =
  | "started"
  | "already-running"
  | "busy"
  | "skipped"
  | "failed";

/**
 * ProviderCommandReactorShape - Service API for provider command reactors.
 */
export interface ProviderCommandReactorShape {
  /**
   * Start reacting to provider-intent orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Filters orchestration domain events to provider-intent types before
   * processing.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;

  /**
   * Start the harness session of an assistant chat ahead of its next
   * message, exactly as that message would (same selection, cwd, runtime
   * mode), so the message finds the process already up. Runs on the same
   * queue as turn starts, so a message sent meanwhile waits for this start
   * instead of racing a second one. `restart` replaces a live session (a new
   * gateway key) — never while a turn is in flight. Optional: test doubles
   * omit it.
   */
  readonly prewarmSession?: (
    threadId: ThreadId,
    options?: { readonly restart?: boolean },
  ) => Effect.Effect<ProviderSessionPrewarmOutcome>;
}

/**
 * ProviderCommandReactor - Service tag for provider command reaction workers.
 */
export class ProviderCommandReactor extends Context.Service<
  ProviderCommandReactor,
  ProviderCommandReactorShape
>()("t3/orchestration/Services/ProviderCommandReactor") {}
