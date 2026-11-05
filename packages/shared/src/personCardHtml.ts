/**
 * A person card (`personCard.ts`) as a page for the Work chat: a complete,
 * self-contained HTML document for `html_render`. It paints with the chat's
 * theme variables (light and dark follow the app), needs no fonts or network
 * (the page policy allows neither), and answers through the page bridge
 * (`uno.send`, see `htmlRender.ts`): whatever the person picks arrives in the
 * chat as their own visible message.
 *
 * Everything the agent wrote is escaped here; the only markup is ours. The
 * page is static HTML first (the server measures and photographs it before
 * any script runs), the script only adds the answering.
 */
import { HTML_RENDER_MESSAGE_LIMITS } from "./htmlRender.ts";
import {
  personCardPrompt,
  type PersonCard,
  type PersonCardAction,
  type PersonCardChoice,
  type PersonCardMetric,
  type PersonCardQuiz,
  type PersonCardReport,
  type PersonCardTable,
} from "./personCard.ts";

export interface PersonCardHtmlOptions {
  /** Pictures already read from the computer; a path without one is left for `html_render` to inline. */
  readonly images?: ReadonlyArray<{ readonly path: string; readonly dataUrl: string }>;
}

// ── Text ──────────────────────────────────────────────────────────────────

/** Control characters out, line ends as `\n`. */
function clean(text: string): string {
  // oxlint-disable-next-line no-control-regex -- removing control characters is the point
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

/**
 * Safe in text and in a quoted attribute. Also hides "100vh" written by the
 * agent from `html_render`'s viewport-unit check (`&#118;` is "v"), and quotes
 * stay entities so no text reads as a local image path to inline.
 */
export function escapeCardText(text: string): string {
  return clean(text)
    .replace(/[&<>"'`]/g, (char) => ENTITIES[char]!)
    .replace(
      /(\d[sld]?)(v)(?=h)/gi,
      (_, before: string, v: string) => `${before}&#${v.charCodeAt(0)};`,
    );
}

const esc = escapeCardText;

function safeHttpUrl(url: string): boolean {
  if (!/^https?:\/\/\S+$/i.test(url)) return false;
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g, "$1<em>$2</em>");
}

// Private-use marks around a held piece; the agent's own are dropped first.
const HOLD = "\ue000";
const HOLD_END = "\ue001";

/** One line of Markdown: code, links, bold, italic, strikethrough; everything else is text. */
function inline(raw: string): string {
  const held: string[] = [];
  const hold = (html: string) => `${HOLD}${held.push(html) - 1}${HOLD_END}`;
  let text = raw
    .replace(/[\ue000\ue001]/g, "")
    .replace(/`([^`\n]+)`/g, (_, code: string) => hold(`<code>${esc(code)}</code>`));
  text = text.replace(/\[([^\]\n]+)\]\(\s*<?([^\s)>]+)>?\s*\)/g, (_, label: string, url: string) =>
    safeHttpUrl(url) ? hold(`<a href="${esc(url)}">${emphasis(esc(label))}</a>`) : hold(esc(label)),
  );
  text = text.replace(
    /\bhttps?:\/\/[^\s<>"'`\ue000\ue001]*[^\s<>"'`.,;:!?)\]\ue000\ue001]/g,
    (url) => (safeHttpUrl(url) ? hold(`<a href="${esc(url)}">${esc(url)}</a>`) : url),
  );
  let html = emphasis(esc(text));
  // A link's label may hold code: restore until nothing is held.
  for (let pass = 0; pass < 3 && html.includes(HOLD); pass += 1) {
    html = html.replace(/\ue000(\d+)\ue001/g, (_, index: string) => held[Number(index)] ?? "");
  }
  return html;
}

