/**
 * Sizes the "Add memory / cores" dialog offers, and when the home screen
 * should suggest it. Plain data so the rules are tested directly.
 */
import type { UnoComputerShape } from "@t3tools/contracts";

const RAM_GB = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
const CORES = [1, 2, 3, 4, 6, 8, 12, 16];
const DISK_GB = [10, 15, 20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 500];

export interface SizeChoice {
  readonly value: number;
  /** Bigger than the plan allows right now: picking it leads to "Upgrade plan". */
  readonly abovePlan: boolean;
}

/**
 * The current size, the sizes up to what the plan allows, and a couple past it
 * (so the person sees there is more — behind a bigger plan).
 */
export function sizeChoices(
  steps: ReadonlyArray<number>,
  current: number,
  max: number,
  beyond = 2,
): SizeChoice[] {
  const values = new Set<number>([current]);
  for (const step of steps) if (step > current && step <= max) values.add(step);
  if (max > current) values.add(max);
  let extra = 0;
  for (const step of steps) {
    if (step > Math.max(max, current) && extra < beyond) {
      values.add(step);
      extra++;
    }
  }
  return [...values]
    .toSorted((a, b) => a - b)
    .map((value) => ({ value, abovePlan: value > Math.max(max, current) }));
}

export function ramChoices(currentMb: number, maxMb: number): SizeChoice[] {
  return sizeChoices(
    RAM_GB.map((gb) => gb * 1024),
    currentMb,
    maxMb,
  );
}

export function coreChoices(current: number, max: number): SizeChoice[] {
  return sizeChoices(CORES, current, max);
}

export function diskChoices(currentGb: number, maxGb: number): SizeChoice[] {
  return sizeChoices(DISK_GB, currentGb, maxGb);
}

/** What a change will do to the running computer, in words. */
export function resizeEffect(
  current: UnoComputerShape,
  next: UnoComputerShape,
): "none" | "live" | "restart" {
  if (
    next.ramMb === current.ramMb &&
    next.vcpu === current.vcpu &&
    next.diskGb === current.diskGb
  ) {
    return "none";
  }
  // Cores change the machine's layout: the computer restarts to apply them.
  // Memory and disk grow while it runs (memory past the size it booted with
  // also restarts it — the control plane decides; we say "may").
  return next.vcpu !== current.vcpu ? "restart" : "live";
}

/**
 * "Running low" needs to be steady, not one spike: the last `window` samples
 * all over the line.
 */
export function isSustained(
  samples: ReadonlyArray<number>,
  threshold: number,
  window = 5,
): boolean {
  if (samples.length < window) return false;
  return samples.slice(-window).every((value) => value > threshold);
}

export const LOW_MEMORY_PCT = 85;
export const LOW_DISK_PCT = 90;
