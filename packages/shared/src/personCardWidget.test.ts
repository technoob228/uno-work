import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { validatePersonCard, type PersonCard } from "./personCard.ts";
import {
  PERSON_CARD_WIDGET_LIMITS,
  renderPersonCardWidget,
  widgetMarkdownToHtml,
  widgetPickState,
  widgetQuizState,
  type PersonCardWidgetOptions,
  ruPlural,
} from "./personCardWidget.ts";

const card = (input: unknown): PersonCard => {
  const result = validatePersonCard(input);
  if (!result.ok) throw new Error(result.error);
  return result.card;
};

const zlibBytes = (html: string) => deflateSync(Buffer.from(html, "utf8"), { level: 9 }).length;
const PREFIX = "w1:AbCdEfGhIjKl:";
const fits = (html: string) => zlibBytes(html) <= 4000;
const options = (overrides: Partial<PersonCardWidgetOptions> = {}): PersonCardWidgetOptions => ({
  header: "💬 Fix the site",
  language: "en",
  requestPrefix: PREFIX,
  fits,
  ...overrides,
});

const render = (input: unknown, overrides: Partial<PersonCardWidgetOptions> = {}) => {
  const widget = renderPersonCardWidget(card(input), options(overrides));
  if (widget === null) throw new Error("not a widget");
  return widget;
};

const styleOf = (html: string) => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
const scriptOf = (html: string) => /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
const markupOf = (html: string) =>
  html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<script>[\s\S]*?<\/script>/, "");

// ── Realistic max-ish cards ───────────────────────────────────────────────

const lorem = (words: number, seed = 0) =>
  Array.from(
    { length: words },
    (_, index) =>
      ["plan", "fast", "server", "price", "backup", "region", "memory", "support", "disk"][
        (index * 7 + seed) % 9
      ],
  ).join(" ");

const BIG_CHOICE = {
  kind: "choice",
  title: "Pick a plan for the shop",
  question: "Which plan should the online shop move to before the sale?",
  options: Array.from({ length: 8 }, (_, index) => ({
    label: `Plan ${index + 1} ${lorem(2, index)}`,
    description: lorem(9, index),
    ...(index === 2 ? { recommended: true } : {}),
  })),
};

const BIG_QUIZ = {
  kind: "quiz",
  title: "European capitals",
  questions: Array.from({ length: 10 }, (_, index) => ({
    question: `Question ${index + 1}: which city is the capital of country number ${index + 1}?`,
    options: ["Lyon", "Paris", "Marseille", "Nice"].map((city) => `${city} ${index}`),
    correct: [index % 4],
    explanation: `Because ${lorem(10, index)}.`,
  })),
};

const BIG_REPORT = {
  kind: "report",
  title: "Site checked: 3 problems",
  summary: "Two are quick to fix; the third needs a new hosting plan.",
  metrics: [
    { label: "Speed", value: "92/100", tone: "good" },
    { label: "Errors", value: "3", tone: "bad", note: "+2 this week" },
    { label: "Pages", value: "41" },
    { label: "Visitors", value: "1 240", note: "last 7 days" },
    { label: "Uptime", value: "99.9%", tone: "good" },
    { label: "Size", value: "2.1 MB" },
  ],
  sections: [
    {
      heading: "Problems",
      markdown:
        "- **No favicon** on any page\n- Slow hero image (`hero.png`, 1.8 MB)\n- Broken link to [docs](https://example.com/docs)",
    },
    {
      heading: "Pages",
      table: {
        columns: ["Page", "Load", "Size"],
        rows: [
          ["/", "1.2 s", "800 KB"],
          ["/pricing", "0.9 s", "420 KB"],
          ["/blog", "2.4 s", "1.6 MB"],
        ],
      },
    },
    {
      heading: "Next steps",
      markdown: "1. Compress the image\n2. Add the favicon\n3. Move to Plus",
    },
  ],
  actions: [
    { label: "Fix both", style: "success" },
    { label: "Show me the image" },
    { label: "Leave it", style: "danger" },
  ],
};

