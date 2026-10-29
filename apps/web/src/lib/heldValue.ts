/**
 * "Keep what was on screen until the new answer is whole" (S6 29.10).
 *
 * A row built from several async sources (files, sites, a model's hints…)
 * used to redraw as each one arrived: Home's starter chips changed two or
 * three times on every start. `useHeldUntilSettled` shows, while the sources
 * are still loading:
 *   1. what it showed last time it was settled (in this mount),
 *   2. else what was settled on the previous start (localStorage, by `cacheKey`),
 *   3. else the value as it is now (a first start ever: one change, not several);
 * and the live value once everything settled — or after `maxWaitMs` on the
 * first settle, so a source that never answers can't freeze the row.
 *
 * Values must be JSON (they are cached for the next start).
 */
import { useEffect, useMemo, useRef, useState } from "react";

const CACHE_PREFIX = "uno-work:held:";

export function pickShownValue<T>(input: {
  readonly settled: boolean;
  readonly live: T;
  readonly held: T | undefined;
  readonly cached: T | undefined;
}): T {
  if (input.settled) return input.live;
  if (input.held !== undefined) return input.held;
  if (input.cached !== undefined) return input.cached;
  return input.live;
}

function readCached<T>(cacheKey: string | null): T | undefined {
  if (!cacheKey || typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + cacheKey);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

function writeCached(cacheKey: string | null, value: unknown): void {
  if (!cacheKey || typeof localStorage === "undefined") return;
  try {
    const next = JSON.stringify(value);
    if (localStorage.getItem(CACHE_PREFIX + cacheKey) !== next) {
      localStorage.setItem(CACHE_PREFIX + cacheKey, next);
    }
  } catch {
    // Storage full or blocked: the next start just has no first-frame value.
  }
}

export function useHeldUntilSettled<T>(input: {
  /** Per what the value is about (e.g. the computer); null = no cache. */
  readonly cacheKey: string | null;
  readonly live: T;
  readonly settled: boolean;
  readonly maxWaitMs?: number;
}): T {
  const { cacheKey, live, settled, maxWaitMs = 4_000 } = input;
  const cached = useMemo(() => readCached<T>(cacheKey), [cacheKey]);
  const held = useRef<{ key: string | null; value: T } | undefined>(undefined);
  const [waitedOut, setWaitedOut] = useState(false);
  useEffect(() => {
    if (settled || waitedOut) return;
    const timer = window.setTimeout(() => setWaitedOut(true), maxWaitMs);
    return () => window.clearTimeout(timer);
  }, [maxWaitMs, settled, waitedOut]);

  const heldForKey = held.current?.key === cacheKey ? held.current.value : undefined;
  // Out of patience only before the first settle: later reloads of a source
  // keep the previous row until they finish.
  const effectiveSettled = settled || (waitedOut && heldForKey === undefined);
  const shown = pickShownValue({ settled: effectiveSettled, live, held: heldForKey, cached });

  useEffect(() => {
    if (!effectiveSettled) return;
    held.current = { key: cacheKey, value: live };
    if (settled) writeCached(cacheKey, live);
  }, [cacheKey, effectiveSettled, live, settled]);

  return shown;
}
