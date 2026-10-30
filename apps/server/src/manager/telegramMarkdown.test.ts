import { describe, expect, it } from "@effect/vitest";

import {
  hidesLinkPreview,
  markdownLinksAsText,
  markdownLinksForSlack,
  renderTelegramHtml,
  telegramTextFields,
} from "./telegramMarkdown.ts";

describe("renderTelegramHtml", () => {
  it("renders common agent Markdown with Telegram-safe HTML", () => {
    expect(
      renderTelegramHtml(
        "# Hola\n\n**Mucho gusto** and *bien*.\n- [Практика](https://example.com/a?x=1&y=2)\n`a < b`",
      ),
    ).toBe(
      '<b>Hola</b>\n\n<b>Mucho gusto</b> and <i>bien</i>.\n• <a href="https://example.com/a?x=1&amp;y=2">Практика</a>\n<code>a &lt; b</code>',
    );
  });

  it("escapes agent-provided HTML and leaves unsafe links as text", () => {
    expect(renderTelegramHtml("<b>not a tag</b> [x](javascript:alert(1))")).toBe(
      "&lt;b&gt;not a tag&lt;/b&gt; [x](javascript:alert(1))",
    );
  });

  it("renders fenced code without allowing HTML injection", () => {
    expect(renderTelegramHtml("```\nconst x = '<tag>';\n``` ")).toBe(
      "<pre><code>const x = '&lt;tag&gt;';</code></pre>",
    );
  });
});

describe("a report link on its way to a messenger", () => {
  const url = "https://r-0123456789.uno4.me/?k=a_b-c&x=1";

  it("is a word in the text in Telegram, bold or not", () => {
    expect(renderTelegramHtml(`Готово: [отчёт](${url}).`)).toBe(
      'Готово: <a href="https://r-0123456789.uno4.me/?k=a_b-c&amp;x=1">отчёт</a>.',
    );
    expect(renderTelegramHtml(`**[отчёт](${url})**`)).toBe(
      '<b><a href="https://r-0123456789.uno4.me/?k=a_b-c&amp;x=1">отчёт</a></b>',
    );
  });

  it("keeps a bare address whole", () => {
    const html = renderTelegramHtml("https://r-1.uno4.me/?k=a_b_c*d*");
    expect(html).not.toContain("<i>");
    expect(html).not.toContain("<b>");
  });

  it("stays clickable in the plain retry and in Slack", () => {
    expect(markdownLinksAsText(`[отчёт](${url})`)).toBe(`отчёт: ${url}`);
    expect(markdownLinksForSlack(`Готово: [отчёт](${url})`)).toBe(`Готово: <${url}|отчёт>`);
  });

  it("switches the preview off, whatever the send mode", () => {
    expect(hidesLinkPreview(`[отчёт](${url})`)).toBe(true);
    expect(hidesLinkPreview(url)).toBe(true);
    expect(hidesLinkPreview("https://example.com/page")).toBe(false);
    expect(hidesLinkPreview("просто текст")).toBe(false);
    for (const html of [true, false]) {
      expect(telegramTextFields(`[отчёт](${url})`, html).link_preview_options).toEqual({
        is_disabled: true,
      });
    }
    expect(telegramTextFields("текст", true)).toEqual({ text: "текст", parse_mode: "HTML" });
    expect(telegramTextFields("текст", false)).toEqual({ text: "текст" });
  });
});
