/**
 * How long ago a chat was last active, for the end of its sidebar row
 * (T3 port 30.10, like upstream `RelativeTimeLabel` in SidebarThreadRow):
 * "now", "5m", "2h", "3d", then the date — "Oct 12" this year, "Oct 2025"
 * before. Replaces the Today / Yesterday / This week / Older groups: the list
 * is one run by freshness and every row says its own age.
 *
 * `timeMs` is the time the list is sorted by, so the labels never go back up
 * while reading down. Unknown times give "" (the row shows nothing).
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Under a week the age reads in days; from then on, the date. */
const DAYS_BEFORE_DATE = 7;

const SAME_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const OTHER_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" });

export function chatAgeLabel(timeMs: number, nowMs: number): string {
  if (!Number.isFinite(timeMs) || !Number.isFinite(nowMs)) return "";
  // A clock a little ahead on the computer: still "now", never "-2m".
  const elapsed = Math.max(0, nowMs - timeMs);
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  const days = Math.floor(elapsed / DAY_MS);
  if (days < DAYS_BEFORE_DATE) return `${days}d`;
  const date = new Date(timeMs);
  return date.getFullYear() === new Date(nowMs).getFullYear()
    ? SAME_YEAR.format(date)
    : OTHER_YEAR.format(date);
}

/** What the label's tooltip says: the exact moment, in the person's own format. */
export function chatAgeTitle(timeMs: number): string | undefined {
  if (!Number.isFinite(timeMs)) return undefined;
  return `Last activity ${new Date(timeMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}