describe("renderPersonCardWidget: every kind is a widget", () => {
  it("a single choice: options with keys, the recommended one marked; its words are the caption", () => {
    const widget = render({
      kind: "choice",
      question: "Which plan?",
      options: [
        { label: "Small", description: "$5, one bot" },
        { label: "Plus", recommended: true },
      ],
    });
    const markup = markupOf(widget.html);
    expect(markup).toContain('data-p="w1:AbCdEfGhIjKl:"');
    // Who speaks and the question are the message's text above the widget, not in it.
    expect(markup).not.toContain("Fix the site");
    expect(markup).not.toContain("Which plan?");
    expect(markup).toContain('<button class="o" data-i="0">');
    expect(markup).toContain('<button class="o r" data-i="1">');
    expect(markup).toContain("⭐ recommended");
    expect(markup).toContain('<span class="d">$5, one bot</span>');
    expect(markup).not.toContain('class="bt pr go');
    expect(widget.caption).toBe("💬 Fix the site\nWhich plan?");
    expect(widget.captionBold).toEqual({
      offset: "💬 Fix the site\n".length,
      length: "Which plan?".length,
    });
    expect(widget.chatData).toBeUndefined();
  });

  it("a multiple choice: toggles and Done, in Russian", () => {
    const widget = render(
      {
        kind: "choice",
        question: "Какие страницы?",
        options: ["Главная", "Цены"],
        multiple: true,
        allowOther: true,
      },
      { language: "ru", header: null },
    );
    const markup = markupOf(widget.html);
    expect(markup).toContain(" data-m>");
    expect(scriptOf(widget.html)).toContain('"Не отправилось, нажмите ещё раз"');
    expect(scriptOf(widget.html)).not.toContain("Not sent");
    expect(markup).toContain('<div class="os m">');
    expect(markup).toContain(">Готово</button>");
    expect(markup).toContain("Можно выбрать несколько · Или напишите свой ответ в чат");
    expect(markup).not.toContain('class="hd"');
    expect(widget.caption).toBe("Какие страницы?");
    expect(widget.captionBold).toEqual({ offset: 0, length: "Какие страницы?".length });
  });

  it("a report: metric tiles with tones, sections folded (first open), a table, actions", () => {
    const widget = render(BIG_REPORT);
    const markup = markupOf(widget.html);
    expect(markup).toContain(
      '<div class="mx m3"><div class="mt g"><p class="ml">Speed</p><p class="mv">92/100</p></div>',
    );
    expect(markup).toContain('<div class="mt bd">');
    expect(markup).toContain("<div><details open><summary>Problems</summary>");
    expect(markup).toContain("<details><summary>Pages</summary>");
    expect(markup).toContain("<table>");
    expect(markup).toContain('<a href="https://example.com/docs">docs</a>');
    // The success action goes first (no explicit primary, the first plain one is primary).
    expect(markup).toMatch(
      /<div class="ac"><button class="bt a pr" data-i="1">Show me the image<\/button><button class="bt a su" data-i="0">Fix both<\/button><button class="bt a da" data-i="2">Leave it<\/button><\/div>/,
    );
    // The title and the summary are the caption; the widget starts with the numbers.
    expect(widget.caption.startsWith("💬 Fix the site\nSite checked: 3 problems")).toBe(true);
    expect(widget.caption).not.toContain("Speed");
    expect(markup).not.toContain("Site checked: 3 problems");
  });

  it("a short report with one section shows it flat", () => {
    const markup = markupOf(
      render({
        kind: "report",
        title: "Done",
        sections: [{ heading: "Notes", markdown: "All good." }],
      }).html,
    );
    expect(markup).toContain(
      '<div class="sc"><p class="sh">Notes</p><div class="md"><p>All good.</p></div></div>',
    );
    expect(markup).not.toContain("<details");
  });

  it("a quiz: one question at a time, the right answers in data-c, a score screen", () => {
    const widget = render({
      kind: "quiz",
      title: "Capitals",
      questions: [
        {
          question: "Capital of France?",
          options: ["Lyon", "Paris"],
          correct: [1],
          explanation: "Paris since 508.",
        },
        { question: "Pick the rivers", options: ["Seine", "Rome", "Rhine"], correct: [0, 2] },
      ],
    });
    const markup = markupOf(widget.html);
    expect(markup).toContain('<section class="qq" data-c="1">');
    expect(markup).toContain('<section class="qq" data-c="0,2" hidden>');
    expect(markup).toContain("Pick all that are right");
    expect(markup).toContain('<p class="ex" hidden><b></b>Paris since 508.</p>');
    expect(markup).toContain('<span class="t l">Lyon</span>');
    expect(markup).toContain('<div class="pg"><i></i><i></i></div>');
    expect(markup).toContain('<section id="sc" hidden>');
    expect(widget.caption).toBe("💬 Fix the site\n🧩 Capitals · 2 questions");
    expect(markup).not.toContain('class="qh"');
  });
});

