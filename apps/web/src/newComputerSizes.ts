/**
 * Sizes for a new Uno Work computer, within the plan — the rules of the Uno
 * console's "New computer" (uno-console `lib/boxes/newComputer.ts`:
 * `IMAGES.workspace`, `sizeOptions`, `blockNote`), so Work and the console
 * offer the same three sizes and say the same thing when one does not fit.
 *
 * The numbers come from `GET /api/v1/box-subscription` (`plan_limits.max_box`,
 * `plan_limits.peak` / `always_on`, `usage`), read by `fetchSubscription`.
 * Nothing here is a guess: without that answer every size is offered and the
 * console stays the judge (it refuses with a reason the form then shows).
 *
 * Pure: no React, no requests — tested by `newComputerSizes.test.ts`.
 */
import type { AccountSubscription, PlanView } from "./account/accountOverview";
import { formatRam } from "./account/billingModel";
import type { UnoBoxShape } from "./unoBoxCreation";

export interface WorkComputerSize {
  readonly ramMb: number;
  /** Disk on a plan with room for it; clamped to what is free (see `sizeOptions`). */
  readonly diskGb: number;
}

/**
 * Uno Work runs on 2 GB since 07.10 (fishcode `paidWorkRAMMB`); 4 GB is what
 * we recommend for several chats and apps side by side. Disk = Work's 20 GB.
 */
export const WORK_COMPUTER_SIZES: ReadonlyArray<WorkComputerSize> = [
  { ramMb: 2048, diskGb: 20 },
  { ramMb: 4096, diskGb: 20 },
  { ramMb: 8192, diskGb: 40 },
];
export const WORK_MIN_RAM_MB = 2048;
export const WORK_RECOMMENDED_RAM_MB = 4096;
/** The smallest disk the Work image fits on (console `IMAGES.workspace.minDiskGb`). */
const WORK_MIN_DISK_GB = 9;

/** What the plan leaves for a new computer. */
export interface PlanRoom {
  /** "Plus" — the plan's own name, without "+ Uno AI". */
  readonly planName: string;
  /** False: no plan (or it ended) — computers come with a plan. */
  readonly hasPlan: boolean;
  /** The biggest single computer. */
  readonly perComputerMb: number;
  readonly perComputerVcpu: number;
  /** Memory for computers running at once (always-on memory on the new plans). */
  readonly totalMb: number;
  /** Running right now; asleep computers don't count. */
  readonly inUseMb: number;
  readonly leftMb: number;
  readonly diskGb: number;
  readonly diskUsedGb: number;
  readonly planView: PlanView | null;
}

const ENDED = new Set(["cancelled", "canceled", "suspended", "expired"]);

/**
 * `undefined` — the account could not be asked (signed out, loading, an error):
 * the form then offers every size. `null` — the console said there is no plan.
 */
export function planRoom(subscription: AccountSubscription | null | undefined): PlanRoom | null {
  if (subscription === undefined) return null;
  const limits = subscription?.limits ?? null;
  if (!subscription || !limits || ENDED.has(subscription.status)) {
    return {
      planName: limits?.name ?? "",
      hasPlan: false,
      perComputerMb: 0,
      perComputerVcpu: 0,
      totalMb: 0,
      inUseMb: 0,
      leftMb: 0,
      diskGb: 0,
      diskUsedGb: 0,
      planView: subscription?.planView ?? null,
    };
  }
  const totalMb = subscription.alwaysOn?.ramMb || limits.alwaysOn?.ramMb || limits.peakRamMb;
  const inUseMb = subscription.alwaysOn?.runningRamMb ?? subscription.usage.runningRamMb;
  return {
    planName: limits.name,
    hasPlan: true,
    perComputerMb: limits.maxBoxRamMb,
    perComputerVcpu: limits.maxBoxVcpu,
    totalMb,
    inUseMb,
    leftMb: Math.max(0, totalMb - inUseMb),
    diskGb: subscription.diskGbOverride ?? limits.diskGb,
    diskUsedGb: subscription.usage.diskGbUsed,
    planView: subscription.planView,
  };
}

export type SizeBlock = "no_plan" | "too_big" | "no_room" | "disk_full";

export interface SizeOption {
  readonly shape: UnoBoxShape;
  readonly recommended: boolean;
  readonly minimum: boolean;
  /** null — it fits the plan right now. */
  readonly block: SizeBlock | null;
}