const NUMERIC = /^[\s+\-−~≈<>]*[$€£₽¥]?\s*\d[\d\s.,']*(?:[%‰×x]|[kKmMbB]\b)?\s*[$€£₽¥]?$/;

function renderTable(table: PersonCardTable): string {
  const numeric = table.columns.map((_, column) => {
    const cells = table.rows.map((row) => row[column] ?? "").filter((cell) => cell.trim() !== "");
    return cells.length > 0 && cells.every((cell) => NUMERIC.test(cell));
  });
  const cls = (column: number) => (numeric[column] ? ' class="num"' : "");
  const head = table.columns
    .map((column, index) => `<th${cls(index)}>${inline(column)}</th>`)
    .join("");
  const body = table.rows
    .map(
      (row) =>
        `<tr>${table.columns.map((_, index) => `<td${cls(index)}>${inline(row[index] ?? "")}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<div class="tbl" tabindex="0" role="region" aria-label="Table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const LIST_ITEM = /^\s{0,3}([-*+]|\d{1,3}[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const tableCells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

/**
 * The Markdown an agent writes in a report, as safe HTML: paragraphs, lists,
 * headings, quotes, rules, code blocks, tables and the inline marks. Anything
 * else stays text. Links only to http(s), opened by the app.
 */
export function cardMarkdownToHtml(markdown: string): string {
  const lines = clean(markdown).split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  let at = 0;
  while (at < lines.length) {
    const line = lines[at]!;
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      at += 1;
      while (at < lines.length && !lines[at]!.trim().startsWith(fence[1]!)) body.push(lines[at++]!);
      at += 1;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (line.trim() === "") {
      flush();
      at += 1;
      continue;
    }
    if (line.includes("|") && TABLE_DIVIDER.test(lines[at + 1] ?? "")) {
      flush();
      const columns = tableCells(line);
      const rows: string[][] = [];
      at += 2;
      while (at < lines.length && lines[at]!.includes("|") && lines[at]!.trim() !== "") {
        const cells = tableCells(lines[at++]!);
        rows.push(columns.map((_, index) => cells[index] ?? ""));
      }
      out.push(renderTable({ columns, rows }));
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      out.push(`<h3>${inline(heading[1]!)}</h3>`);
      at += 1;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      out.push("<hr>");
      at += 1;
      continue;
    }
    const first = LIST_ITEM.exec(line);
    if (first) {
      flush();
      const ordered = /\d/.test(first[1]!);
      const items: string[][] = [];
      while (at < lines.length) {
        const item = LIST_ITEM.exec(lines[at]!);
        if (item && /\d/.test(item[1]!) === ordered) {
          items.push([item[2]!]);
        } else if (items.length > 0 && /^\s{2,}\S/.test(lines[at]!)) {
          items[items.length - 1]!.push(lines[at]!.trim());
        } else break;
        at += 1;
      }
      const start = ordered ? Number.parseInt(first[1]!, 10) : 1;
      const tag = ordered ? "ol" : "ul";
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      out.push(
        `${open}${items.map((item) => `<li>${item.map(inline).join("<br>")}</li>`).join("")}</${tag}>`,
      );
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const quote: string[] = [];
      while (at < lines.length && /^\s{0,3}>/.test(lines[at]!)) {
        quote.push(lines[at++]!.replace(/^\s{0,3}>\s?/, ""));
      }
      out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
      continue;
    }
    paragraph.push(line.trim());
    at += 1;
  }
  flush();
  return out.join("");
}

// ── Pieces ────────────────────────────────────────────────────────────────

const svg = (paths: string, cls = "ic") =>
  `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICON = {
  check: svg('<path d="M3.5 8.5l3 3 6-7"/>'),
  x: svg('<path d="M4.75 4.75l6.5 6.5M11.25 4.75l-6.5 6.5"/>'),
  arrow: svg('<path d="M3.5 8h9M8.5 4l4 4-4 4"/>'),
  enter: svg('<path d="M12.5 3.5v3.25a2.25 2.25 0 0 1-2.25 2.25H3.5M6.25 6l-2.75 3 2.75 3"/>'),
  file: svg(
    '<path d="M9.25 2.25H4.75a1.25 1.25 0 0 0-1.25 1.25v9a1.25 1.25 0 0 0 1.25 1.25h6.5a1.25 1.25 0 0 0 1.25-1.25V5.5z"/><path d="M9.25 2.25V5.5h3.25"/>',
  ),
  box:
    '<span class="box" aria-hidden="true">' + svg('<path d="M4 8.25l2.5 2.5 5.5-6"/>') + "</span>",
} as const;

const KEYS = "ABCDEFGH";

function head(heading: string, lead: string | undefined, size: "md" | "lg" = "md"): string {
  return (
    `<header class="head"><h1 class="heading ${size}" id="card-title">${esc(heading)}</h1>` +
    (lead ? `<p class="lead">${esc(lead)}</p>` : "") +
    "</header>"
  );
}

const footer = (hint: string, button = "") =>
  `<footer class="foot"><p class="status" role="status" aria-live="polite"><span>${esc(hint)}</span></p>${button}</footer>`;

function renderChoice(card: PersonCardChoice): string {
  const multiple = card.multiple === true;
  const options = card.options
    .map((option, index) => {
      const badge = option.recommended ? '<span class="badge">Recommended</span>' : "";
      const description = option.description
        ? `<span class="desc">${esc(option.description)}</span>`
        : "";
      return (
        `<button type="button" class="opt" data-label="${esc(option.label)}" data-prompt="${esc(personCardPrompt(option))}"${multiple ? ' aria-pressed="false"' : ""}>` +
        `<span class="key" aria-hidden="true">${index + 1}</span>` +
        `<span class="body"><span class="label"><span class="label-text">${esc(option.label)}</span>${badge}</span>${description}</span>` +
        `<span class="tail">${multiple ? ICON.box : ICON.arrow}</span></button>`
      );
    })
    .join("");
  const other = card.allowOther
    ? `<form class="other" novalidate><input name="other" type="text" maxlength="${HTML_RENDER_MESSAGE_LIMITS.maxLength}" placeholder="Other…" aria-label="Your own answer" autocomplete="off" enterkeyhint="send">` +
      (multiple
        ? ""
        : `<button type="submit" class="icon-btn" aria-label="Send your answer" disabled>${ICON.enter}</button>`) +
      "</form>"
    : "";
  const hint = multiple ? "Pick any that fit" : "Your pick goes to the chat";
  const send = multiple
    ? '<button type="button" class="btn primary" data-send disabled>Send</button>'
    : "";
  return (
    `<main class="card" data-kind="choice" data-mode="${multiple ? "multiple" : "single"}" aria-labelledby="card-title">` +
    `<div class="inner">${head(card.title ?? card.question, card.title ? card.question : undefined)}` +
    `<div class="opts" role="group" aria-labelledby="card-title">${options}</div>${other}</div>` +
    footer(hint, send) +
    "</main>"
  );
}

function renderQuiz(card: PersonCardQuiz): string {
  const total = card.questions.length;
  const questions = card.questions
    .map((question, index) => {
      const multi = question.correct.length > 1;
      const options = question.options
        .map(
          (option, optionIndex) =>
            `<button type="button" class="opt" data-i="${optionIndex}"${multi ? ' aria-pressed="false"' : ""}>` +
            `<span class="key" aria-hidden="true">${KEYS[optionIndex] ?? optionIndex + 1}</span>` +
            `<span class="body"><span class="label"><span class="label-text">${esc(option)}</span></span></span>` +
            `<span class="tail">${multi ? ICON.box : ""}</span></button>`,
        )
        .join("");
      const explanation = question.explanation
        ? `<p class="why">${esc(question.explanation)}</p>`
        : "";
      return (
        `<section class="q" data-correct="${question.correct.join(",")}" data-multi="${multi}"${index === 0 ? "" : " hidden"} aria-label="Question ${index + 1} of ${total}">` +
        `<h2 class="qtext">${esc(question.question)}</h2>` +
        (multi ? '<p class="sub">Pick all that are right</p>' : "") +
        `<div class="opts" role="group">${options}</div>` +
        `<div class="explain" hidden><p class="verdict"></p>${explanation}</div></section>`
      );
    })
    .join("");
  const bar =
    total > 1
      ? `<div class="bar" aria-hidden="true">${card.questions.map((_, index) => `<i class="seg${index === 0 ? " cur" : ""}"></i>`).join("")}</div>`
      : "";
  const count = total > 1 ? `<span class="count"><b>1</b> of ${total}</span>` : "";
  const firstMulti = (card.questions[0]?.correct.length ?? 0) > 1;
  return (
    `<main class="card" data-kind="quiz" data-title="${esc(card.title ?? "")}" aria-labelledby="card-title">` +
    `<div class="inner"><header class="head row"><h1 class="heading sm" id="card-title">${esc(card.title ?? "Quiz")}</h1>${count}</header>${bar}` +
    questions +
    `<section class="result" hidden aria-live="polite"><p class="score"><span class="num">0</span><span class="of">/${total}</span></p><p class="verdict"></p><ul class="misses"></ul></section></div>` +
    footer(
      firstMulti ? "Pick, then check" : "Tap an answer",
      `<button type="button" class="btn primary" data-next disabled>${firstMulti ? "Check" : total > 1 ? "Next question" : "See your score"}</button>`,
    ) +
    "</main>"
  );
}

function renderMetric(metric: PersonCardMetric): string {
  const tone = metric.tone ?? "neutral";
  return (
    `<div class="metric" data-tone="${tone}"><p class="m-label">${esc(metric.label)}</p>` +
    `<p class="m-value">${esc(metric.value)}</p>` +
    (metric.note ? `<p class="m-note">${esc(metric.note)}</p>` : "") +
    "</div>"
  );
}

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[a-z0-9+/]+=*$/i;

const baseName = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;

function renderAction(action: PersonCardAction, index: number, primaryIndex: number): string {
  const style = action.style ?? (index === primaryIndex ? "primary" : "plain");
  return `<button type="button" class="btn act ${style}" data-prompt="${esc(personCardPrompt(action))}"><span class="btn-text">${esc(action.label)}</span></button>`;
}

function renderReport(card: PersonCardReport, options: PersonCardHtmlOptions): string {
  const parts: string[] = [head(card.title, card.summary, "lg")];
  if (card.metrics) {
    parts.push(
      `<div class="metrics" data-count="${card.metrics.length}">${card.metrics.map(renderMetric).join("")}</div>`,
    );
  }
  for (const section of card.sections ?? []) {
    parts.push(
      '<section class="sec">' +
        (section.heading ? `<h2 class="sec-h">${esc(section.heading)}</h2>` : "") +
        (section.markdown ? `<div class="md">${cardMarkdownToHtml(section.markdown)}</div>` : "") +
        (section.table ? renderTable(section.table) : "") +
        "</section>",
    );
  }
  if (card.images) {
    const known = new Map((options.images ?? []).map((image) => [image.path, image.dataUrl]));
    const images = card.images
      .map((path) => {
        const dataUrl = known.get(path);
        const src = dataUrl !== undefined && DATA_IMAGE.test(dataUrl) ? dataUrl : path;
        return `<img src="${esc(src)}" alt="${esc(baseName(path))}" loading="lazy" decoding="async">`;
      })
      .join("");
    parts.push(`<div class="imgs" data-count="${card.images.length}">${images}</div>`);
  }
  if (card.files) {
    const files = card.files
      .map((path) => {
        const name = baseName(path);
        const ext = /\.([a-z0-9]{1,6})$/i.exec(name)?.[1];
        return (
          `<li class="file" title="${esc(path)}">${ICON.file}<span class="file-name">${esc(name)}</span>` +
          (ext ? `<span class="ext">${esc(ext.toUpperCase())}</span>` : "") +
          "</li>"
        );
      })
      .join("");
    parts.push(`<ul class="files" aria-label="Files">${files}</ul>`);
  }
  let actions = "";
  if (card.actions) {
    // A styled primary goes first; else the first action is the primary one.
    const ordered = card.actions.toSorted(
      (left, right) => Number(right.style === "primary") - Number(left.style === "primary"),
    );
    const primaryIndex = ordered.some((action) => action.style === "primary") ? -1 : 0;
    actions =
      '<footer class="foot actions">' +
      `<div class="btns">${ordered.map((action, index) => renderAction(action, index, primaryIndex)).join("")}</div>` +
      '<p class="status" role="status" aria-live="polite"></p></footer>';
  }
  return `<main class="card" data-kind="report" aria-labelledby="card-title"><div class="inner">${parts.join("")}</div>${actions}</main>`;
}

// ── Style ─────────────────────────────────────────────────────────────────
// Theme variables only (`HTML_RENDER_THEME_GUIDE`); never --muted as a text
// color (the publish step would rewrite it) and no viewport units (rejected).

const CSS = `
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;padding:0 0 4px}
::selection{background:var(--accent-surface);color:var(--foreground)}
.card{--r:calc(var(--radius) + 4px);--line:var(--border);--ease:cubic-bezier(.16,1,.3,1);position:relative;max-width:760px;margin:0 auto;background:var(--card);color:var(--card-foreground);border:1px solid var(--line);border-radius:var(--r);box-shadow:0 1px 2px rgb(0 0 0 / 4%),0 3px 10px -6px rgb(0 0 0 / 14%);overflow:hidden;font-size:14px;line-height:1.5}
.inner{display:flex;flex-direction:column;gap:16px;padding:18px 20px 20px}
.head{display:flex;flex-direction:column;gap:6px}
.head.row{flex-direction:row;align-items:baseline;justify-content:space-between;gap:12px}
.heading{margin:0;font-weight:600;letter-spacing:-.011em;text-wrap:balance;color:var(--foreground)}
.heading.md{font-size:16px;line-height:1.35}
.heading.lg{font-size:18px;line-height:1.3;letter-spacing:-.016em}
.heading.sm{font-size:14px;line-height:1.4}
.lead{margin:0;color:color-mix(in srgb,var(--foreground) 80%,transparent);font-size:14px;line-height:1.55;text-wrap:pretty;max-width:68ch}
.heading.lg+.lead{font-size:14.5px}
.count{flex:none;font-size:12.5px;color:var(--muted-foreground);font-variant-numeric:tabular-nums}
.count b{font-weight:600;color:var(--foreground)}
.ic{width:16px;height:16px;flex:none;display:block}

.opts{display:flex;flex-direction:column;gap:6px}
.opt{all:unset;box-sizing:border-box;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius);background:transparent;color:var(--foreground);cursor:pointer;text-align:left;transition:background-color .16s,border-color .16s,opacity .2s,box-shadow .16s}
.opt:hover{background:var(--muted);border-color:var(--input)}
.opt:active{background:var(--secondary)}
.opt:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
.key{display:grid;place-items:center;width:22px;height:22px;border-radius:6px;border:1px solid var(--line);background:var(--muted);color:var(--muted-foreground);font:600 11px/1 var(--font-sans);font-variant-numeric:tabular-nums;transition:background-color .16s,color .16s,border-color .16s}
.body{display:flex;flex-direction:column;gap:2px;min-width:0}
.label{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-weight:500;line-height:1.4}
.label-text{overflow-wrap:anywhere}
.desc{color:var(--muted-foreground);font-size:13px;line-height:1.45;overflow-wrap:anywhere}
.badge{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;background:var(--accent-surface);color:var(--accent-surface-foreground);font-size:11px;font-weight:600;letter-spacing:.005em;white-space:nowrap}
.tail{display:grid;place-items:center;width:20px;height:20px;color:var(--muted-foreground)}
[data-mode="single"] .tail{opacity:0;transform:translateX(-3px);transition:opacity .16s,transform .2s var(--ease)}
[data-mode="single"] .opt:hover .tail,[data-mode="single"] .opt:focus-visible .tail{opacity:1;transform:none;color:var(--foreground)}
.box{display:grid;place-items:center;width:18px;height:18px;border-radius:5px;border:1.5px solid var(--input);color:transparent;transition:background-color .16s,border-color .16s,color .16s}
.box .ic{width:12px;height:12px;stroke-width:2.25}
.opt[aria-pressed="true"]{border-color:color-mix(in srgb,var(--primary) 45%,transparent);background:var(--accent-surface)}
.opt[aria-pressed="true"] .key{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}
.opt[aria-pressed="true"] .box{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}

.other{position:relative;display:flex}
.other input{all:unset;box-sizing:border-box;width:100%;height:42px;padding:0 44px 0 12px;border:1px dashed var(--input);border-radius:var(--radius);background:transparent;color:var(--foreground);font:inherit;transition:border-color .16s,box-shadow .16s,background-color .16s}
.other input::placeholder{color:var(--muted-foreground);opacity:1}
.other input:hover{border-color:color-mix(in srgb,var(--foreground) 24%,transparent)}
.other input:focus{border-style:solid;border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in srgb,var(--ring) 20%,transparent);outline:none}
.icon-btn{all:unset;position:absolute;right:6px;top:6px;display:grid;place-items:center;width:30px;height:30px;border-radius:7px;background:var(--primary);color:var(--primary-foreground);cursor:pointer;transition:opacity .16s,transform .16s var(--ease)}
.icon-btn:disabled{opacity:0;transform:scale(.9);pointer-events:none}
.icon-btn:focus-visible{outline:2px solid var(--ring);outline-offset:2px}

