/**
 * How busy the processor is, as one number for a person.
 *
 * The "Processor" figure is read every few seconds by every open screen. It
 * used to be the share of the processor since the previous read — whoever
 * asked last. That window was as short as a quarter of a second (two screens
 * or two tabs reset each other's baseline), so any brief burst — Uno Work
 * opening, a scan of the programs — read as the whole computer being busy.
 * Now the share is taken over at least `CPU_HEADLINE_WINDOW_MS`, no matter
 * how often or by how many screens it is asked: a steady load still shows as
 * it is (it fills the whole window), a blip no longer passes for one.
 */
export const CPU_HEADLINE_WINDOW_MS = 15_000;

export interface CpuTotals {
  /** Ticks (or ms) the processors spent idle, summed over all cores. */
  readonly idle: number;
  /** All ticks (or ms), summed over all cores. */
  readonly total: number;
}

interface Reading extends CpuTotals {
  readonly at: number;
}

export class CpuLoadWindow {
  private readonly readings: Reading[] = [];
  private readonly windowMs: number;

  constructor(windowMs: number = CPU_HEADLINE_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * Records a reading and returns the busy share (0–100) since the newest
   * earlier reading at least `windowMs` old — or since the oldest one while
   * the history is shorter than that. `null` until there is a "before".
   */
  sample(at: number, totals: CpuTotals | null): number | null {
    if (!totals) return null;
    const base = this.baseline(at);
    this.readings.push({ at, idle: totals.idle, total: totals.total });
    this.prune(at);
    if (!base) return null;
    const total = totals.total - base.total;
    if (!(total > 0)) return null;
    const busy = 1 - (totals.idle - base.idle) / total;
    return Number.isFinite(busy) ? Math.max(0, Math.min(100, busy * 100)) : null;
  }

  private baseline(at: number): Reading | null {
    let pick: Reading | null = null;
    for (const r of this.readings) {
      if (r.at >= at) continue;
      if (at - r.at >= this.windowMs) pick = r; // newest one old enough (list is in order)
    }
    if (pick) return pick;
    const oldest = this.readings[0];
    return oldest && oldest.at < at ? oldest : null;
  }

  private prune(at: number) {
    // Everything before the newest reading older than the window can go: that
    // one is the next baseline, and nothing older will be picked again.
    let lastOldEnough = -1;
    for (let i = 0; i < this.readings.length; i++) {
      if (at - this.readings[i]!.at >= this.windowMs) lastOldEnough = i;
    }
    if (lastOldEnough > 0) this.readings.splice(0, lastOldEnough);
  }
}
