/**
 * Comment and Debug in the panel's browser (w0138, "как в Codex desktop"):
 * the rules, pure — what a comment is, what the console and network lists
 * keep, and what goes to the chat (a card in the composer and the markdown
 * file behind it that the agent reads).
 */

export interface PageRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One note left on the page: on an element (by its selector) or on an area. */
export interface PageComment {
  readonly id: string;
  /** The pin's number, 1… in the order they were left. */
  readonly n: number;
  readonly kind: "element" | "area";
  /** The element's CSS selector; for an area — null. */
  readonly selector: string | null;
  /** What the person sees on the highlight: `button.cta`, `Area 320×120`. */
  readonly label: string;
  /** The element's own words ("Start free trial"); for an area — the elements inside. */
  readonly text: string | null;
  readonly note: string;
  /** Where it was, in page coordinates (areas are drawn from it; elements fall back to it). */
  readonly docRect: PageRect;
}

export type ConsoleLevel = "error" | "warn" | "info" | "log";

export interface ConsoleEntry {
  readonly id: string;
  readonly level: ConsoleLevel;
  readonly message: string;
  readonly stack: string | null;
  /** `site.js:12` — where it came from, when known. */
  readonly source: string | null;
  readonly at: number;
}

export interface NetworkEntry {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  /** HTTP status; null — the request failed before an answer (offline, blocked, CORS). */
  readonly status: number | null;
  readonly statusText: string;
  readonly type: "fetch" | "xhr" | "img" | "script" | "css" | "other";
  readonly durationMs: number | null;
  readonly requestBody: string | null;
  readonly responseBody: string | null;
  readonly at: number;
}

/** Lists keep the newest this many lines: a chatty page must not eat the app's memory. */
export const PAGE_LOG_CAP = 300;

export function pushCapped<T>(list: ReadonlyArray<T>, item: T, cap = PAGE_LOG_CAP): T[] {
  const next = [...list, item];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** `/pricing` for a page address: no host, no `index.html`, no `.html`. */
export function pagePath(url: string): string {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname.replace(/\/index\.html?$/i, "/").replace(/\.html?$/i, "");
    if (path.length > 1) path = path.replace(/\/$/, "");
    return path || "/";
  } catch {
    return url || "/";
  }
}

export function isFailedRequest(entry: Pick<NetworkEntry, "status">): boolean {
  return entry.status === null || entry.status >= 400;
}

/** The count on the Debug button, even while the panel is closed: errors first, then warnings. */
export function debugBadge(
  console: ReadonlyArray<Pick<ConsoleEntry, "level">>,
  network: ReadonlyArray<Pick<NetworkEntry, "status">>,
): { readonly count: number; readonly tone: "error" | "warn" } | null {
  const errors =
    console.filter((entry) => entry.level === "error").length +
    network.filter(isFailedRequest).length;
  if (errors > 0) return { count: errors, tone: "error" };
  const warnings = console.filter((entry) => entry.level === "warn").length;
  return warnings > 0 ? { count: warnings, tone: "warn" } : null;
}

/** After a comment is removed the pins stay 1, 2, 3 — no gaps. */
export function renumberComments(comments: ReadonlyArray<PageComment>): PageComment[] {
  return comments.map((comment, index) =>
    comment.n === index + 1 ? comment : { ...comment, n: index + 1 },
  );
}

export function commentsTitle(count: number, path: string): string {
  return `${count} ${count === 1 ? "comment" : "comments"} on ${path}`;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

// ── What goes to the chat ────────────────────────────────────────────────

/** The card in the composer (and its expanded list). */
export interface PanelContextCard {
  readonly kind: "comments" | "error" | "request" | "errors";
  readonly title: string;
  /** The page's address. */
  readonly page: string;
  readonly items: ReadonlyArray<{
    readonly marker: string;
    readonly label: string;
    readonly detail: string | null;
    readonly tone?: "error" | "warn";
  }>;
}

/** The card plus the markdown the agent reads (it goes with the message as a file). */
export interface PanelContextPayload {
  readonly card: PanelContextCard;
  readonly fileName: string;
  readonly markdown: string;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "page"
  );
}

function fence(text: string): string {
  return `\`\`\`\n${text.trim()}\n\`\`\``;
}

export function commentsPayload(input: {
  readonly page: string;
  readonly comments: ReadonlyArray<PageComment>;
}): PanelContextPayload {
  const path = pagePath(input.page);
  const title = commentsTitle(input.comments.length, path);
  const lines = [
    `# ${title}`,
    "",
    `Page: ${input.page}`,
    "Left in the browser of Uno Work. Each comment points to an element (CSS selector) or to an area of the page (in page pixels).",
    "",
  ];
  for (const comment of input.comments) {
    const where =
      comment.kind === "element"
        ? `\`${comment.selector ?? comment.label}\`${comment.text ? ` — “${comment.text}”` : ""}`
        : `Area ${Math.round(comment.docRect.w)}×${Math.round(comment.docRect.h)} at (${Math.round(comment.docRect.x)}, ${Math.round(comment.docRect.y)})${comment.text ? ` — contains ${comment.text}` : ""}`;
    lines.push(`${comment.n}. ${where}`, `   ${comment.note.trim().replace(/\n/g, "\n   ")}`, "");
  }
  return {
    card: {
      kind: "comments",
      title,
      page: input.page,
      items: input.comments.map((comment) => ({
        marker: String(comment.n),
        label: comment.note.trim() || "(no note)",
        detail: comment.kind === "element" ? (comment.selector ?? comment.label) : comment.label,
      })),
    },
    fileName: `comments-${slug(path)}.md`,
    markdown: lines.join("\n"),
  };
}

