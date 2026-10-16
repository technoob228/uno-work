/**
 * Warnings an AI on this computer reads in `computer_status` (`notes`): the
 * numbers alone didn't stop agents from filling the disk (2507 at 100% on
 * 09.10 and 97% on 16.10: build caches, node_modules in every worktree) or
 * running out of memory (box 395 wedged on 01.09, builds in a RAM /tmp on
 * 16.10). A warning says what is tight and what to do, in one line each.
 */
import type { UnoResourcesDiskVolume, UnoResourcesMemory } from "@t3tools/contracts";

/** Used share of a disk from which an agent should free space before heavy work. */
export const DISK_TIGHT_PCT = 85;
/** Used share of a disk from which writes are about to fail. */
export const DISK_FULL_PCT = 95;
/** Below this much free space a disk is tight whatever its size. */
export const DISK_TIGHT_FREE_GB = 3;
export const DISK_FULL_FREE_GB = 1;
/** Memory programs can still get, as a share of all memory. */
export const MEMORY_TIGHT_AVAILABLE_PCT = 15;
/** Share of swap in use from which the computer is already short of memory. */
export const SWAP_BUSY_PCT = 50;
/** Swap use only matters while memory is short too (available below this share). */
export const SWAP_MATTERS_AVAILABLE_PCT = 30;

const gb = (value: number) => `${value < 10 ? value.toFixed(1) : Math.round(value)} GB`;

export function resourceWarnings(input: {
  readonly memory: UnoResourcesMemory;
  readonly volumes: ReadonlyArray<UnoResourcesDiskVolume>;
}): string[] {
  const notes: string[] = [];
  for (const volume of input.volumes) {
    if (volume.totalGb <= 0) continue;
    const usedPct = Math.round((volume.usedGb / volume.totalGb) * 100);
    const where = input.volumes.length > 1 ? ` (${volume.mount})` : "";
    if (usedPct >= DISK_FULL_PCT || volume.freeGb < DISK_FULL_FREE_GB) {
      notes.push(
        `Disk is full${where}: ${gb(volume.freeGb)} free of ${gb(volume.totalGb)} (${usedPct}% used). Writes and installs will fail. Free space now: computer_cleanup (build and package caches), then move big files the person keeps to Uno Drive (drive_save) — ask before deleting their files.`,
      );
    } else if (usedPct >= DISK_TIGHT_PCT || volume.freeGb < DISK_TIGHT_FREE_GB) {
      notes.push(
        `Disk is almost full${where}: ${gb(volume.freeGb)} free of ${gb(volume.totalGb)} (${usedPct}% used). Before installs, builds, docker images or downloads run computer_cleanup; keep big files in Uno Drive, not on this disk.`,
      );
    }
  }
  const { memory } = input;
  if (memory.totalMb > 0) {
    const availablePct = Math.round((memory.availableMb / memory.totalMb) * 100);
    if (availablePct < MEMORY_TIGHT_AVAILABLE_PCT) {
      notes.push(
        `Memory is tight: ${Math.round(memory.availableMb)} MB of ${Math.round(memory.totalMb)} MB left. Don't start another build, test run or model; run one heavy job at a time and stop what you started and no longer need (see topUsers).`,
      );
    }
  }
  // Swap alone isn't news: idle pages sit there for days while memory is free.
  const memoryLowish =
    memory.totalMb > 0 && (memory.availableMb / memory.totalMb) * 100 < SWAP_MATTERS_AVAILABLE_PCT;
  if (
    memoryLowish &&
    memory.swapTotalMb > 0 &&
    (memory.swapUsedMb / memory.swapTotalMb) * 100 >= SWAP_BUSY_PCT
  ) {
    notes.push(
      `The computer is swapping (${Math.round(memory.swapUsedMb)} of ${Math.round(memory.swapTotalMb)} MB swap used): everything is slow. Finish or stop heavy jobs before starting new ones.`,
    );
  }
  return notes;
}