describe("ruPlural", () => {
  it("1 вопрос, 3 вопроса, 5 вопросов, 11 вопросов, 21 вопрос", () => {
    const words = (count: number) => ruPlural(count, "вопрос", "вопроса", "вопросов");
    expect([1, 2, 3, 4, 5, 10, 11, 12, 14, 21, 22, 25].map(words)).toEqual([
      "вопрос",
      "вопроса",
      "вопроса",
      "вопроса",
      "вопросов",
      "вопросов",
      "вопросов",
      "вопросов",
      "вопросов",
      "вопрос",
      "вопроса",
      "вопросов",
    ]);
  });
});

describe("renderPersonCardWidget: what the agent wrote stays text", () => {
  const hostile = '</script><script>alert(1)</script><!--"><img src=x onerror=alert(2)>';

  it("escapes every text of every kind; the script holds none of it", () => {
    const widgets = [
      render({
        kind: "choice",
        title: hostile.slice(0, 100),
        question: hostile,
        options: [{ label: hostile.slice(0, 60), description: hostile }, "B"],
      }),
      render({
        kind: "report",
        title: hostile.slice(0, 100),
        summary: hostile,
        metrics: [{ label: hostile.slice(0, 40), value: hostile.slice(0, 40), note: "x" }],
        sections: [
          { heading: hostile.slice(0, 100), markdown: hostile },
          { markdown: "[x](javascript:alert(1))" },
        ],
        actions: [hostile.slice(0, 40)],
      }),
      render({
        kind: "quiz",
        title: hostile.slice(0, 100),
        questions: [
          {
            question: hostile,
            options: [hostile.slice(0, 60), "B"],
            correct: [0],
            explanation: hostile,
          },
        ],
      }),
    ];
    for (const widget of widgets) {
      const markup = markupOf(widget.html);
      expect(markup).not.toContain("<script");
      expect(markup).not.toContain("</script");
      expect(markup).not.toContain("<!--");
      expect(markup).not.toContain("<img");
      expect(markup).not.toContain("javascript:");
      expect(markup).toContain("&lt;/script&gt;");
      expect(widget.html.match(/<script>/g)).toHaveLength(1);
      expect(scriptOf(widget.html)).not.toContain("alert");
    }
    // Header too.
    const markup = markupOf(
      render({ kind: "choice", question: "Q", options: ["A", "B"] }, { header: hostile }).html,
    );
    expect(markup).not.toContain("<img");
  });

  it("only https links survive the Markdown", () => {
    expect(widgetMarkdownToHtml("[a](http://example.com) and [b](https://example.com)")).toBe(
      '<p>a and <a href="https://example.com">b</a></p>',
    );
  });
});