function consoleBlock(entry: ConsoleEntry): string {
  const head = `${entry.level === "warn" ? "Warning" : entry.level === "error" ? "Error" : "Log"}${entry.source ? ` (${entry.source})` : ""}`;
  return `${head}\n\n${fence(entry.stack && !entry.stack.includes(entry.message) ? `${entry.message}\n${entry.stack}` : (entry.stack ?? entry.message))}`;
}

function requestBlock(entry: NetworkEntry): string {
  const status =
    entry.status === null ? "failed, no answer" : `${entry.status} ${entry.statusText}`.trim();
  const parts = [
    `${entry.method} ${entry.url} → ${status}${entry.durationMs !== null ? ` in ${Math.round(entry.durationMs)} ms` : ""}`,
  ];
  if (entry.requestBody) parts.push("", "Request body:", fence(entry.requestBody));
  if (entry.responseBody) parts.push("", "Response:", fence(entry.responseBody));
  return parts.join("\n");
}

/** "Ask agent to fix" on one console line. */
export function consolePayload(input: {
  readonly page: string;
  readonly entry: ConsoleEntry;
}): PanelContextPayload {
  const path = pagePath(input.page);
  const word = input.entry.level === "warn" ? "Warning" : "Error";
  return {
    card: {
      kind: "error",
      title: `${word} on ${path}`,
      page: input.page,
      items: [
        {
          marker: word,
          label: input.entry.message,
          detail: input.entry.source,
          tone: input.entry.level === "warn" ? "warn" : "error",
        },
      ],
    },
    fileName: `console-${slug(path)}.md`,
    markdown: [
      `# ${word} in the console of ${path}`,
      "",
      `Page: ${input.page}`,
      "",
      consoleBlock(input.entry),
    ].join("\n"),
  };
}

/** "Ask agent to fix" on one request. */
export function requestPayload(input: {
  readonly page: string;
  readonly entry: NetworkEntry;
}): PanelContextPayload {
  const path = shortUrl(input.entry.url);
  const status = input.entry.status === null ? "failed" : String(input.entry.status);
  return {
    card: {
      kind: "request",
      title: `${input.entry.method} ${path} · ${status}`,
      page: input.page,
      items: [
        {
          marker: status,
          label: `${input.entry.method} ${path}`,
          detail: input.entry.responseBody ? input.entry.responseBody.slice(0, 160) : null,
          tone: "error",
        },
      ],
    },
    fileName: `request-${slug(path)}.md`,
    markdown: [
      `# A request of ${pagePath(input.page)} failed`,
      "",
      `Page: ${input.page}`,
      "",
      requestBlock(input.entry),
    ].join("\n"),
  };
}

/** "Send all errors": every error and warning of the console and every failed request. */
export function allErrorsPayload(input: {
  readonly page: string;
  readonly console: ReadonlyArray<ConsoleEntry>;
  readonly network: ReadonlyArray<NetworkEntry>;
}): PanelContextPayload | null {
  const problems = input.console.filter((entry) => entry.level === "error" || entry.level === "warn");
  const failed = input.network.filter(isFailedRequest);
  const count = problems.length + failed.length;
  if (count === 0) return null;
  const path = pagePath(input.page);
  const title = `${count} ${count === 1 ? "problem" : "problems"} on ${path}`;
  const sections = [`# ${title}`, "", `Page: ${input.page}`, ""];
  if (problems.length > 0) {
    sections.push("## Console", "");
    for (const entry of problems) sections.push(consoleBlock(entry), "");
  }
  if (failed.length > 0) {
    sections.push("## Network", "");
    for (const entry of failed) sections.push(requestBlock(entry), "");
  }
  return {
    card: {
      kind: "errors",
      title,
      page: input.page,
      items: [
        ...problems.map((entry) => ({
          marker: entry.level === "warn" ? "Warning" : "Error",
          label: entry.message,
          detail: entry.source,
          tone: (entry.level === "warn" ? "warn" : "error") as "warn" | "error",
        })),
        ...failed.map((entry) => ({
          marker: entry.status === null ? "Failed" : String(entry.status),
          label: `${entry.method} ${shortUrl(entry.url)}`,
          detail: entry.responseBody ? entry.responseBody.slice(0, 160) : null,
          tone: "error" as const,
        })),
      ],
    },
    fileName: `problems-${slug(path)}.md`,
    markdown: sections.join("\n"),
  };
}

/** "120 ms", "1.4 s". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
