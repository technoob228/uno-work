/**
 * "Add memory / cores" — resize this computer within its plan.
 *
 * The control plane is the only judge: `POST /api/v1/boxes/{id}/resize`
 * checks the plan's biggest computer, the account peak, the disk quota and the
 * account's own budget guard, and answers 409 with a code when one says no.
 * This module only
 *
 *   - reads the same limits (`GET /boxes/{id}` + `GET /box-subscription`) to
 *     offer sizes that can work, and
 *   - turns a refusal into words and the numbers a person needs ("your plan
 *     goes up to 8 GB" + Upgrade plan).
 *
 * Kept free of Effect so tests drive it with recorded payloads.
 */
import {
  UNO_CONTROL_PLANE_BASE_URL,
  type UnoComputerResizeOptions,
  type UnoComputerResizeResult,
  type UnoComputerShape,
} from "@t3tools/contracts";

import { controlPlaneErrorStatus } from "./unoCloudParse.ts";
import {
  NOT_LINKED_MESSAGE,
  NO_COMPUTER_MESSAGE,
  classifyFailure,
  humanizeControlPlaneError,
  type UnoComputerClientContext,
} from "./unoComputer.ts";
import { fetchControlPlaneJson } from "./unoCloudParse.ts";

/** Same step and floors as the control plane (box/plans.go). */
export const RAM_STEP_MB = 256;
const MIN_RAM_MB = 512;

export const UPGRADE_URL = `${UNO_CONTROL_PLANE_BASE_URL}/billing`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function floorStep(mb: number): number {
  return Math.floor(mb / RAM_STEP_MB) * RAM_STEP_MB;
}

