import { describe, expect, it } from "vitest";

import {
  type MarkdownEditedBlock,
  type MarkdownSourceBlock,
  htmlBlockToMarkdown,
  parseMarkdownEditMode,
  serializeEditedMarkdown,
} from "./markdownDocumentEdit";

/** Source blocks for the given pieces of `source`, each rendered as `<p>` with the piece as text. */
function blocksOf(source: string, pieces: ReadonlyArray<string>): MarkdownSourceBlock[] {
  let from = 0;
  return pieces.map((piece) => {
    const start = source.indexOf(piece, from);
    from = start + piece.length;
    return { start, end: from, html: piece };
  });
}

const untouched = (blocks: ReadonlyArray<MarkdownSourceBlock>): MarkdownEditedBlock[] =>
  blocks.map((block, index) => ({
    index,
    innerHtml: block.html,
    outerHtml: `<p>${block.html}</p>`,
  }));

describe("parseMarkdownEditMode", () => {
  it("the document unless the person chose code", () => {
    expect(parseMarkdownEditMode(null)).toBe("document");
    expect(parseMarkdownEditMode("junk")).toBe("document");
    expect(parseMarkdownEditMode("code")).toBe("code");
  });
});

describe("serializeEditedMarkdown", () => {
  const source =
    "\n# Title\n\nFirst *para*\nwrapped.\n\n\n* one\n* two\n\n[ref]: https://example.com\n";
  const blocks = blocksOf(source, ["# Title", "First *para*\nwrapped.", "* one\n* two"]);

  it("an untouched document is the source, byte for byte", () => {
    expect(serializeEditedMarkdown({ source, blocks, edited: untouched(blocks) })).toBe(source);
  });

  it("only the touched block is written anew", () => {
    const edited = untouched(blocks);
    edited[1] = {
      index: 1,
      innerHtml: "changed",
      outerHtml: "<p>First <em>para</em> changed.</p>",
    };
    expect(serializeEditedMarkdown({ source, blocks, edited })).toBe(
      "\n# Title\n\nFirst *para* changed.\n\n\n* one\n* two\n\n[ref]: https://example.com\n",
    );
  });

  it("a deleted block goes, what doesn't show around it stays", () => {
    const edited = untouched(blocks).slice(0, 2);
    expect(serializeEditedMarkdown({ source, blocks, edited })).toBe(
      "\n# Title\n\nFirst *para*\nwrapped.\n\n[ref]: https://example.com\n",
    );
    const emptied = untouched(blocks);
    emptied[1] = { index: 1, innerHtml: "<br>", outerHtml: "<p><br></p>" };
    expect(serializeEditedMarkdown({ source, blocks, edited: emptied })).toBe(
      "\n# Title\n\n* one\n* two\n\n[ref]: https://example.com\n",
    );
  });

  it("a new block lands where the person put it", () => {
    const edited = untouched(blocks);
    edited.splice(1, 0, { index: null, innerHtml: "New", outerHtml: "<div>New</div>" });
    expect(serializeEditedMarkdown({ source, blocks, edited })).toBe(
      "\n# Title\n\nNew\n\nFirst *para*\nwrapped.\n\n\n* one\n* two\n\n[ref]: https://example.com\n",
    );
  });

  it("a paragraph split by Enter: the copy carrying the same block is new text", () => {
    const edited = untouched(blocks);
    // The browser clones the paragraph, attributes and all.
    edited.splice(2, 0, { index: 1, innerHtml: "second half", outerHtml: "<p>second half</p>" });
    expect(serializeEditedMarkdown({ source, blocks, edited })).toBe(
      "\n# Title\n\nFirst *para*\nwrapped.\n\nsecond half\n\n* one\n* two\n\n[ref]: https://example.com\n",
    );
  });

  it("an empty file takes the first line typed", () => {
    expect(
      serializeEditedMarkdown({
        source: "",
        blocks: [],
        edited: [{ index: null, innerHtml: "Hello", outerHtml: "<p>Hello</p>" }],
      }),
    ).toBe("Hello\n");
    expect(
      serializeEditedMarkdown({
        source: "",
        blocks: [],
        edited: [{ index: null, innerHtml: "<br>", outerHtml: "<p><br></p>" }],
      }),
    ).toBe("");
  });

  it("everything deleted leaves only what doesn't show", () => {
    expect(serializeEditedMarkdown({ source, blocks, edited: [] })).toBe(
      "[ref]: https://example.com\n",
    );
  });
});

describe("htmlBlockToMarkdown", () => {
  it("headings, emphasis, links and code", () => {
    expect(htmlBlockToMarkdown("<h2>Plan</h2>")).toBe("## Plan");
    expect(
      htmlBlockToMarkdown(
        '<p><strong>Bold</strong>, <em>soft</em>, <a href="https://x.y">link</a></p>',
      ),
    ).toBe("**Bold**, *soft*, [link](https://x.y)");
    expect(htmlBlockToMarkdown('<pre><code class="language-ts">const a = 1;\n</code></pre>')).toBe(
      "```ts\nconst a = 1;\n```",
    );
  });

  it("spaces the browser made non-breaking are plain again", () => {
    expect(htmlBlockToMarkdown("<p>End.&nbsp;More</p>")).toBe("End. More");
  });

  it("the break the browser leaves at a line's end is dropped, one inside the text stays", () => {
    expect(htmlBlockToMarkdown("<ul><li>task<br></li><li>next</li></ul>")).toBe("- task\n- next");
    expect(htmlBlockToMarkdown("<p>one<br>two</p>")).toBe("one  \ntwo");
    expect(htmlBlockToMarkdown("<p><strike>old</strike></p>")).toBe("~~old~~");
  });

  it("strikethrough and task lists", () => {
    expect(htmlBlockToMarkdown("<p><del>old</del> new</p>")).toBe("~~old~~ new");
    expect(
      htmlBlockToMarkdown(
        '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled checked=""> done</li><li class="task-list-item"><input type="checkbox" disabled> todo</li></ul>',
      ),
    ).toBe("- [x] done\n- [ ] todo");
  });

  it("a footnote's mark stays a footnote", () => {
    expect(
      htmlBlockToMarkdown(
        '<p>Text.<sup><a href="#user-content-fn-note" id="user-content-fnref-note" data-footnote-ref="" aria-describedby="footnote-label">1</a></sup></p>',
      ),
    ).toBe("Text.[^note]");
  });

  it("lists read the way people write them", () => {
    expect(htmlBlockToMarkdown("<ul><li>one</li><li>two<ul><li>inner</li></ul></li></ul>")).toBe(
      "- one\n- two\n  - inner",
    );
    expect(htmlBlockToMarkdown('<ol start="3"><li>three</li><li>four</li></ol>')).toBe(
      "3. three\n4. four",
    );
  });

  it("tables stay tables, with their alignment", () => {
    expect(
      htmlBlockToMarkdown(
        '<table><thead><tr><th>Name</th><th style="text-align: right;">Price</th></tr></thead><tbody><tr><td>A | B</td><td style="text-align: right;">$5</td></tr></tbody></table>',
      ),
    ).toBe("| Name | Price |\n| --- | --: |\n| A \\| B | $5 |");
  });
});
