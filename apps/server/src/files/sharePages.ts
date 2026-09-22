/**
 * The pages a visitor sees at `/s/<token>`: the file card (preview +
 * download), a shared folder's listing, the password prompt, and the "link
 * doesn't work" page. Plain server-rendered HTML with inline CSS and no
 * scripts at all; every value from the disk (names) is escaped.
 *
 * @module files/sharePages
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Path segment for a URL: keeps the name readable, escapes the rest. */
export function encodeSegment(name: string): string {
  return encodeURIComponent(name);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** What the page can show inline for a file, decided by its content type. */
export type SharePreviewKind = "image" | "pdf" | "video" | "audio" | "html" | "text" | "none";

export function sharePreviewKind(contentType: string, size: number): SharePreviewKind {
  if (contentType.startsWith("image/")) return "image";
  if (contentType === "application/pdf") return "pdf";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType === "text/html") return "html";
  if (isTextualContentType(contentType)) return size <= TEXT_PREVIEW_MAX_BYTES ? "text" : "none";
  return "none";
}

export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;

export function isTextualContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/xml" ||
    contentType === "application/javascript" ||
    contentType === "application/x-sh" ||
    contentType === "application/yaml" ||
    contentType === "application/toml"
  );
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--fg:#1b1b1a;--muted:#6f6f6b;--line:#e4e4e0;--accent:#2b59ff;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1c1c1c;--fg:#ededeb;--muted:#9a9a96;--line:#2c2c2b;--accent:#6d8cff;--accent-fg:#0b0b0b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 20px 48px}
.brand{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px;margin-bottom:20px}
.brand b{display:inline-flex;width:22px;height:22px;border-radius:7px;background:var(--fg);color:var(--bg);align-items:center;justify-content:center;font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;overflow:hidden}
.head{display:flex;align-items:center;gap:14px;padding:20px 22px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.icon{width:44px;height:44px;border-radius:12px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--muted);flex:none;text-transform:uppercase}
.title{min-width:0;flex:1}
.title h1{margin:0;font-size:18px;font-weight:600;word-break:break-word}
.title p{margin:2px 0 0;color:var(--muted);font-size:13px}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);text-decoration:none;font-weight:500;font-size:14px;cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.preview{background:var(--bg)}
.preview img{display:block;max-width:100%;max-height:78vh;margin:0 auto}
.preview iframe{display:block;width:100%;height:78vh;border:0;background:#fff}
.preview video,.preview audio{display:block;width:100%;max-height:78vh}
.preview pre{margin:0;padding:18px 22px;white-space:pre-wrap;word-break:break-word;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:78vh;overflow:auto}
.empty{padding:40px 22px;text-align:center;color:var(--muted)}
table{width:100%;border-collapse:collapse}
td{padding:10px 22px;border-bottom:1px solid var(--line);font-size:14px}
td a{color:var(--fg);text-decoration:none;font-weight:500}
td a:hover{text-decoration:underline}
td.meta{color:var(--muted);text-align:right;white-space:nowrap;font-size:13px}
.crumbs{color:var(--muted);font-size:13px;margin-top:2px}
.crumbs a{color:var(--muted)}
form{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
input[type=password]{flex:1;min-width:200px;height:40px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);padding:0 12px;font-size:15px}
.error{color:#d33;font-size:13px;margin-top:10px}
.center{padding:36px 28px}
.center h1{margin:0 0 6px;font-size:20px}
.center p{margin:0;color:var(--muted)}
footer{margin-top:16px;color:var(--muted);font-size:12px;text-align:center}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>
<div class="brand"><b>U</b>Shared from an Uno computer</div>
${body}
</main></body>
</html>`;
}

function extensionLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "file";
  return name.slice(dot + 1, dot + 5);
}

function expiryNote(expiresAt: string | null): string {
  return expiresAt
    ? `<footer>This link stops working on ${escapeHtml(formatDate(expiresAt))}.</footer>`
    : "";
}

export function renderFilePage(input: {
  readonly name: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly contentType: string;
  /** URL of the file bytes (inline). */
  readonly rawUrl: string;
  readonly downloadUrl: string;
  readonly textPreview: string | null;
  readonly expiresAt: string | null;
}): string {
  const kind = sharePreviewKind(input.contentType, input.size);
  const raw = escapeHtml(input.rawUrl);
  let preview: string;
  switch (kind) {
    case "image":
      preview = `<img src="${raw}" alt="${escapeHtml(input.name)}">`;
      break;
    case "pdf":
      preview = `<iframe src="${raw}" title="${escapeHtml(input.name)}"></iframe>`;
      break;
    case "video":
      preview = `<video src="${raw}" controls preload="metadata"></video>`;
      break;
    case "audio":
      preview = `<audio src="${raw}" controls preload="metadata"></audio>`;
      break;
    case "html":
      // The page itself is served with a sandbox CSP (see files/http.ts).
      preview = `<iframe src="${raw}" title="${escapeHtml(input.name)}"></iframe>`;
      break;
    case "text":
      preview =
        input.textPreview !== null
          ? `<pre>${escapeHtml(input.textPreview)}</pre>`
          : `<div class="empty">No preview for this file.</div>`;
      break;
    default:
      preview = `<div class="empty">This file can't be previewed in the browser. Download it to open it in its app.</div>`;
  }
  const openButton =
    kind === "none" || kind === "text"
      ? ""
      : `<a class="btn" href="${raw}" target="_blank" rel="noopener">Open</a>`;
  return page(
    input.name,
    `<div class="card">
<div class="head">
<div class="icon">${escapeHtml(extensionLabel(input.name))}</div>
<div class="title"><h1>${escapeHtml(input.name)}</h1><p>${escapeHtml(formatBytes(input.size))} · Updated ${escapeHtml(formatDate(input.modifiedAt))}</p></div>
<div class="actions">${openButton}<a class="btn primary" href="${escapeHtml(input.downloadUrl)}">Download</a></div>
</div>
<div class="preview">${preview}</div>
</div>
${expiryNote(input.expiresAt)}`,
  );
}

