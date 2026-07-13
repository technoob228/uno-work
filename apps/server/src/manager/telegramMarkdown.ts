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
  const link = /\[([^\]\n]+)]\(([^\s)]+)\)/g;
  let cursor = 0;
  let output = "";
  for (const match of value.matchAll(link)) {
    const index = match.index ?? 0;
    output += renderEmphasis(value.slice(cursor, index));
    const [, label, href] = match;
    output += isSafeLink(href)
      ? `<a href="${escapeHtml(href)}">${renderEmphasis(label)}</a>`
      : renderEmphasis(match[0]);
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
      output.push(`<b>${renderInline(heading[1])}</b>`);
    } else if (bullet) {
      output.push(`• ${renderInline(bullet[1])}`);
    } else if (numbered) {
      output.push(`${numbered[1]}. ${renderInline(numbered[2])}`);
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