/** Cores for a memory size, capped by the plan (console `vcpuFor`). */
function vcpuFor(ramMb: number, maxVcpu: number): number {
  const v = ramMb <= 1024 ? 1 : ramMb <= 4096 ? 2 : ramMb <= 8192 ? 4 : 8;
  return Math.max(1, Math.min(v, maxVcpu || v));
}

function sizeBlock(ramMb: number, room: PlanRoom): SizeBlock | null {
  if (!room.hasPlan) return "no_plan";
  if (room.perComputerMb > 0 && ramMb > room.perComputerMb) return "too_big";
  if (room.diskGb > 0 && room.diskGb - room.diskUsedGb < WORK_MIN_DISK_GB) return "disk_full";
  if (room.totalMb > 0 && ramMb > room.leftMb) return "no_room";
  return null;
}

/** The three sizes, each with whether the plan allows it right now. */
export function sizeOptions(room: PlanRoom | null): SizeOption[] {
  const freeDisk = room && room.diskGb > 0 ? Math.max(0, room.diskGb - room.diskUsedGb) : null;
  return WORK_COMPUTER_SIZES.map((size) => {
    const block = room ? sizeBlock(size.ramMb, room) : null;
    const fits = block === null && room !== null;
    return {
      shape: {
        ramMb: size.ramMb,
        vcpu: vcpuFor(size.ramMb, fits ? room.perComputerVcpu : 0),
        diskGb:
          fits && freeDisk !== null
            ? Math.max(WORK_MIN_DISK_GB, Math.min(size.diskGb, freeDisk))
            : size.diskGb,
      },
      recommended: size.ramMb === WORK_RECOMMENDED_RAM_MB,
      minimum: size.ramMb === WORK_MIN_RAM_MB,
      block,
    };
  });
}

/** The recommended size when it fits, else the biggest smaller one that does, else -1. */
export function defaultSizeIndex(options: ReadonlyArray<SizeOption>): number {
  const rec = options.findIndex((o) => o.recommended);
  if (rec >= 0 && !options[rec]!.block) return rec;
  for (let i = (rec >= 0 ? rec : options.length) - 1; i >= 0; i -= 1) {
    if (!options[i]!.block) return i;
  }
  return options.findIndex((o) => !o.block);
}

/** The few words under a size that does not fit. */
export function sizeBlockShort(block: SizeBlock, room: PlanRoom | null): string {
  switch (block) {
    case "no_plan":
      return "Needs a plan";
    case "too_big":
      return `Plan max ${formatRam(room?.perComputerMb ?? 0)}`;
    case "no_room":
      return room && room.leftMb > 0 ? `Only ${formatRam(room.leftMb)} left` : "Plan is in use";
    case "disk_full":
      return "Disk is full";
  }
}

/** "Your Plus: 4 GB for computers, 2 GB in use — 2 GB left". Null without a plan. */
export function planRoomLine(room: PlanRoom | null): string | null {
  if (!room || !room.hasPlan || room.totalMb <= 0) return null;
  return `Your ${room.planName}: ${formatRam(room.totalMb)} for computers, ${formatRam(room.inUseMb)} in use — ${formatRam(room.leftMb)} left.`;
}

/**
 * One honest line under the form: what the picked size costs, or — given a
 * size that does not fit (the smallest, when none does) — why, after which the
 * form shows "Change plan".
 */
export function sizeCostLine(room: PlanRoom | null, picked: SizeOption | null): string {
  if (!room) {
    return "Comes out of your Uno plan. Billing in the Uno console shows what's left.";
  }
  if (!room.hasPlan) return "Computers come with an Uno plan. Pick one, then create it here.";
  if (!picked || picked.block) {
    const block = picked?.block ?? "no_room";
    if (block === "too_big") {
      return `Your plan gives up to ${formatRam(room.perComputerMb)} per computer.`;
    }
    if (block === "disk_full") {
      return `Your plan's disk is full: ${room.diskUsedGb} of ${room.diskGb} GB. Delete a computer you don't need, or change plan.`;
    }
    return `${formatRam(room.inUseMb)} of your ${formatRam(room.totalMb)} is running now. Put a computer to sleep, or change plan.`;
  }
  if (room.planView === "trial") return "Included in your trial.";
  if (room.planView === "hours") {
    return `Included in ${room.planName}: it uses the plan's computer hours while it runs, none while asleep.`;
  }
  return `Included in ${room.planName} — nothing extra to pay.`;
}