.foot{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:10px 12px 10px 20px;border-top:1px solid var(--line);background:color-mix(in srgb,var(--muted) 60%,transparent)}
.status{display:flex;align-items:center;gap:7px;min-width:0;margin:0;color:var(--muted-foreground);font-size:12.5px;line-height:1.4}
.status span{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.status[data-state="sent"]{color:var(--foreground)}
.status[data-state="sent"] .ic{color:var(--success-foreground)}
.status[data-state="error"]{color:var(--destructive-foreground)}
.btn{all:unset;box-sizing:border-box;position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 14px;border-radius:8px;font:500 13px/1 var(--font-sans);white-space:nowrap;cursor:pointer;flex:none;transition:background-color .16s,border-color .16s,opacity .16s,filter .16s,color .16s}
.btn:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.btn.primary{background:var(--primary);color:var(--primary-foreground);box-shadow:0 1px 1px rgb(0 0 0 / 8%),inset 0 1px 0 rgb(255 255 255 / 12%)}
.btn.primary:hover{filter:brightness(1.08)}
.btn.plain{border:1px solid var(--input);color:var(--foreground);background:var(--card)}
.btn.plain:hover{background:var(--muted)}
.btn.success{border:1px solid color-mix(in srgb,var(--success) 40%,transparent);background:color-mix(in srgb,var(--success) 12%,transparent);color:var(--success-foreground)}
.btn.success:hover{background:color-mix(in srgb,var(--success) 18%,transparent)}
.btn.danger{border:1px solid color-mix(in srgb,var(--destructive) 35%,transparent);color:var(--destructive-foreground);background:var(--card)}
.btn.danger:hover{background:var(--destructive-surface)}
.btn:disabled{cursor:default;opacity:.45;filter:none}
.btn[data-sending]{color:transparent}
.btn[data-sending]::after{content:"";position:absolute;width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-color:var(--primary-foreground) transparent var(--primary-foreground) var(--primary-foreground);opacity:.9}
.btn.plain[data-sending]::after,.btn.danger[data-sending]::after,.btn.success[data-sending]::after{border-color:var(--foreground) transparent var(--foreground) var(--foreground)}

.card[data-state="sent"] .opt,.card[data-busy] .opt{cursor:default}
.card[data-state="sent"] .opt:hover{background:transparent;border-color:var(--line)}
.card[data-state="sent"] .opt:not(.picked):not([aria-pressed="true"]){opacity:.42}
.opt.picked{border-color:color-mix(in srgb,var(--primary) 45%,transparent);background:var(--accent-surface)}
.card[data-state="sent"] .opt.picked:hover,.card[data-state="sent"] .opt[aria-pressed="true"]:hover{background:var(--accent-surface);border-color:color-mix(in srgb,var(--primary) 45%,transparent)}
.opt.picked .key{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}
.opt.picked .tail{opacity:1;transform:none;color:var(--primary)}
.card[data-state="sent"] .other input{opacity:.5}

.sub{margin:-8px 0 0;color:var(--muted-foreground);font-size:12.5px}
.bar{display:flex;gap:4px;margin-top:-4px}
.seg{flex:1;height:4px;border-radius:2px;background:var(--input);transition:background-color .3s var(--ease)}
.seg.cur{background:color-mix(in srgb,var(--foreground) 55%,transparent)}
.seg.good{background:var(--success)}
.seg.bad{background:var(--destructive)}
.q{display:flex;flex-direction:column;gap:14px}
.qtext{margin:0;font-size:16px;line-height:1.4;font-weight:600;letter-spacing:-.011em;text-wrap:balance}
.q[data-answered] .opt{cursor:default}
.q[data-answered] .opt:hover{background:transparent;border-color:var(--line)}
.opt.right{border-color:color-mix(in srgb,var(--success) 50%,transparent);background:color-mix(in srgb,var(--success) 9%,transparent)}
.opt.right:hover{background:color-mix(in srgb,var(--success) 9%,transparent)!important;border-color:color-mix(in srgb,var(--success) 50%,transparent)!important}
.opt.right .key{background:var(--success);border-color:var(--success);color:#fff}
.opt.right .tail{color:var(--success-foreground)}
.opt.wrong{border-color:color-mix(in srgb,var(--destructive) 50%,transparent);background:var(--destructive-surface)}
.opt.wrong:hover{background:var(--destructive-surface)!important;border-color:color-mix(in srgb,var(--destructive) 50%,transparent)!important}
.opt.wrong .key{background:var(--destructive);border-color:var(--destructive);color:#fff}
.opt.wrong .tail{color:var(--destructive-foreground)}
.opt.dim{opacity:.42}
.explain{display:flex;flex-direction:column;gap:4px;padding:12px 14px;border-radius:var(--radius);background:var(--muted)}
.explain .verdict{margin:0;font-weight:600;font-size:13.5px}
.explain[data-right="true"] .verdict{color:var(--success-foreground)}
.explain[data-right="false"] .verdict{color:var(--destructive-foreground)}
.why{margin:0;font-size:13.5px;line-height:1.55;color:color-mix(in srgb,var(--foreground) 82%,transparent);max-width:68ch}
.result{display:flex;flex-direction:column;gap:6px;padding:4px 0 2px}
.score{margin:0;display:flex;align-items:baseline;gap:2px;font-variant-numeric:tabular-nums;letter-spacing:-.03em}
.score .num{font-size:44px;line-height:1;font-weight:650;color:var(--foreground)}
.score .of{font-size:22px;line-height:1;font-weight:500;color:var(--muted-foreground)}
.result .verdict{margin:2px 0 0;font-size:15px;font-weight:500}
.misses{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;border-top:1px solid var(--line)}
.misses li{display:flex;flex-direction:column;gap:2px;padding:10px 0;border-bottom:1px solid var(--line);font-size:13px}
.misses li:last-child{border-bottom:0;padding-bottom:0}
.misses .mq{color:var(--foreground);font-weight:500;overflow-wrap:anywhere}
.misses .ma{color:var(--muted-foreground);overflow-wrap:anywhere}
.misses .ma b{font-weight:500;color:var(--success-foreground)}
.misses:empty{display:none}

.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px}
.metric{display:flex;flex-direction:column;gap:3px;padding:12px 14px;border-radius:var(--radius);background:var(--muted);min-width:0}
.m-label{margin:0;color:var(--muted-foreground);font-size:12px;font-weight:500;line-height:1.35}
.m-value{margin:0;font-size:22px;line-height:1.2;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.m-note{display:flex;align-items:center;gap:6px;margin:0;color:var(--muted-foreground);font-size:12px;line-height:1.35}
.metric[data-tone="good"] .m-note{color:var(--success-foreground)}
.metric[data-tone="bad"] .m-note{color:var(--destructive-foreground)}
.metric[data-tone="good"] .m-note::before,.metric[data-tone="bad"] .m-note::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}

.sec{display:flex;flex-direction:column;gap:6px;padding-top:2px}
.sec+.sec{padding-top:16px;border-top:1px solid var(--line)}
.sec-h{margin:0;font-size:14px;font-weight:600;letter-spacing:-.006em}
.md{color:color-mix(in srgb,var(--foreground) 88%,transparent);font-size:14px;line-height:1.6;overflow-wrap:anywhere}
.md p,.md ul,.md ol,.md blockquote,.md h3{max-width:72ch}
.md>*{margin:0}
.md>*+*{margin-top:8px}
.md h3{font-size:13.5px;font-weight:600;color:var(--foreground);margin-top:14px}
.md ul,.md ol{padding-left:20px}
.md li+li{margin-top:3px}
.md li::marker{color:var(--muted-foreground)}
.md strong{font-weight:600;color:var(--foreground)}
.md a{color:var(--accent-surface-foreground);text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 35%,transparent);text-underline-offset:2px;transition:text-decoration-color .16s}
.md a:hover{text-decoration-color:currentColor}
.md code,.tbl code{font-family:var(--font-mono);font-size:.88em;padding:1px 5px;border-radius:5px;background:var(--code-background);color:var(--code-foreground);-webkit-box-decoration-break:clone;box-decoration-break:clone}
.md pre{padding:12px 14px;border-radius:var(--radius);background:var(--code-background);overflow-x:auto;scrollbar-width:thin;scrollbar-color:var(--input) transparent}
.md pre code{padding:0;background:none;font-size:12.5px;line-height:1.6;white-space:pre}
.md blockquote{padding-left:12px;border-left:1px solid var(--input);color:var(--muted-foreground)}
.md hr{border:0;border-top:1px solid var(--line)}
.md del{color:var(--muted-foreground)}

.tbl{overflow-x:auto;border:1px solid var(--line);border-radius:var(--radius);scrollbar-width:thin;scrollbar-color:var(--input) transparent}
.tbl:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
.md .tbl{margin-top:10px}
.tbl table{width:100%;border-collapse:collapse;font-size:13px;line-height:1.45}
.tbl th{padding:8px 12px;text-align:left;font-weight:500;font-size:12px;color:var(--muted-foreground);background:var(--muted);white-space:nowrap;border-bottom:1px solid var(--line)}
.tbl td{padding:8px 12px;vertical-align:top;color:var(--foreground);min-width:80px}
.tbl tr+tr td{border-top:1px solid var(--line)}
.tbl .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}

