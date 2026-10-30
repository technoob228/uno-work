/**
 * Reports published with `report_publish`: one protected site per report
 * (`r-<10 chars>`), so a link opens that report and nothing else.
 *
 * This computer keeps the list in `~/.uno/reports.json` (0600: the links are
 * keys): the chat a report came from (its work update carries the link), the
 * source file (Uno's reply naming that file gets the link), the link's expiry.
 *
 * Reports never fill the person's account: `isReportSlug` hides them from
 * Apps & sites and `sites_list`, and past {@link MAX_REPORTS} (or at the
 * account's limit of new sites a day) the oldest report with a dead link gives
 * its slug to the new one: republishing a slug doesn't count as a new site.
 *
 * Never throws on reading: the list is a convenience, not a source of truth.
 *
 * @module sites/reports
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  reportImageRefs,
  reportPageFromHtml,
  reportPageFromMarkdown,
  type ReportImages,
} from "./reportPage.ts";

export interface ReportEntry {
  readonly slug: string;
  readonly threadId: string;
  readonly title: string;
  /** Absolute path of the file it was made from. */
  readonly source: string;
  readonly url: string;
  /** null: the link has no expiry. */
  readonly expiresAtMs: number | null;
  readonly createdAtMs: number;
}

const FILE_NAME = "reports.json";
export const MAX_REPORTS = 100;
const TITLE_MAX = 120;

/** What `report_publish` takes. */
export const REPORT_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGES_MAX_BYTES = 8 * 1024 * 1024;
const REPORT_PAGE_NAME = /\.(md|markdown|txt|html?)$/i;
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const REPORT_SLUG = /^r-[0-9a-z]{10}$/;
const SLUG_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export const isReportSlug = (slug: string): boolean => REPORT_SLUG.test(slug);

const randomChars = (count: number, alphabet: string): string =>
  // A byte divides evenly enough: 256 % 36 skews a character by under 1%.
  Array.from(randomBytes(count), (byte) => alphabet[byte % alphabet.length]).join("");

export const newReportSlug = (): string => `r-${randomChars(10, SLUG_ALPHABET)}`;

/** Never leaves this computer but in the upload: nobody needs to type it. */
export const newReportPassword = (): string => randomBytes(24).toString("base64url");

export const reportsFile = (home: string): string => path.join(home, ".uno", FILE_NAME);

const parseEntry = (raw: unknown): ReportEntry | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const { slug, threadId, title, source, url, expiresAtMs, createdAtMs } = entry;
  if (typeof slug !== "string" || !isReportSlug(slug)) return null;
  if (typeof threadId !== "string" || typeof url !== "string") return null;
  if (typeof createdAtMs !== "number") return null;
  return {
    slug,
    threadId,
    title: typeof title === "string" ? title : "",
    source: typeof source === "string" ? source : "",
    url,
    expiresAtMs: typeof expiresAtMs === "number" ? expiresAtMs : null,
    createdAtMs,
  };
};

/** Oldest first. */
export async function readReports(home: string): Promise<ReadonlyArray<ReportEntry>> {
  try {
    const raw: unknown = JSON.parse(await readFile(reportsFile(home), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      const entry = parseEntry(item);
      return entry === null ? [] : [entry];
    });
  } catch {
    return [];
  }
}

async function write(home: string, entries: ReadonlyArray<ReportEntry>): Promise<void> {
  const file = reportsFile(home);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  } catch (cause) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/** One change at a time: two chats publishing at once must not lose a line. */
let queue: Promise<void> = Promise.resolve();
const inTurn = (change: () => Promise<void>): Promise<void> => {
  const next = queue.then(change, change);
  queue = next.catch(() => undefined);
  return next;
};

/** Adds or replaces the report by its slug. Best effort: a report is up either way. */
export const recordReport = (home: string, entry: ReportEntry): Promise<void> =>
  inTurn(async () => {
    const entries = (await readReports(home)).filter((other) => other.slug !== entry.slug);
    await write(home, [...entries, { ...entry, title: entry.title.slice(0, TITLE_MAX) }]);
  }).catch(() => undefined);

