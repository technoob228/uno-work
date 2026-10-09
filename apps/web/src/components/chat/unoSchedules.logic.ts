/**
 * One line per schedule of Uno, for the strip under its chat header:
 * "Every day at 09:00 · Morning plan", "Paused" when it is.
 */
import { describeCron } from "../assistants/assistantTemplates";

export interface UnoScheduleLineInput {
  readonly name: string;
  readonly cron: string;
  readonly timezone: string | null;
  readonly prompt: string;
  readonly state: string | null;
}

export interface UnoScheduleLine {
  /** "Every day at 09:00" (+ the schedule's city when it isn't the browser's zone). */
  readonly when: string;
  /** The name the person sees; the instruction when the name is empty. */
  readonly what: string;
  readonly paused: boolean;
}

function cityOf(timezone: string): string {
  return (timezone.split("/").at(-1) ?? timezone).replaceAll("_", " ");
}

export function unoScheduleLine(
  schedule: UnoScheduleLineInput,
  browserTimezone: string | null,
): UnoScheduleLine {
  const zone = schedule.timezone?.trim() || "UTC";
  const local = browserTimezone?.trim() || "UTC";
  const when = describeCron(schedule.cron);
  const name = schedule.name.trim();
  const prompt = schedule.prompt.replace(/\s+/g, " ").trim();
  return {
    // Aliases count as the same zone (Chromium says America/Buenos_Aires for
    // America/Argentina/Buenos_Aires).
    when:
      zone === local || cityOf(zone) === cityOf(local) ? when : `${when} (${cityOf(zone)} time)`,
    what: name || (prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt),
    paused: schedule.state === "paused",
  };
}
