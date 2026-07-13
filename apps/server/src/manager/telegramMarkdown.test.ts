import { describe, expect, it } from "@effect/vitest";

import { renderTelegramHtml } from "./telegramMarkdown.ts";

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