.imgs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.imgs[data-count="2"]{grid-template-columns:repeat(2,minmax(0,1fr))}
.imgs img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:var(--radius);border:1px solid var(--line);background:var(--muted)}
.imgs[data-count="1"]{display:block}
.imgs[data-count="1"] img{aspect-ratio:auto;height:auto;max-height:480px;object-fit:contain}
.files{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px}
.file{display:flex;align-items:center;gap:10px;min-width:0;padding:9px 12px;border:1px solid var(--line);border-radius:var(--radius);color:var(--muted-foreground)}
.file-name{flex:1;min-width:0;color:var(--foreground);font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ext{flex:none;padding:1px 6px;border-radius:5px;background:var(--muted);color:var(--muted-foreground);font-size:10.5px;font-weight:600;letter-spacing:.03em}

.foot.actions{flex-direction:column;align-items:stretch;gap:8px;padding:12px 20px}
.btns{display:flex;flex-wrap:wrap;gap:8px}
.foot.actions .status:empty{display:none}
.btn.act.picked{opacity:1}

@media (max-width:440px){
.inner{padding:16px 16px 18px;gap:14px}
.foot{padding:10px 10px 10px 16px}
.foot.actions{padding:12px 16px}
.heading.lg{font-size:17px}
.opt{gap:10px;padding:10px}
.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
.btns .btn{flex:1 1 auto}
.score .num{font-size:40px}
}
@media (prefers-reduced-motion:no-preference){
.enter{animation:rise .34s var(--ease) both}
.explain:not([hidden]){animation:rise .3s var(--ease) both}
.status[data-state="sent"] .ic path{stroke-dasharray:14;stroke-dashoffset:14;animation:draw .5s var(--ease) .06s forwards}
.opt.right .tail .ic path,.opt.wrong .tail .ic path,.opt.picked .tail .ic path{stroke-dasharray:16;stroke-dashoffset:16;animation:draw .42s var(--ease) forwards}
.btn[data-sending]::after{animation:spin .7s linear infinite}
@keyframes rise{from{opacity:0;transform:translateY(5px)}}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes spin{to{transform:rotate(360deg)}}
}
`
  .replace(/\n+/g, "")
  .trim();

// ── Behaviour ─────────────────────────────────────────────────────────────
// ES5, text only through textContent; icons are our own constants.

const SCRIPT = `(function(){
var card=document.querySelector(".card");if(!card)return;
var kind=card.getAttribute("data-kind"),status=card.querySelector(".status"),MAX=${HTML_RENDER_MESSAGE_LIMITS.maxLength},busy=false,locked=false;
var IC_CHECK=${JSON.stringify(ICON.check)},IC_X=${JSON.stringify(ICON.x)},IC_ALERT=${JSON.stringify(svg('<circle cx="8" cy="8" r="5.75"/><path d="M8 5.25v3.25M8 10.75v.01"/>'))};
function all(sel,root){return Array.prototype.slice.call((root||card).querySelectorAll(sel));}
function clip(t){return t.length>MAX?t.slice(0,MAX-1)+"\\u2026":t;}
function short(t){t=t.split("\\n")[0];return t.length>90?t.slice(0,89)+"\\u2026":t;}
function say(state,text){if(!status)return;status.setAttribute("data-state",state);status.textContent="";if(state==="sent")status.insertAdjacentHTML("beforeend",IC_CHECK);if(state==="error")status.insertAdjacentHTML("beforeend",IC_ALERT);var s=document.createElement("span");s.textContent=text;status.appendChild(s);}
function send(text){var u=window.uno;if(!u||typeof u.send!=="function")return Promise.resolve({ok:false,reason:"Update Uno Work to answer here."});return u.send(clip(text)).then(function(r){return r||{ok:false};},function(){return{ok:false,reason:"Not sent."};});}
function lock(note){locked=true;card.setAttribute("data-state","sent");all("button,input").forEach(function(el){el.disabled=true;});say("sent",note);}
function submit(text,el,note,done){if(busy||locked)return;busy=true;card.setAttribute("data-busy","");if(el)el.setAttribute("data-sending","");say("sending","Sending\\u2026");send(text).then(function(r){busy=false;card.removeAttribute("data-busy");if(el)el.removeAttribute("data-sending");if(r.ok){lock(r.queued==="composer"?"In your message box \\u00b7 press Enter to send":(note||("Sent \\u00b7 "+short(text))));}else{say("error",r.reason||"Not sent. Try again.");}if(done)done(r.ok===true);});}
function sentList(){var u=window.uno;return u&&Array.isArray(u.sent)?u.sent:[];}
function onHistory(fn){function run(list){if(!locked&&list.length)fn(list[list.length-1]);}window.addEventListener("uno:sent",function(e){run(e.detail&&Array.isArray(e.detail.messages)?e.detail.messages:[]);});run(sentList());}
function typing(e){var t=e.target;return t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));}
function arrows(e,list){if(e.key!=="ArrowDown"&&e.key!=="ArrowUp")return false;var live=list.filter(function(o){return !o.disabled&&o.offsetParent!==null;}),i=live.indexOf(document.activeElement);if(!live.length)return false;e.preventDefault();live[(i+(e.key==="ArrowDown"?1:-1)+live.length)%live.length].focus();return true;}

if(kind==="choice"){
var multiple=card.getAttribute("data-mode")==="multiple",opts=all(".opt"),sendBtn=card.querySelector("[data-send]"),form=card.querySelector("form.other"),input=form&&form.querySelector("input"),iconBtn=form&&form.querySelector(".icon-btn");
var hint=status?status.textContent:"";
function picked(){return opts.filter(function(o){return o.getAttribute("aria-pressed")==="true";});}
function otherText(){return input?input.value.trim():"";}
function multiText(){var p=picked(),lines=["Picked: "+p.map(function(o){return o.getAttribute("data-label");}).concat(otherText()?["other"]:[]).join(", ")];p.forEach(function(o){var l=o.getAttribute("data-label"),pr=o.getAttribute("data-prompt");if(pr!==l)lines.push("- "+l+": "+pr);});if(otherText())lines.push("Other: "+otherText());return lines.join("\\n");}
function sync(){var n=picked().length+(otherText()?1:0);if(sendBtn)sendBtn.disabled=locked||n===0;if(iconBtn)iconBtn.disabled=locked||!otherText();if(multiple&&!busy&&!locked)say("",n?n+" selected":hint);}
opts.forEach(function(o){o.addEventListener("click",function(){if(busy||locked)return;if(multiple){o.setAttribute("aria-pressed",o.getAttribute("aria-pressed")==="true"?"false":"true");sync();return;}opts.forEach(function(x){x.classList.remove("picked");});o.classList.add("picked");o.querySelector(".tail").innerHTML=IC_CHECK;submit(o.getAttribute("data-prompt"),null,"Sent \\u00b7 "+short(o.getAttribute("data-label")),function(ok){if(!ok){o.classList.remove("picked");o.querySelector(".tail").innerHTML=${JSON.stringify(ICON.arrow)};}});});});
if(input)input.addEventListener("input",sync);
if(sendBtn)sendBtn.addEventListener("click",function(){submit(multiText(),sendBtn);});
if(form)form.addEventListener("submit",function(e){e.preventDefault();if(!otherText())return;if(multiple)submit(multiText(),sendBtn);else submit(otherText(),iconBtn);});
document.addEventListener("keydown",function(e){if(locked||busy||typing(e)||e.metaKey||e.ctrlKey||e.altKey)return;if(arrows(e,opts))return;var n=Number(e.key);if(n>=1&&n<=opts.length){e.preventDefault();opts[n-1].focus();opts[n-1].click();}});
onHistory(function(last){var hit=opts.filter(function(o){return o.getAttribute("data-prompt")===last;})[0];if(!multiple&&hit){hit.classList.add("picked");hit.querySelector(".tail").innerHTML=IC_CHECK;lock("Sent \\u00b7 "+short(hit.getAttribute("data-label")));return;}if(multiple&&last.indexOf("Picked: ")===0){var names=last.split("\\n")[0].slice(8).split(", ");opts.forEach(function(o){if(names.indexOf(o.getAttribute("data-label"))>-1)o.setAttribute("aria-pressed","true");});}lock("Sent \\u00b7 "+short(last));});
}

if(kind==="quiz"){
var qs=all(".q"),segs=all(".seg"),next=card.querySelector("[data-next]"),count=card.querySelector(".count b"),result=card.querySelector(".result"),title=card.getAttribute("data-title"),cur=0,answers=[];
function correctOf(q){return q.getAttribute("data-correct").split(",").map(Number);}
function multiQ(q){return q.getAttribute("data-multi")==="true";}
function labelOf(q,i){return all(".opt",q)[i].querySelector(".label-text").textContent;}
function names(q,list){return list.map(function(i){return labelOf(q,i);}).join(", ");}
function lastQ(){return cur===qs.length-1;}
function nextLabel(){return lastQ()?"See your score":"Next question";}
function grade(q,picked){var correct=correctOf(q),right=picked.length===correct.length&&picked.every(function(i){return correct.indexOf(i)>-1;});q.setAttribute("data-answered","");all(".opt",q).forEach(function(o,i){var c=correct.indexOf(i)>-1,p=picked.indexOf(i)>-1;o.removeAttribute("aria-pressed");o.setAttribute("aria-disabled","true");if(c){o.classList.add("right");o.querySelector(".tail").innerHTML=IC_CHECK;}else if(p){o.classList.add("wrong");o.querySelector(".tail").innerHTML=IC_X;}else o.classList.add("dim");});var ex=q.querySelector(".explain");ex.setAttribute("data-right",String(right));ex.querySelector(".verdict").textContent=right?"Right.":(correct.length>1?"Not quite. Right: ":"Not quite. The answer is ")+(right?"":names(q,correct)+".");ex.hidden=false;if(segs[cur]){segs[cur].classList.remove("cur");segs[cur].classList.add(right?"good":"bad");}answers[cur]={right:right,picked:picked,correct:correct};next.textContent=nextLabel();next.disabled=false;say("","");next.focus({preventScroll:true});}
function show(i){qs[cur].hidden=true;cur=i;var q=qs[cur];q.hidden=false;q.classList.remove("enter");void q.offsetWidth;q.classList.add("enter");if(segs[cur])segs[cur].classList.add("cur");if(count)count.textContent=String(cur+1);next.disabled=true;next.textContent=multiQ(q)?"Check":nextLabel();say("",multiQ(q)?"Pick, then check":"Tap an answer");}
function message(){var n=answers.filter(function(a){return a&&a.right;}).length,parts=["Quiz"+(title?" \\u00ab"+title+"\\u00bb":"")+": "+n+"/"+qs.length+" right."];answers.forEach(function(a,i){if(a&&!a.right)parts.push("Q"+(i+1)+": picked \\""+names(qs[i],a.picked)+"\\", right \\""+names(qs[i],a.correct)+"\\".");});var t=parts.join(" ");return t.length>MAX?t.slice(0,MAX-1)+"\\u2026":t;}
function verdict(n,total){var r=n/total;return r===1?"Every answer right.":r>=.75?"Strong result.":r>=.5?"More than half right.":"Worth another pass.";}
function showResult(n,total){qs.forEach(function(q){q.hidden=true;});segs.forEach(function(s){s.classList.remove("cur");});var c=card.querySelector(".count");if(c)c.hidden=true;result.hidden=false;result.classList.add("enter");result.querySelector(".num").textContent=String(n);result.querySelector(".of").textContent="/"+total;result.querySelector(".verdict").textContent=verdict(n,total);}
function finish(){var n=answers.filter(function(a){return a&&a.right;}).length,list=result.querySelector(".misses");showResult(n,qs.length);answers.forEach(function(a,i){if(!a||a.right)return;var li=document.createElement("li"),q=document.createElement("span"),ans=document.createElement("span"),b=document.createElement("b");q.className="mq";q.textContent=(i+1)+". "+qs[i].querySelector(".qtext").textContent;ans.className="ma";ans.textContent="You: "+names(qs[i],a.picked)+" \\u00b7 Right: ";b.textContent=names(qs[i],a.correct);ans.appendChild(b);li.appendChild(q);li.appendChild(ans);list.appendChild(li);});next.textContent="Send score";sendScore();}
function sendScore(){submit(message(),next,"Score sent to the chat",function(ok){if(ok)next.hidden=true;else{next.textContent="Send again";next.disabled=false;}});}
qs.forEach(function(q){all(".opt",q).forEach(function(o){o.addEventListener("click",function(){if(q.hasAttribute("data-answered")||locked)return;var i=Number(o.getAttribute("data-i"));if(multiQ(q)){o.setAttribute("aria-pressed",o.getAttribute("aria-pressed")==="true"?"false":"true");next.disabled=!all('.opt[aria-pressed="true"]',q).length;return;}grade(q,[i]);});});});
next.addEventListener("click",function(){if(busy||locked)return;if(!result.hidden){sendScore();return;}var q=qs[cur];if(!q.hasAttribute("data-answered")){if(multiQ(q)){var p=all(".opt",q).filter(function(o){return o.getAttribute("aria-pressed")==="true";}).map(function(o){return Number(o.getAttribute("data-i"));});if(p.length)grade(q,p);}return;}if(lastQ())finish();else show(cur+1);});
document.addEventListener("keydown",function(e){if(locked||busy||typing(e)||e.metaKey||e.ctrlKey||e.altKey)return;var q=qs[cur];if(!q||q.hidden)return;var opts=all(".opt",q);if(!q.hasAttribute("data-answered")&&arrows(e,opts))return;var k=e.key.toUpperCase(),i="ABCDEFGH".indexOf(k);if(i<0&&/^[1-8]$/.test(e.key))i=Number(e.key)-1;if(i>-1&&i<opts.length&&!q.hasAttribute("data-answered")&&k.length===1){e.preventDefault();opts[i].focus();opts[i].click();}});
onHistory(function(last){if(last.indexOf("Quiz")!==0)return;var m=/: (\\d+)\\/(\\d+) right/.exec(last);showResult(m?Number(m[1]):0,m?Number(m[2]):qs.length);segs.forEach(function(s){s.classList.add("good");});next.hidden=true;lock("Score sent to the chat");});
}

if(kind==="report"){
var acts=all(".act");
acts.forEach(function(b){b.addEventListener("click",function(){if(busy||locked)return;b.classList.add("picked");submit(b.getAttribute("data-prompt"),b,"Sent \\u00b7 "+short(b.textContent),function(ok){if(!ok)b.classList.remove("picked");});});});
onHistory(function(last){var hit=acts.filter(function(b){return b.getAttribute("data-prompt")===last;})[0];if(hit)hit.classList.add("picked");lock("Sent \\u00b7 "+short(hit?hit.textContent:last));});
}
})();`;

// ── Document ──────────────────────────────────────────────────────────────

function cardTitle(card: PersonCard): string {
  switch (card.kind) {
    case "choice":
      return card.title ?? card.question;
    case "quiz":
      return card.title ?? "Quiz";
    case "report":
      return card.title;
  }
}

/**
 * The card as one HTML document for `html_render`. `options.images` carries
 * pictures already read; any other image path is left in `src` for the
 * publish step to inline (`preparePage`).
 */
export function renderPersonCardHtml(
  card: PersonCard,
  options: PersonCardHtmlOptions = {},
): string {
  const body =
    card.kind === "choice"
      ? renderChoice(card)
      : card.kind === "quiz"
        ? renderQuiz(card)
        : renderReport(card, options);
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${esc(cardTitle(card))}</title><style>${CSS}</style></head>` +
    `<body>${body}<script>${SCRIPT}</script></body></html>`
  );
}
