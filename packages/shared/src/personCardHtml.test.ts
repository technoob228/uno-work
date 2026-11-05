import { describe, expect, it } from "vitest";

import { injectHtmlRenderBootstrap } from "./htmlRender.ts";
import { validatePersonCard, type PersonCard } from "./personCard.ts";
import { cardMarkdownToHtml, escapeCardText, renderPersonCardHtml } from "./personCardHtml.ts";

const card = (input: unknown): PersonCard => {
  const result = validatePersonCard(input);
  if (!result.ok) throw new Error(result.error);
  return result.card;
};

/** The markup we drew, without our own style and script. */
const markup = (html: string) =>
  html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<script>[\s\S]*?<\/script>/, "");

describe("renderPersonCardHtml: what the agent wrote stays text", () => {
  const hostile = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';

  it("escapes labels, prompts and descriptions, in text and in attributes", () => {
    const html = renderPersonCardHtml(
      card({
        kind: "choice",
        title: hostile.slice(0, 100),
        question: hostile,
        options: [
          { label: '"><b>x', description: hostile, prompt: `'" onclick="alert(3)` },
          { label: "B`${1}`" },
        ],
        allowOther: true,
      }),
    );
    const drawn = markup(html);
    expect(drawn).not.toContain("<script>alert");
    expect(drawn).not.toContain("<img src=x");
    expect(drawn).not.toContain("<b>x");
    expect(drawn).not.toMatch(/onclick="alert/);
    expect(drawn).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;");
    expect(drawn).toContain('data-prompt="&#39;&quot; onclick=&quot;alert(3)"');
    expect(drawn).toContain("B&#96;${1}&#96;");
    // One script, ours.
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it("escapes report text, tables, files and actions", () => {
    const html = renderPersonCardHtml(
      card({
        kind: "report",
        title: "</title><script>x</script>",
        summary: hostile,
        metrics: [
          { label: "<i>m</i>", value: "<b>1</b>", note: hostile.slice(0, 40), tone: "good" },
        ],
        sections: [
          {
            heading: hostile.slice(0, 100),
            table: { columns: ["<a>"], rows: [[hostile.slice(0, 150)]] },
          },
        ],
        files: ["/tmp/<x>.pdf"],
        actions: [{ label: "<go>", prompt: '"><script>' }],
      }),
    );
    const drawn = markup(html);
    expect(drawn).not.toMatch(/<script>|<img |<i>m|<b>1|<a>|<x>|<go>/);
    expect(html).toContain("<title>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title>");
  });

  it("keeps the agent's numbers away from the page checks", () => {
    // "100vh" in a card's text must not get the page rejected, nor a quoted path inlined.
    const text = escapeCardText('height: 100vh; see "/etc/secret.png"');
    expect(text).not.toMatch(/\dvh/);
    expect(text).not.toContain('"/etc');
    expect(text).toContain("100&#118;h");
  });
});

describe("renderPersonCardHtml: each kind", () => {
  it("draws a choice: options, the recommended one, Other, and how it sends", () => {
    const html = renderPersonCardHtml(
      card({
        kind: "choice",
        question: "Where should the bot run?",
        options: [
          { label: "Spark", description: "Free, sleeps between requests", recommended: true },
          { label: "Computer", prompt: "Put it on my computer, it needs a database" },
        ],
        allowOther: true,
      }),
    );
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('data-mode="single"');
    expect(html).toContain('<span class="badge">Recommended</span>');
    expect(html).toContain('data-prompt="Spark"');
    expect(html).toContain('data-prompt="Put it on my computer, it needs a database"');
    expect(html).toContain('placeholder="Other…"');
    expect(html).toContain("window.uno");
  });

  it("draws a multiple choice with a Send button", () => {
    const html = renderPersonCardHtml(
      card({ kind: "choice", question: "Which?", options: ["A", "B", "C"], multiple: true }),
    );
    expect(html).toContain('data-mode="multiple"');
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(3);
    expect(html).toContain("data-send disabled>Send</button>");
    expect(html).toContain('"Picked: "');
  });

  it("draws a quiz one question at a time, with the answers in data", () => {
    const html = renderPersonCardHtml(
      card({
        kind: "quiz",
        title: "Capitals",
        questions: [
          {
            question: "France?",
            options: ["Paris", "Lyon"],
            correct: 0,
            explanation: "Since 508.",
          },
          { question: "Pick the rivers", options: ["Nile", "Alps", "Rhine"], correct: [0, 2] },
        ],
      }),
    );
    expect(html.match(/<section class="q"/g)).toHaveLength(2);
    expect(html).toContain('data-correct="0" data-multi="false" aria-label="Question 1 of 2">');
    expect(html).toContain('data-correct="0,2" data-multi="true" hidden');
    expect(html).toContain('<p class="why">Since 508.</p>');
    expect(html).toContain("<b>1</b> of 2");
    expect(html.match(/<i class="seg/g)).toHaveLength(2);
    expect(html).toContain("right.");
  });

  it("draws a report: metrics, sections, a table, images, files, actions with the primary first", () => {
    const html = renderPersonCardHtml(
      card({
        kind: "report",
        title: "Weekly sales",
        summary: "Up 12% on last week.",
        metrics: [
          { label: "Revenue", value: "$4,210", note: "+12%", tone: "good" },
          { label: "Refunds", value: "3", tone: "bad" },
        ],
        sections: [
          { heading: "What changed", markdown: "- **Telegram** ads\n- New `pricing` page" },
          {
            table: {
              columns: ["Day", "Orders"],
              rows: [
                ["Mon", "12"],
                ["Tue", "1 204"],
              ],
            },
          },
        ],
        images: ["/home/me/chart.png", "/home/me/raw.png"],
        files: ["/home/me/report.pdf"],
        actions: [
          "Export CSV",
          { label: "Deploy", style: "primary", prompt: "Deploy the new page" },
        ],
      }),
      { images: [{ path: "/home/me/chart.png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }] },
    );
    expect(html).toContain('<div class="metric" data-tone="good">');
    expect(html).toContain("<strong>Telegram</strong>");
    expect(html).toContain("<code>pricing</code>");
    expect(html).toContain('<td class="num">1 204</td>');
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    // Not read yet: left for html_render to inline.
    expect(html).toContain('src="/home/me/raw.png"');
    expect(html).toContain('<span class="file-name">report.pdf</span><span class="ext">PDF</span>');
    const deploy = html.indexOf("Deploy the new page");
    expect(deploy).toBeGreaterThan(-1);
    expect(deploy).toBeLessThan(html.indexOf('data-prompt="Export CSV"'));
    expect(html).toContain('class="btn act plain" data-prompt="Export CSV"');
  });

  it("refuses a picture that isn't a data image", () => {
    const html = renderPersonCardHtml(card({ kind: "report", title: "x", images: ["/a.png"] }), {
      images: [{ path: "/a.png", dataUrl: "javascript:alert(1)" }],
    });
    expect(html).toContain('src="/a.png"');
    expect(html).not.toContain("javascript:");
  });

  it("gets the bridge and keeps its own head when published", () => {
    const page = injectHtmlRenderBootstrap(
      renderPersonCardHtml(card({ kind: "choice", question: "Q?", options: ["A", "B"] })),
    );
    expect(page.indexOf('<style id="t3-theme">')).toBeLessThan(page.indexOf("<title>"));
    expect(page).toContain("window.uno=uno");
    // No viewport units anywhere (html_render rejects them) and no --muted as a text color.
    expect(page).not.toMatch(/(?<![\w.+/])\d+(?:\.\d+)?[sld]?vh(?![\w-])/i);
    expect(page).not.toMatch(/(?<![\w-])(?:color|fill)\s*:\s*var\(\s*--muted\s*\)/);
  });
});

describe("cardMarkdownToHtml", () => {
  it("draws the subset", () => {
    expect(cardMarkdownToHtml("Hello **bold** and *it* and _it_ and ~~old~~\nnext line")).toBe(
      "<p>Hello <strong>bold</strong> and <em>it</em> and <em>it</em> and <del>old</del><br>next line</p>",
    );
    expect(cardMarkdownToHtml("- one\n- two\n\n3. three\n4. four")).toBe(
      '<ul><li>one</li><li>two</li></ul><ol start="3"><li>three</li><li>four</li></ol>',
    );
    expect(cardMarkdownToHtml("## Title\n> quoted\n\n---")).toBe(
      "<h3>Title</h3><blockquote>quoted</blockquote><hr>",
    );
    expect(cardMarkdownToHtml("```js\nconst a = '<b>';\n```")).toBe(
      "<pre><code>const a = &#39;&lt;b&gt;&#39;;</code></pre>",
    );
    expect(cardMarkdownToHtml("use `a*b*c` here")).toBe("<p>use <code>a*b*c</code> here</p>");
    expect(cardMarkdownToHtml("snake_case_name stays")).toBe("<p>snake_case_name stays</p>");
  });

  it("draws a Markdown table", () => {
    const html = cardMarkdownToHtml("| Plan | Price |\n|---|---:|\n| Small | $5 |\n| Plus | $30 |");
    expect(html).toContain('<th>Plan</th><th class="num">Price</th>');
    expect(html).toContain('<td>Small</td><td class="num">$5</td>');
  });

  it("links only to http(s), with code inside a link label", () => {
    expect(cardMarkdownToHtml("[docs](https://uno.place/a_b_c?x=1&y=2)")).toBe(
      '<p><a href="https://uno.place/a_b_c?x=1&amp;y=2">docs</a></p>',
    );
    expect(cardMarkdownToHtml("[`run`](https://uno.place)")).toBe(
      '<p><a href="https://uno.place"><code>run</code></a></p>',
    );
    expect(cardMarkdownToHtml("see https://uno.place/x.")).toBe(
      '<p>see <a href="https://uno.place/x">https://uno.place/x</a>.</p>',
    );
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<b>",
      "vbscript:x",
    ]) {
      const html = cardMarkdownToHtml(`[click](${url})`);
      expect(html).not.toContain("href");
      expect(html).toContain("click");
      expect(html).not.toContain("<b>");
    }
  });

  it("escapes raw HTML in Markdown", () => {
    const html = cardMarkdownToHtml('<img src=x onerror="alert(1)"> **<script>**');
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain("<strong>&lt;script&gt;</strong>");
  });
});