describe("renderPersonCardWidget: Telegram's sandbox", () => {
  const samples = () => [
    render(BIG_CHOICE),
    // 8 options, toggles and Done: no room for a title as well.
    render({ ...BIG_CHOICE, title: undefined, multiple: true }),
    render(BIG_QUIZ),
    render(BIG_REPORT),
  ];

  it("no tags or CSS the sandbox drops", () => {
    for (const widget of samples()) {
      const markup = markupOf(widget.html);
      for (const tag of [
        "<input",
        "<select",
        "<textarea",
        "<iframe",
        "<link",
        "<meta",
        "<form",
        "<img",
      ]) {
        expect(markup).not.toContain(tag);
      }
      expect(widget.html).not.toMatch(/\ssrc=/);
      for (const href of widget.html.matchAll(/href="([^"]*)"/g)) {
        expect(href[1]).toMatch(/^https:\/\//);
      }
      const style = styleOf(widget.html);
      expect(style).not.toMatch(/\d(vh|dvh|svh|lvh)\b/);
      for (const banned of [
        ":has(",
        "color-mix",
        "oklch",
        "sticky",
        "@import",
        "@font-face",
        "clip-path",
        "text-shadow",
        "overflow:auto",
        "overflow:scroll",
        ":focus",
        ":checked",
      ]) {
        expect(style).not.toContain(banned);
      }
    }
  });

  it("requests stay within 64 bytes", () => {
    // The longest: the prefix, question 9, all eight bits.
    expect(Buffer.byteLength(`${PREFIX}9.ff`)).toBeLessThanOrEqual(
      PERSON_CARD_WIDGET_LIMITS.requestBytes,
    );
    expect(
      Buffer.byteLength(
        widgetQuizState(
          Array.from({ length: 10 }, () => [0, 1, 2, 3, 4, 5, 6, 7]),
          true,
        ),
      ),
    ).toBeLessThanOrEqual(PERSON_CARD_WIDGET_LIMITS.chatDataBytes);
    expect(widgetPickState([0, 2], true)).toBe('{"p":[0,2],"d":1}');
    expect(widgetQuizState([[1]], false)).toBe('{"a":[[1]]}');
  });

  it("realistic max-ish cards fit 32768 bytes and 4096 zlib bytes", () => {
    const sizes = samples().map((widget) => ({
      bytes: Buffer.byteLength(widget.html),
      zlib: zlibBytes(widget.html),
    }));
    for (const size of sizes) {
      expect(size.bytes).toBeLessThanOrEqual(PERSON_CARD_WIDGET_LIMITS.htmlBytes);
      expect(size.zlib).toBeLessThanOrEqual(4000);
    }
    // Printed for the release notes (sizes of the sample cards).
  });
});