/** A fresh link for a report we know; anything else is left alone. */
export const refreshReportLink = (
  home: string,
  slug: string,
  link: { readonly url: string; readonly expiresAtMs: number | null },
): Promise<void> =>
  inTurn(async () => {
    const entries = await readReports(home);
    if (!entries.some((entry) => entry.slug === slug)) return;
    await write(
      home,
      entries.map((entry) => (entry.slug === slug ? { ...entry, ...link } : entry)),
    );
  }).catch(() => undefined);

const linkIsDead = (entry: ReportEntry, nowMs: number): boolean =>
  entry.expiresAtMs !== null && entry.expiresAtMs <= nowMs;

/**
 * The slug a new report goes to, and the one to fall back on at the account's
 * limit. The same file from the same chat updates its report (same address).
 */
export const pickReportSlug = (
  entries: ReadonlyArray<ReportEntry>,
  input: { readonly threadId: string; readonly source: string; readonly nowMs: number },
  makeSlug: () => string = newReportSlug,
): { readonly slug: string; readonly fallbackSlug: string | undefined } => {
  const same = entries.findLast(
    (entry) => entry.threadId === input.threadId && entry.source === input.source,
  );
  if (same !== undefined) return { slug: same.slug, fallbackSlug: undefined };
  const dead = entries.find((entry) => linkIsDead(entry, input.nowMs))?.slug;
  if (dead !== undefined && entries.length >= MAX_REPORTS) {
    return { slug: dead, fallbackSlug: undefined };
  }
  return { slug: makeSlug(), fallbackSlug: dead };
};

/** The latest report a chat published since `sinceMs`, with a live link. */
export const reportOfThread = (
  entries: ReadonlyArray<ReportEntry>,
  threadId: string,
  input: { readonly sinceMs: number; readonly nowMs: number },
): ReportEntry | null =>
  entries.findLast(
    (entry) =>
      entry.threadId === threadId &&
      entry.createdAtMs >= input.sinceMs &&
      !linkIsDead(entry, input.nowMs),
  ) ?? null;

/** The latest live report of a source file named by its absolute path. */
export const reportOfSource = (
  entries: ReadonlyArray<ReportEntry>,
  source: string,
  nowMs: number,
): ReportEntry | null =>
  entries.findLast((entry) => entry.source === source && !linkIsDead(entry, nowMs)) ?? null;

export const isReportSource = (fileName: string): boolean => REPORT_PAGE_NAME.test(fileName);

/** A readable title from a file name: "WEEKLY-REPORT_2026" → "WEEKLY REPORT 2026". */
const titleFromFileName = (file: string): string =>
  path
    .basename(file)
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim() || "Report";

const readReportImages = async (
  markdown: string,
  sourceDir: string,
  resolve: (file: string) => Promise<string | null>,
): Promise<ReportImages> => {
  const images = new Map<string, string>();
  let total = 0;
  for (const ref of reportImageRefs(markdown)) {
    const type = IMAGE_TYPES[path.extname(ref).toLowerCase()];
    if (type === undefined) continue;
    const file = await resolve(path.resolve(sourceDir, ref));
    if (file === null) continue;
    try {
      const { size } = await stat(file);
      if (size > IMAGE_MAX_BYTES || total + size > IMAGES_MAX_BYTES) continue;
      total += size;
      images.set(ref, `data:${type};base64,${(await readFile(file)).toString("base64")}`);
    } catch {
      // An image that can't be read stays its alt text.
    }
  }
  return images;
};

/**
 * The page of a report file. `resolve` says which files the chat may send
 * (`resolveConnectorOutgoingFile`): an image in a report goes through the same
 * gate as the report, so a `![](~/.ssh/key.png)` never lands on a page.
 */
export const buildReportPage = async (input: {
  readonly file: string;
  readonly title: string | undefined;
  readonly resolve: (file: string) => Promise<string | null>;
}): Promise<{ readonly html: string; readonly title: string }> => {
  const text = await readFile(input.file, "utf8");
  const title = input.title?.trim() || titleFromFileName(input.file);
  if (/\.html?$/i.test(input.file)) {
    const page = reportPageFromHtml({ html: text, title });
    return input.title?.trim() ? { ...page, title } : page;
  }
  const page = reportPageFromMarkdown({
    markdown: text,
    title,
    images: await readReportImages(text, path.dirname(input.file), input.resolve),
  });
  return input.title?.trim() ? { ...page, title } : page;
};
