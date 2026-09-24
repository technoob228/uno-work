/**
 * Pure helpers for Home's greeting and its "Uno AI spend" widget:
 *
 * - the person's first name, from what the client already knows (the Uno
 *   account, the computer's user) — only when it looks like a name;
 * - a day-by-day spend from the running Uno AI total the daemon samples
 *   (see the server's `aiSpendLedger.ts`), cut at the person's own midnight.
 */

// ------------------------------------------------------------------ name --

/** Words that are account or machine names, not a person's. */
const NOT_A_NAME = new Set([
  "admin",
  "administrator",
  "app",
  "apps",
  "azureuser",
  "billing",
  "box",
  "codespace",
  "contact",
  "debian",
  "default",
  "demo",
  "dev",
  "developer",
  "devops",
  "ec",
  "email",
  "guest",
  "hello",
  "hi",
  "home",
  "info",
  "jobs",
  "mail",
  "me",
  "node",
  "noreply",
  "office",
  "ops",
  "owner",
  "pi",
  "root",
  "runner",
  "sales",
  "service",
  "support",
  "sysadmin",
  "team",
  "test",
  "ubuntu",
  "uno",
  "user",
  "users",
  "vscode",
  "work",
  "www",
]);

const NAME_WORD = /^\p{L}{2,20}$/u;

function capitalize(word: string): string {
  return word.charAt(0).toLocaleUpperCase() + word.slice(1);
}

/** "mikhail", "mikhail.t", "Mikhail_T" → "Mikhail"; "shubaduba4th", "admin" → null. */
export function nameFromHandle(handle: string | null | undefined): string | null {
  const first = (handle ?? "").trim().split(/[._\-+\s]+/)[0] ?? "";
  if (!NAME_WORD.test(first)) return null;
  const lower = first.toLocaleLowerCase();
  if (NOT_A_NAME.has(lower)) return null;
  return capitalize(lower);
}

/** "Mikhail Torgashin" → "Mikhail" (as the person wrote it). */
function firstWordOfName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  if (!NAME_WORD.test(first) || NOT_A_NAME.has(first.toLocaleLowerCase())) return null;
  return first === first.toLocaleLowerCase() ? capitalize(first) : first;
}

/** The last folder of a home path: `/Users/mikhail` → `mikhail`. */
export function homeFolderUser(homePath: string | null | undefined): string | null {
  const parts = (homePath ?? "").replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length > 1 ? (parts.at(-1) ?? null) : null;
}

/**
 * Who to greet: the account's name when it has one, else a username or the
 * computer's user that reads as a first name, else the email's local part if
 * it does. Nothing → greet without a name.
 */
export function personFirstName(input: {
  readonly accountName?: string | null;
  readonly username?: string | null;
  readonly osUser?: string | null;
  readonly email?: string | null;
}): string | null {
  return (
    firstWordOfName(input.accountName) ??
    nameFromHandle(input.username) ??
    nameFromHandle(input.osUser) ??
    nameFromHandle(input.email?.split("@")[0]) ??
    null
  );
}

// --------------------------------------------------------------- AI spend --

export interface SpendSample {
  readonly at: string;
  readonly totalUsd: number;
}

export interface SpendDay {
  /** Local midnight that starts the day (ms). */
  readonly start: number;
  readonly today: boolean;
  /** Null: this computer didn't see the day. */
  readonly usd: number | null;
  /**
   * Set when only part of the day was seen (the first reading came during
   * it): the spend is from this time on.
   */
  readonly since: number | null;
}

/** A reading older than this before midnight can't stand for the total at midnight. */
export const SPEND_BASELINE_MAX_GAP_MS = 6 * 60 * 60_000;

function localMidnight(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addLocalDays(midnight: number, days: number): number {
  const date = new Date(midnight);
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * The last `count` days (oldest first, today last), each with how much the
 * running total grew over it, in the local time zone.
 */
export function aiSpendDays(
  rawSamples: ReadonlyArray<SpendSample>,
  now: number,
  count = 7,
): SpendDay[] {
  const samples = rawSamples
    .map((sample) => ({ at: Date.parse(sample.at), total: sample.totalUsd }))
    .filter((sample) => Number.isFinite(sample.at) && Number.isFinite(sample.total))
    .toSorted((a, b) => a.at - b.at);
  const lastAtOrBefore = (t: number) => samples.findLast((sample) => sample.at <= t) ?? null;
  const today = localMidnight(now);
  const days: SpendDay[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const start = addLocalDays(today, -offset);
    const end = Math.min(addLocalDays(start, 1), now);
    const lastReading = lastAtOrBefore(end);
    // The day's last reading stands for its end if it's close to midnight, or
    // if the next reading shows nothing was spent in between.
    const nextReading = samples.find((sample) => sample.at > end);
    const atEnd =
      lastReading &&
      (offset === 0 ||
        end - lastReading.at <= SPEND_BASELINE_MAX_GAP_MS ||
        nextReading?.total === lastReading.total)
        ? lastReading
        : null;
    const base = lastAtOrBefore(start);
    let usd: number | null = null;
    let since: number | null = null;
    if (atEnd && base && start - base.at <= SPEND_BASELINE_MAX_GAP_MS) {
      usd = atEnd.total - base.total;
    } else {
      const first = samples.find((sample) => sample.at >= start && sample.at < end);
      if (first && atEnd) {
        usd = atEnd.total - first.total;
        since = first.at;
      }
    }
    days.push({
      start,
      today: offset === 0,
      usd: usd === null ? null : Math.max(0, usd),
      since,
    });
  }
  return days;
}

export function formatUsdShort(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
