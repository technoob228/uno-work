/**
 * The update channel this daemon is on, for the client (`environment.channel`):
 * Misha's stage computer (stage-work, 16.10) gets its updates from
 * `https://console.uno.place/cli/work/stage`, so the new work waiting for his
 * yes is on there by default (web `unoChannel.ts` + Labs `stageDefault`).
 *
 * - `UNO_WORK_CHANNEL=<name>` says it outright (the "Uno Work Stage" desktop
 *   app sets it for its own daemon);
 * - otherwise the last segment of `UNO_WORK_UPDATE_BASE_URL` under `/cli/work/`
 *   (`…/cli/work/stage` → "stage", `…/cli/work/canary` → "canary");
 * - the release address (`…/cli/work`) or none — no channel: the release.
 *
 * Display only: nothing here decides what gets installed.
 */
import { SELF_UPDATE_BASE_URL_ENV } from "../selfUpdate.ts";

export const UNO_WORK_CHANNEL_ENV = "UNO_WORK_CHANNEL";

const CHANNEL_NAME = /^[a-z][a-z0-9-]{0,20}$/;

export function resolveUpdateChannel(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const explicit = env[UNO_WORK_CHANNEL_ENV]?.trim().toLowerCase();
  if (explicit) return CHANNEL_NAME.test(explicit) ? explicit : undefined;
  const base = env[SELF_UPDATE_BASE_URL_ENV]?.trim();
  if (!base) return undefined;
  try {
    const segments = new URL(base).pathname.split("/").filter(Boolean);
    const at = segments.lastIndexOf("work");
    if (at < 1 || segments[at - 1] !== "cli" || at !== segments.length - 2) return undefined;
    const name = segments[at + 1]!.toLowerCase();
    return CHANNEL_NAME.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}