export interface ShareListingEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly modifiedAt: string;
  readonly href: string;
  readonly downloadHref: string | null;
}

export function renderFolderPage(input: {
  readonly folderName: string;
  readonly crumbs: ReadonlyArray<{ readonly name: string; readonly href: string }>;
  readonly entries: ReadonlyArray<ShareListingEntry>;
  readonly expiresAt: string | null;
}): string {
  const rows =
    input.entries.length === 0
      ? `<div class="empty">This folder is empty.</div>`
      : `<table>${input.entries
          .map(
            (entry) => `<tr>
<td><a href="${escapeHtml(entry.href)}">${entry.isDirectory ? "📁 " : ""}${escapeHtml(entry.name)}${entry.isDirectory ? "/" : ""}</a></td>
<td class="meta">${entry.isDirectory ? "" : escapeHtml(formatBytes(entry.size))}</td>
<td class="meta">${escapeHtml(formatDate(entry.modifiedAt))}</td>
<td class="meta">${entry.downloadHref ? `<a href="${escapeHtml(entry.downloadHref)}">Download</a>` : ""}</td>
</tr>`,
          )
          .join("")}</table>`;
  const crumbs =
    input.crumbs.length > 1
      ? `<div class="crumbs">${input.crumbs
          .map((crumb) => `<a href="${escapeHtml(crumb.href)}">${escapeHtml(crumb.name)}</a>`)
          .join(" / ")}</div>`
      : "";
  return page(
    input.folderName,
    `<div class="card">
<div class="head"><div class="icon">dir</div><div class="title"><h1>${escapeHtml(input.folderName)}</h1>${crumbs}</div></div>
${rows}
</div>
${expiryNote(input.expiresAt)}`,
  );
}

export function renderPasswordPage(input: {
  readonly name: string;
  readonly actionUrl: string;
  readonly error: string | null;
}): string {
  return page(
    input.name,
    `<div class="card center">
<h1>${escapeHtml(input.name)}</h1>
<p>This link is protected. Enter the password you were given.</p>
<form method="post" action="${escapeHtml(input.actionUrl)}">
<input type="password" name="password" placeholder="Password" autocomplete="current-password" required autofocus>
<button class="btn primary" type="submit">Open</button>
</form>
${input.error ? `<div class="error">${escapeHtml(input.error)}</div>` : ""}
</div>`,
  );
}

export function renderUnavailablePage(reason: "missing" | "expired" | "gone"): string {
  const copy = {
    missing: ["This link doesn't work", "It may have been turned off by the person who shared it."],
    expired: ["This link has expired", "Ask the person who shared it for a new one."],
    gone: [
      "The shared item isn't there anymore",
      "It was moved or deleted on the computer it was shared from.",
    ],
  }[reason];
  return page(
    copy[0]!,
    `<div class="card center"><h1>${escapeHtml(copy[0]!)}</h1><p>${escapeHtml(copy[1]!)}</p></div>`,
  );
}
