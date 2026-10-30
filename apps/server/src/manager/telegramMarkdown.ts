/**
 * A deliberately small Markdown-to-Telegram-HTML renderer.
 *
 * Agent output is normal Markdown, while Telegram only parses formatting when
 * `parse_mode` is set. Telegram's MarkdownV2 requires escaping a very large
 * set of characters, so render the common Markdown subset to its safer HTML
 * mode instead. Everything that is not a tag emitted below is HTML-escaped.
 */

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const isSafeLink = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "tg:";
  } catch {
    return false;
  }
};

const renderEmphasis = (value: string): string =>
  escapeHtml(value)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<i>$1</i>");

const renderNonCode = (value: string): string => {
  // A bare address stays whole: `_` in it is no emphasis.
  const link = /(\*\*)?\[([^\]\n]+)]\(([^\s)]+)\)(\*\*)?|https?:\/\/[^\s<>]+/g;
  let cursor = 0;
  let output = "";
  for (const match of value.matchAll(link)) {
    const index = match.index ?? 0;
    output += renderEmphasis(value.slice(cursor, index));
    const label = match[2];
    const href = match[3] ?? "";
    if (label === undefined) {
      output += escapeHtml(match[0]);
    } else if (isSafeLink(href)) {
      const anchor = `<a href="${escapeHtml(href)}">${renderEmphasis(label)}</a>`;
      const bold = match[1] !== undefined && match[4] !== undefined;
      output += bold ? `<b>${anchor}</b>` : `${match[1] ?? ""}${anchor}${match[4] ?? ""}`;
    } else {
      output += renderEmphasis(match[0]);
    }
    cursor = index + match[0].length;
  }
  return output + renderEmphasis(value.slice(cursor));
};

const renderInline = (value: string): string =>
  value
    .split(/(`[^`\n]*`)/g)
    .map((part) =>
      part.startsWith("`") && part.endsWith("`")
        ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
        : renderNonCode(part),
    )
    .join("");

/** Render the Markdown constructs agents use most often into Telegram HTML. */
export const renderTelegramHtml = (markdown: string): string => {
  const output: Array<string> = [];
  const codeLines: Array<string> = [];
  let inCodeBlock = false;

  const flushCodeBlock = () => {
    output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeLines.length = 0;
  };

  for (const line of markdown.split("\n")) {
    if (/^```[^`]*$/.test(line)) {
      if (inCodeBlock) {
        flushCodeBlock();
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const heading = /^(?:#{1,6})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-+*]\s+(.+)$/.exec(line);
    const numbered = /^\s*(\d+)\.\s+(.+)$/.exec(line);
    if (heading) {
      output.push(`<b>${renderInline(heading[1] ?? "")}</b>`);
    } else if (bullet) {
      output.push(`• ${renderInline(bullet[1] ?? "")}`);
    } else if (numbered) {
      output.push(`${numbered[1] ?? ""}. ${renderInline(numbered[2] ?? "")}`);
    } else {
      output.push(renderInline(line));
    }
  }
  if (inCodeBlock) {
    // Preserve an incomplete fence as literal text rather than sending
    // unbalanced Telegram HTML.
    output.push(renderInline(`\`\`\`${codeLines.join("\n")}`));
  }
  return output.join("\n");
};

/** A Markdown link, `[label](url)`. */
const MARKDOWN_LINK = /\[([^\]\n]+)]\((https?:\/\/[^\s)]+)\)/g;

/**
 * The text for a chat that shows no formatting: a link keeps its address, so
 * the fallback for HTML Telegram couldn't parse still opens.
 */
export const markdownLinksAsText = (text: string): string => text.replace(MARKDOWN_LINK, "$1: $2");

/** Slack's own link form, `<url|label>`: Slack shows `[label](url)` as typed. */
export const markdownLinksForSlack = (text: string): string =>
  text.replace(
    MARKDOWN_LINK,
    (_, label: string, url: string) =>
      `<${url}|${label.replaceAll("|", "/").replaceAll(">", "›").replaceAll("<", "‹")}>`,
  );

/**
 * A link behind a word, or a page of Uno Hosting: the messenger shows no
 * preview, so a report's title and text stay inside the report.
 */
export const hidesLinkPreview = (text: string): boolean =>
  /\]\(https?:\/\/|[./]uno4\.me\b/i.test(text);

/** The text fields of a `sendMessage`; `html: false` is the plain retry after a parse error. */
export const telegramTextFields = (
  text: string,
  html: boolean,
): {
  readonly text: string;
  readonly parse_mode?: "HTML";
  readonly link_preview_options?: { readonly is_disabled: true };
} => ({
  ...(html
    ? { text: renderTelegramHtml(text), parse_mode: "HTML" as const }
    : { text: markdownLinksAsText(text) }),
  ...(hidesLinkPreview(text) ? { link_preview_options: { is_disabled: true as const } } : {}),
});
