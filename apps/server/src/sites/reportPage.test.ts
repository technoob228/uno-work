import { describe, expect, it } from "vitest";

import {
  renderReportMarkdown,
  reportImageRefs,
  reportPageFromHtml,
  reportPageFromMarkdown,
} from "./reportPage.ts";

describe("renderReportMarkdown", () => {
  it("renders the shapes a report has", () => {
    const html = renderReportMarkdown(
      [
        "## Итоги недели",
        "",
        "Текст с **жирным**, *курсивом*, `кодом` и [ссылкой](https://uno4.me/x).",
        "",
        "- первый",
        "- второй",
        "  - вложенный",
        "",
        "1. раз",
        "2. два",
        "",
        "| Имя | Сумма |",
        "|:----|----:|",
        "| Катя | 10 |",
        "| Миша \\| Катя | 20 |",
        "",
        "> цитата",
        "",
        "```ts",
        "const a = 1 < 2;",
        "```",
        "",
        "---",
      ].join("\n"),
    );
    expect(html).toContain("<h2>Итоги недели</h2>");
    expect(html).toContain("<strong>жирным</strong>");
    expect(html).toContain("<em>курсивом</em>");
    expect(html).toContain("<code>кодом</code>");
    expect(html).toContain('<a href="https://uno4.me/x" rel="noopener noreferrer">ссылкой</a>');
    expect(html).toContain("<li>второй\n<ul><li>вложенный</li></ul></li></ul>");
    expect(html).toContain("<ol><li>раз</li><li>два</li></ol>");
    expect(html).toContain('<div class="table"><table>');
    expect(html).toContain('<th style="text-align:right">Сумма</th>');
    expect(html).toContain("<td>Миша | Катя</td>");
    expect(html).toContain("<blockquote><p>цитата</p></blockquote>");
    expect(html).toContain("<pre><code>const a = 1 &lt; 2;</code></pre>");
    expect(html).toContain("<hr>");
  });

  it("shows raw HTML as text and keeps only safe links", () => {
    const html = renderReportMarkdown(
      '<script>alert(1)</script>\n\n[x](javascript:alert(1)) [y](data:text/html,1) ![z](http://a.b/c.png)\n\n<img src=x onerror=alert(1)>\n\n[k](https://a.b/"onclick="x)',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain('href="data:');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('"onclick="');
  });

  it("inlines the relative images it was given and drops the rest to their alt text", () => {
    const images = new Map([["chart.png", "data:image/png;base64,AAAA"]]);
    const html = renderReportMarkdown("![график](chart.png) ![нет](missing.png)", images);
    expect(html).toContain('<img src="data:image/png;base64,AAAA" alt="график"');
    expect(html).toContain("нет");
    expect(html).not.toContain("missing.png");
  });

  it("links bare addresses without the sentence's punctuation", () => {
    expect(renderReportMarkdown("Смотри https://uno4.me/a.")).toContain(
      '<a href="https://uno4.me/a" rel="noopener noreferrer">https://uno4.me/a</a>.',
    );
  });

  it("marks tasks and survives an unclosed fence and deep nesting", () => {
    expect(renderReportMarkdown("- [x] готово\n- [ ] нет")).toContain("☑ готово");
    expect(renderReportMarkdown("```\ncode")).toContain("<pre><code>code</code></pre>");
    expect(renderReportMarkdown(`${">".repeat(40)} глубоко`)).toContain("глубоко");
  });

  it("never stalls on a list line that can't join a list", () => {
    expect(renderReportMarkdown("  - a\n- b\n   - c\n1. d\n- e")).toContain("e");
  });
});

describe("reportImageRefs", () => {
  it("lists only relative images", () => {
    expect(
      reportImageRefs("![a](chart.png) ![b](https://x.y/z.png) ![c](data:image/png;base64,AA)"),
    ).toEqual(["chart.png"]);
  });
});

describe("reportPageFromMarkdown", () => {
  it("takes the title from the first heading and doesn't repeat it", () => {
    const page = reportPageFromMarkdown({ markdown: "# Отчёт **за** неделю\n\nТекст", title: "x" });
    expect(page.title).toBe("Отчёт за неделю");
    expect(page.html.match(/<h1>/g)).toHaveLength(1);
    expect(page.html).toContain('<html lang="ru">');
  });

  it("uses the given title when the file has no heading", () => {
    const page = reportPageFromMarkdown({ markdown: "Plain text", title: "Weekly <report>" });
    expect(page.html).toContain("<h1>Weekly &lt;report&gt;</h1>");
    expect(page.html).toContain("<title>Weekly &lt;report&gt;</title>");
  });

  it("is a phone page with no scripts or outside resources", () => {
    const { html } = reportPageFromMarkdown({ markdown: "text", title: "t" });
    expect(html).toContain('name="viewport"');
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<link|@import|url\(/);
  });
});

describe("reportPageFromHtml", () => {
  it("keeps a whole document and adds a phone viewport when it has none", () => {
    const page = reportPageFromHtml({
      html: "<!doctype html><html><head><title>Свой</title></head><body>x</body></html>",
      title: "t",
    });
    expect(page.title).toBe("Свой");
    expect(page.html).toContain('<head>\n<meta name="viewport"');
    const own = '<!doctype html><head><meta name="viewport" content="x"></head>';
    expect(reportPageFromHtml({ html: own, title: "t" }).html).toBe(own);
  });

  it("wraps a fragment in the page", () => {
    const page = reportPageFromHtml({ html: "<h1>Отчёт</h1><p>x</p>", title: "t" });
    expect(page.html).toContain("Content-Security-Policy");
    expect(page.html).toContain("<h1>Отчёт</h1>");
  });
});