describe("renderPersonCardWidget: where it can't be a widget", () => {
  it("a report with pictures → null (the Rich Message embeds them)", () => {
    expect(
      renderPersonCardWidget(
        card({ kind: "report", title: "Shots", images: ["/tmp/a.png"] }),
        options(),
      ),
    ).toBeNull();
  });

  it("a report whose section would clip at 600 px → null", () => {
    const long = Array.from(
      { length: 60 },
      (_, index) => `- line ${index} ${lorem(6, index)}`,
    ).join("\n");
    expect(
      renderPersonCardWidget(
        card({ kind: "report", title: "Long", sections: [{ heading: "All", markdown: long }] }),
        options(),
      ),
    ).toBeNull();
  });

  it("a wide or long table → null", () => {
    const wide = {
      columns: ["a", "b", "c", "d", "e", "f"],
      rows: [["1", "2", "3", "4", "5", "6"]],
    };
    expect(
      renderPersonCardWidget(
        card({ kind: "report", title: "T", sections: [{ table: wide }] }),
        options(),
      ),
    ).toBeNull();
    const long = {
      columns: ["a", "b"],
      rows: Array.from({ length: 30 }, (_, index) => [`${index}`, "x"]),
    };
    expect(
      renderPersonCardWidget(
        card({ kind: "report", title: "T", sections: [{ table: long }] }),
        options(),
      ),
    ).toBeNull();
  });

  it("8 options with long descriptions: cut to one line to fit 600 px, not the card", () => {
    const tall = {
      ...BIG_CHOICE,
      options: BIG_CHOICE.options.map((option) => ({ ...option, description: lorem(30) })),
    };
    const markup = markupOf(render(tall).html);
    expect(markup).toContain('<div class="os d1">');
    expect(markup).toContain('class="d"');
    expect(markup).toContain("Plan 8");
  });

  it("8 options with two-line labels: descriptions dropped to fit 600 px", () => {
    const tall = {
      ...BIG_CHOICE,
      options: BIG_CHOICE.options.map((option, index) => ({
        ...option,
        label: `Plan ${index + 1} ${"with a long name ".repeat(4)}`.slice(0, 58).trim(),
      })),
    };
    const markup = markupOf(render(tall).html);
    expect(markup).not.toContain('class="d"');
    expect(markup).toContain("Plan 8");
  });

  it("6 options with descriptions fit whole (the question is above the widget)", () => {
    const six = { ...BIG_CHOICE, title: undefined, options: BIG_CHOICE.options.slice(0, 6) };
    const markup = markupOf(render(six).html);
    expect(markup).not.toContain("os d1");
    expect(markup).toContain('class="d"');
  });

  it("over the compressed budget: descriptions go first, then null", () => {
    const small = {
      kind: "choice",
      question: "Which plan?",
      options: [
        { label: "Small", description: "$5, one bot" },
        { label: "Plus", description: "$20, a whole computer", recommended: true },
        { label: "Pro", description: "$90, two regions" },
      ],
    };
    const full = render(small, { fits: () => true });
    expect(markupOf(full.html)).toContain('class="d"');
    // A budget only the card without descriptions meets.
    const lean = renderPersonCardWidget(
      card(small),
      options({ fits: (html) => html.length < full.html.length - 50 }),
    );
    expect(lean).not.toBeNull();
    expect(markupOf(lean!.html)).not.toContain('class="d"');
    expect(renderPersonCardWidget(card(small), options({ fits: () => false }))).toBeNull();
  });

  it("where the zlib boundary is: a 10-question quiz whose text a compressor can't shrink", () => {
    // Words a compressor can't reuse: every question and explanation unique.
    const noisy = (seed: number, length: number) =>
      Array.from({ length }, (_, index) =>
        ((seed * 7919 + index * 104_729) % 1_000_003).toString(36),
      )
        .join(" ")
        .slice(0, 290);
    const outcome = (words: number) => {
      const widget = renderPersonCardWidget(
        card({
          kind: "quiz",
          title: "Noise",
          questions: Array.from({ length: 10 }, (_, index) => ({
            question: noisy(index + 1, words),
            options: ["Yes", "No"],
            correct: [0],
            explanation: noisy(index + 50, words),
          })),
        }),
        options(),
      );
      return widget === null
        ? "none"
        : markupOf(widget.html).includes("</b></p>")
          ? "lean"
          : "full";
    };
    const table = Object.fromEntries(
      [2, 5, 10, 15, 20, 30, 45, 60].map((words) => [words, outcome(words)]),
    );
    // Pinned (see the printed table): short questions fit whole, longer ones
    // only without explanations, past that it is not a widget (polls instead).
    expect(table[2]).toBe("full");
    expect(table[60]).toBe("none");
    const order = ["full", "lean", "none"];
    const seen = Object.values(table).map((value) => order.indexOf(value));
    expect(seen).toEqual(seen.toSorted((left, right) => left - right));
  });

  it("a Russian 10-question quiz: its size", () => {
    const quiz = {
      kind: "quiz",
      title: "Столицы Европы",
      questions: Array.from({ length: 10 }, (_, index) => ({
        question: `Вопрос ${index + 1}: какой город — столица страны номер ${index + 1}?`,
        options: ["Лион", "Париж", "Марсель", "Ницца"].map((city) => `${city} ${index}`),
        correct: [index % 4],
        explanation: `Потому что так решили в ${1500 + index} году, и с тех пор ничего не менялось.`,
      })),
    };
    const widget = renderPersonCardWidget(card(quiz), options({ language: "ru" }));
    const size =
      widget === null
        ? null
        : {
            bytes: Buffer.byteLength(widget.html),
            zlib: zlibBytes(widget.html),
            explanations: !markupOf(widget.html).includes("</b></p>"),
          };
    expect(widget).not.toBeNull();
  });
});