function prettyPlan(slug: string | null): string | null {
  if (!slug) return null;
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

export interface ResizeLimits {
  readonly current: UnoComputerShape;
  readonly max: UnoComputerShape;
  readonly planMax: UnoComputerShape;
  readonly planName: string | null;
}

/**
 * The largest this computer can be right now:
 *   RAM / cores — the plan's biggest computer, and (while it runs) what the
 *                 account peak leaves after everything else that runs;
 *   disk        — the plan's disk minus the other computers' disks.
 * Never below the current size: the dialog only offers growth.
 */
export function computeResizeLimits(boxRaw: unknown, subRaw: unknown): ResizeLimits | null {
  const box = asRecord(boxRaw);
  const sub = asRecord(subRaw);
  if (!box) return null;
  const current = {
    ramMb: num(box["ram_mb"]) ?? 0,
    vcpu: num(box["vcpu"]) ?? 0,
    diskGb: num(box["disk_gb"]) ?? 0,
  };
  if (current.ramMb <= 0 || current.vcpu <= 0) return null;
  const limits = asRecord(sub?.["plan_limits"]);
  const maxBox = asRecord(limits?.["max_box"]);
  const peak = asRecord(limits?.["peak"]);
  const usage = asRecord(sub?.["usage"]);
  const planMax = {
    ramMb: num(maxBox?.["ram_mb"]) ?? current.ramMb,
    vcpu: num(maxBox?.["vcpu"]) ?? current.vcpu,
    diskGb: num(limits?.["disk_gb"]) ?? current.diskGb,
  };
  const running = String(box["status"] ?? "") === "running";
  let ramMax = planMax.ramMb;
  let vcpuMax = planMax.vcpu;
  const peakRam = num(peak?.["ram_mb"]);
  const peakVcpu = num(peak?.["vcpu"]);
  if (running) {
    // usage.running_* already counts this computer.
    const others = {
      ram: (num(usage?.["running_ram_mb"]) ?? current.ramMb) - current.ramMb,
      vcpu: (num(usage?.["running_vcpu"]) ?? current.vcpu) - current.vcpu,
    };
    if (peakRam !== null) ramMax = Math.min(ramMax, peakRam - others.ram);
    if (peakVcpu !== null) vcpuMax = Math.min(vcpuMax, peakVcpu - others.vcpu);
  }
  const diskUsed = num(usage?.["disk_gb_used"]);
  const diskMax = diskUsed !== null ? planMax.diskGb - (diskUsed - current.diskGb) : planMax.diskGb;
  return {
    current,
    max: {
      ramMb: Math.max(current.ramMb, floorStep(Math.max(MIN_RAM_MB, ramMax))),
      vcpu: Math.max(current.vcpu, Math.floor(vcpuMax)),
      diskGb: Math.max(current.diskGb, Math.floor(diskMax)),
    },
    planMax,
    planName: prettyPlan(typeof sub?.["plan"] === "string" ? sub["plan"] : null),
  };
}

function emptyOptions(
  availability: UnoComputerResizeOptions["availability"],
  message: string | null,
): UnoComputerResizeOptions {
  return {
    availability,
    message,
    current: null,
    max: null,
    planMax: null,
    planName: null,
    ramStepMb: RAM_STEP_MB,
    upgradeUrl: UPGRADE_URL,
    canResize: false,
  };
}

function bind(ctx: UnoComputerClientContext) {
  const apiKey = ctx.apiKey.trim();
  if (apiKey.length === 0) return null;
  const fetchJson = ctx.fetchJson ?? fetchControlPlaneJson;
  return (path: string, init?: RequestInit) => fetchJson(apiKey, path, init);
}

export async function readResizeOptions(
  ctx: UnoComputerClientContext & { readonly boxId: number | null },
): Promise<UnoComputerResizeOptions> {
  const request = bind(ctx);
  if (!request) return emptyOptions("error", NOT_LINKED_MESSAGE);
  if (ctx.boxId === null) return emptyOptions("error", NO_COMPUTER_MESSAGE);
  const [boxResult, subResult] = await Promise.allSettled([
    request(`/api/v1/boxes/${ctx.boxId}`),
    request("/api/v1/box-subscription"),
  ]);
  if (boxResult.status === "rejected") {
    const failure = classifyFailure(boxResult.reason);
    return emptyOptions(failure.availability, failure.message);
  }
  const limits = computeResizeLimits(
    boxResult.value,
    subResult.status === "fulfilled" ? subResult.value : null,
  );
  if (!limits) return emptyOptions("error", "Uno didn't say how big this computer is.");
  return {
    availability: "ok",
    message: null,
    current: limits.current,
    max: limits.max,
    planMax: limits.planMax,
    planName: limits.planName,
    ramStepMb: RAM_STEP_MB,
    upgradeUrl: UPGRADE_URL,
    canResize: true,
  };
}

const PLAN_LIMIT_CODES = [
  "PEAK_EXCEEDED",
  "SHAPE_TOO_LARGE",
  "DISK_QUOTA_EXCEEDED",
  "POOL_EXHAUSTED",
];

export class ResizeActionError extends Error {}

/** What a refusal means for a person. `null` → not a known refusal. */
export function classifyResizeRefusal(
  cause: unknown,
): Pick<UnoComputerResizeResult, "outcome" | "message"> | null {
  const status = controlPlaneErrorStatus(cause);
  const text = cause instanceof Error ? cause.message : String(cause);
  if (status === 409 || status === 400) {
    const code = PLAN_LIMIT_CODES.find((c) => text.includes(c));
    if (code === "POOL_EXHAUSTED") {
      return {
        outcome: "plan_limit",
        message: "This month's computer hours on your plan are used up.",
      };
    }
    if (code === "PEAK_EXCEEDED") {
      return {
        outcome: "plan_limit",
        message:
          "Your plan doesn't allow that much running at once — together with your other computers that are on.",
      };
    }
    if (code) return { outcome: "plan_limit", message: "Your plan doesn't go that big." };
    if (text.includes("BUDGET_GUARD")) {
      return {
        outcome: "guard",
        message:
          "Your own spending limit in the Uno console stopped this. Raise it there, or pick a smaller size.",
      };
    }
    if (text.includes("BOX_BUSY")) {
      return {
        outcome: "busy",
        message: "The computer is starting or going to sleep. Try again in a moment.",
      };
    }
  }
  return null;
}

export async function resizeComputer(
  ctx: UnoComputerClientContext & {
    readonly boxId: number | null;
    readonly shape: UnoComputerShape;
  },
): Promise<UnoComputerResizeResult> {
  const request = bind(ctx);
  if (!request) throw new ResizeActionError(NOT_LINKED_MESSAGE);
  if (ctx.boxId === null) throw new ResizeActionError(NO_COMPUTER_MESSAGE);
  const base = { upgradeUrl: UPGRADE_URL };
  try {
    const raw = asRecord(
      await request(`/api/v1/boxes/${ctx.boxId}/resize`, {
        method: "POST",
        body: JSON.stringify({
          ram_mb: ctx.shape.ramMb,
          vcpu: ctx.shape.vcpu,
          disk_gb: ctx.shape.diskGb,
        }),
      }),
    );
    return {
      ...base,
      outcome: "resized",
      message: "Done.",
      shape: {
        ramMb: num(raw?.["ram_mb"]) ?? ctx.shape.ramMb,
        vcpu: num(raw?.["vcpu"]) ?? ctx.shape.vcpu,
        diskGb: num(raw?.["disk_gb"]) ?? ctx.shape.diskGb,
      },
      limit: null,
      planName: null,
    };
  } catch (cause) {
    const refusal = classifyResizeRefusal(cause);
    if (refusal) {
      // The numbers for "your plan goes up to …", read fresh.
      const options =
        refusal.outcome === "plan_limit" ? await readResizeOptions(ctx).catch(() => null) : null;
      return {
        ...base,
        ...refusal,
        shape: null,
        limit: options?.planMax ?? null,
        planName: options?.planName ?? null,
      };
    }
    const text = cause instanceof Error ? cause.message : String(cause);
    if (text.includes("WORK_MACHINE_TOKEN_RESTRICTED")) {
      throw new ResizeActionError(
        "This computer's key is older than the resize button. Open this computer once from the Uno console to refresh it, or change the size there.",
      );
    }
    if (controlPlaneErrorStatus(cause) === 403) {
      throw new ResizeActionError("This computer's key isn't allowed to change its size.");
    }
    throw new ResizeActionError(humanizeControlPlaneError(cause));
  }
}
