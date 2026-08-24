// Minimal 5-field cron parser + `every` duration parser for plugin crons.
//
// Supported cron syntax per field (minute, hour, day-of-month, month,
// day-of-week): `*`, `*/n` steps, single values, lists (`a,b`), ranges
// (`a-b`), stepped ranges (`a-b/n`). Day-of-week accepts 0–7 where both 0 and
// 7 mean Sunday. Matching resolution is one minute, evaluated in local time.

export interface CronSpec {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** `*` in both day fields means "every day"; cron ORs them when both are restricted. */
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

interface FieldRange {
  readonly min: number;
  readonly max: number;
}

const FIELD_RANGES: readonly FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (7 == 0 == Sunday)
];

function parseField(field: string, range: FieldRange): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [body, stepRaw, ...extra] = part.split("/");
    if (extra.length > 0 || body === undefined || body.length === 0) return undefined;
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return undefined;

    let from: number;
    let to: number;
    if (body === "*") {
      from = range.min;
      to = range.max;
    } else if (body.includes("-")) {
      const [fromRaw, toRaw, ...rest] = body.split("-");
      if (rest.length > 0) return undefined;
      from = Number(fromRaw);
      to = Number(toRaw);
    } else {
      from = Number(body);
      to = stepRaw === undefined ? from : range.max;
    }

    if (!Number.isInteger(from) || !Number.isInteger(to)) return undefined;
    if (from < range.min || to > range.max || from > to) return undefined;
    for (let value = from; value <= to; value += step) {
      values.add(value);
    }
  }
  return values.size > 0 ? values : undefined;
}

export function parseCronExpression(expression: string): CronSpec | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;

  const parsed: Set<number>[] = [];
  for (let index = 0; index < 5; index += 1) {
    const values = parseField(fields[index]!, FIELD_RANGES[index]!);
    if (values === undefined) return undefined;
    parsed.push(values);
  }

  const daysOfWeek = parsed[4]!;
  if (daysOfWeek.has(7)) daysOfWeek.add(0);

  return {
    minutes: parsed[0]!,
    hours: parsed[1]!,
    daysOfMonth: parsed[2]!,
    months: parsed[3]!,
    daysOfWeek,
    dayOfMonthRestricted: fields[2] !== "*",
    dayOfWeekRestricted: fields[4] !== "*",
  };
}

export function cronMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.minutes.has(date.getMinutes())) return false;
  if (!spec.hours.has(date.getHours())) return false;
  if (!spec.months.has(date.getMonth() + 1)) return false;

  const dayOfMonthMatches = spec.daysOfMonth.has(date.getDate());
  const dayOfWeekMatches = spec.daysOfWeek.has(date.getDay());
  // Standard cron: when both day fields are restricted the entry fires if
  // either matches; otherwise both must match (an unrestricted field is `*`).
  if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  return dayOfMonthMatches && dayOfWeekMatches;
}

const EVERY_PATTERN = /^(\d+)\s*(s|m|h|d)$/;
const EVERY_UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
export const MIN_EVERY_INTERVAL_MS = 60_000;

/** Parses `"5m"`, `"1h"`, `"30s"`, `"2d"`. Returns ms, clamped to a 1-minute floor. */
export function parseEveryDuration(every: string): number | undefined {
  const match = EVERY_PATTERN.exec(every.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount < 1) return undefined;
  const ms = amount * EVERY_UNIT_MS[match[2]!]!;
  return Math.max(ms, MIN_EVERY_INTERVAL_MS);
}

/** Key identifying the minute a cron `schedule` last fired, to dedupe sweeps. */
export function cronMinuteKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
}
