/**
 * `POST /v1/notify` of the App API — an app tells the person something
 * ("Boris commented on report.docx", "Backup finished"). The item lands in
 * the Inbox of Uno Work (and, if the person allowed it, as a system
 * notification). Pure half: the body, the "Open" target and the rate limit.
 *
 * Needs `"notify": true` in the app's manifest (docs/app-sdk.md).
 */
import type { InboxOpenTarget } from "@t3tools/contracts";
import path from "node:path";

export const NOTIFY_TITLE_MAX = 140;
export const NOTIFY_BODY_MAX = 500;
export const NOTIFY_GROUP_MAX = 100;
/** Burst an app may send at once … */
export const NOTIFY_BURST = 10;
/** … refilled one every this many ms (6 a minute sustained) … */
export const NOTIFY_REFILL_MS = 10_000;
/** … and at most this many a day. */
export const NOTIFY_DAILY_MAX = 200;

export interface ParsedNotify {
  readonly title: string;
  readonly body: string | null;
  readonly open: InboxOpenTarget | null;
  /** Same group while unread → one item that updates instead of many. */
  readonly group: string | null;
}

export type NotifyParse =
  | { readonly ok: true; readonly value: ParsedNotify }
  | { readonly ok: false; readonly message: string };

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** `~/x` or an absolute path, inside home; null otherwise. */
export function resolveNotifyFile(raw: string, home: string): string | null {
  const expanded =
    raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw.trim();
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  const root = path.resolve(home);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && raw.length <= 2048;
  } catch {
    return false;
  }
}

/** A path inside the app (`/notes/42`); null when it isn't one. */
function appPath(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value === "") return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.length > 1024) return undefined;
  return value;
}

export function parseNotifyOpen(
  raw: unknown,
  input: { readonly appId: string; readonly home: string },
): { readonly ok: true; readonly open: InboxOpenTarget | null } | { readonly ok: false } {
  if (raw === undefined || raw === null) return { ok: true, open: null };
  if (typeof raw === "string") {
    const value = raw.trim();
    if (isHttpUrl(value)) return { ok: true, open: { kind: "url", url: value } };
    const file = resolveNotifyFile(value, input.home);
    return file ? { ok: true, open: { kind: "file", path: file } } : { ok: false };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const record = raw as Record<string, unknown>;
  const file = text(record["file"]);
  if (file !== null) {
    const resolved = resolveNotifyFile(file, input.home);
    return resolved ? { ok: true, open: { kind: "file", path: resolved } } : { ok: false };
  }
  const url = text(record["url"]);
  if (url !== null) {
    return isHttpUrl(url) ? { ok: true, open: { kind: "url", url } } : { ok: false };
  }
  // The app itself (optionally at a path of it). Only its own id: an app
  // can't make the person open another app.
  const app = record["app"];
  if (app === true || app === input.appId || (app === undefined && "path" in record)) {
    const where = appPath(record["path"]);
    if (where === undefined) return { ok: false };
    return { ok: true, open: { kind: "app", appId: input.appId, path: where } };
  }
  return { ok: false };
}

export function parseNotifyBody(
  body: unknown,
  input: { readonly appId: string; readonly home: string },
): NotifyParse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: 'Expected a JSON object like {"title": "…"}.' };
  }
  const record = body as Record<string, unknown>;
  const title = text(record["title"]);
  if (title === null) return { ok: false, message: '"title" is required.' };
  if (title.length > NOTIFY_TITLE_MAX) {
    return { ok: false, message: `"title" is at most ${NOTIFY_TITLE_MAX} characters.` };
  }
  const bodyText = text(record["body"]) ?? text(record["text"]);
  if (bodyText !== null && bodyText.length > NOTIFY_BODY_MAX) {
    return { ok: false, message: `"body" is at most ${NOTIFY_BODY_MAX} characters.` };
  }
  const open = parseNotifyOpen(record["open"], input);
  if (!open.ok) {
    return {
      ok: false,
      message:
        '"open" must be {"file": "~/…"} (inside home), {"url": "https://…"} or {"app": true, "path": "/…"}.',
    };
  }
  const group = text(record["group"]);
  if (group !== null && group.length > NOTIFY_GROUP_MAX) {
    return { ok: false, message: `"group" is at most ${NOTIFY_GROUP_MAX} characters.` };
  }
  return { ok: true, value: { title, body: bodyText, open: open.open, group } };
}

/** Token bucket per app, plus a daily ceiling. */
export function makeNotifyLimiter(now: () => number = Date.now) {
  const buckets = new Map<string, { tokens: number; at: number; day: string; today: number }>();
  return {
    /** `null` = allowed (and counted); a number = seconds to wait. */
    take(appId: string): number | null {
      const at = now();
      const day = new Date(at).toISOString().slice(0, 10);
      const bucket = buckets.get(appId) ?? { tokens: NOTIFY_BURST, at, day, today: 0 };
      bucket.tokens = Math.min(NOTIFY_BURST, bucket.tokens + (at - bucket.at) / NOTIFY_REFILL_MS);
      bucket.at = at;
      if (bucket.day !== day) {
        bucket.day = day;
        bucket.today = 0;
      }
      buckets.set(appId, bucket);
      if (bucket.today >= NOTIFY_DAILY_MAX) {
        const midnight = Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60_000;
        return Math.max(1, Math.ceil((midnight - at) / 1000));
      }
      if (bucket.tokens < 1) {
        return Math.max(1, Math.ceil(((1 - bucket.tokens) * NOTIFY_REFILL_MS) / 1000));
      }
      bucket.tokens -= 1;
      bucket.today += 1;
      return null;
    },
  };
}
