/**
 * Machine class (Misha 19.11): `performance | standard` is a plan resource.
 * Performance comes only with Max, and there new computers are Performance
 * unless the account picked Standard; every other plan is Standard.
 *
 * The console says which class a new computer gets
 * (`GET /api/v1/account/machine-class`); `enabled: false` (or no answer at
 * all, e.g. an older console) hides the choice everywhere. A create call sends
 * `class` only when the person changed it from `effective`, so the console's
 * own default stays the one rule.
 *
 * Pure (no React): the texts, the parser and the error codes are shared by
 * the create form, the error notices and the demo.
 */
import type { UnoMachineClass } from "@t3tools/contracts";
import { parseUnoMachineClass } from "@t3tools/shared/unoCloud";

import { CONSOLE_URL } from "./consoleUrl";

export interface MachineClassSettings {
  readonly enabled: boolean;
  /** The class a new computer gets when the person doesn't choose. */
  readonly effective: UnoMachineClass;
  /** The plan includes Performance (Max). */
  readonly performanceIncluded: boolean;
}

export function parseMachineClassSettings(raw: unknown): MachineClassSettings | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const effective = parseUnoMachineClass(record["effective"]);
  if (!effective) return null;
  return {
    enabled: record["enabled"] === true,
    effective,
    performanceIncluded: record["performance_included"] === true,
  };
}

export const MACHINE_CLASS_OPTIONS: ReadonlyArray<{
  readonly id: UnoMachineClass;
  readonly title: string;
  readonly detail: string;
}> = [
  {
    id: "performance",
    title: "Performance",
    detail: "Newest-generation AMD CPUs, fewer machines per server. Included with Max.",
  },
  { id: "standard", title: "Standard", detail: "Our regular servers. Every plan." },
];

export const PERFORMANCE_LOCKED_TEXT = "Comes with Max";
export const SEE_MAX_TEXT = "See Max";
export const CLASS_NOTICE_TEXT = "Performance servers were busy, so this computer is Standard.";
export const PERFORMANCE_REQUIRES_MAX_TEXT =
  "Performance computers come with the Max plan. Create a Standard one or switch to Max.";
export const PERFORMANCE_NO_CAPACITY_TEXT =
  "All Performance servers are busy. Try again in a few minutes, or create a Standard computer.";

/** The Max plan on the console's Billing page (no checkout: the person decides there). */
export const MAX_PLAN_URL = `${CONSOLE_URL}/billing?tab=plan&plan=max`;

/** What the form shows as chosen: the person's pick, else the account's own. */
export function shownMachineClass(
  picked: UnoMachineClass | null,
  settings: MachineClassSettings,
): UnoMachineClass {
  const value = picked ?? settings.effective;
  return value === "performance" && !settings.performanceIncluded ? "standard" : value;
}

/** `class` for the create call: only when the person changed it from `effective`. */
export function machineClassToSend(
  picked: UnoMachineClass | null,
  settings: MachineClassSettings | null,
): UnoMachineClass | undefined {
  if (!settings?.enabled || picked === null) return undefined;
  const shown = shownMachineClass(picked, settings);
  return shown === settings.effective ? undefined : shown;
}

export type MachineClassErrorCode = "PERFORMANCE_REQUIRES_MAX" | "PERFORMANCE_NO_CAPACITY";

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

/** The console refused the class (403 / 503 with these codes inside the error text). */
export function machineClassErrorCode(error: unknown): MachineClassErrorCode | null {
  const raw = errorText(error);
  if (raw.includes("PERFORMANCE_REQUIRES_MAX")) return "PERFORMANCE_REQUIRES_MAX";
  if (raw.includes("PERFORMANCE_NO_CAPACITY")) return "PERFORMANCE_NO_CAPACITY";
  return null;
}

/** `upgrade_url` of a 403 when it survived the error text, else the Max plan on Billing. */
export function machineClassUpgradeUrl(error: unknown): string {
  const match = /"upgrade_url"\s*:\s*"(https:\/\/[^"\s]+)"/.exec(errorText(error));
  return match?.[1] ?? MAX_PLAN_URL;
}
