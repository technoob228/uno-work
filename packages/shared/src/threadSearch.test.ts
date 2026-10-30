import { describe, expect, it } from "vitest";

import {
  buildThreadSearchSnippet,
  countThreadSearchOccurrences,
  findThreadSearchOccurrences,
  messageSearchGrader,
  messageSearchMatchExpression,
  messageSearchTokens,
  threadSearchHighlightParts,
  threadSearchVisibleText,
} from "./threadSearch.ts";

describe("messageSearchTokens", () => {
  it("splits long tokens from the ones too short for the index", () => {
    expect(messageSearchTokens('"Deploy to Hostkey"')).toEqual({
      long: ["deploy", "hostkey"],
      short: ["to"],
    });
  });

  it("has nothing to look up for short words alone", () => {
    expect(messageSearchMatchExpression("to do")).toBeNull();
  });

  it("quotes tokens so FTS syntax cannot leak in", () => {
    // Tokens split on spaces; "or" is too short to look up.
    expect(messageSearchMatchExpression('foo" OR bar*')).toBe('"foo""" "bar*"');
  });
});

describe("messageSearchGrader", () => {
  it("ranks a whole word over a word start over the middle of a word", () => {
    const grade = messageSearchGrader("model");
    expect(grade("the model is ready")?.quality).toBe(1);
    expect(grade("models are ready")?.quality).toBe(0.8);
    expect(grade("remodel the kitchen")?.quality).toBe(0.3);
  });

  it("rejects a short token inside a word", () => {
    expect(messageSearchGrader("fts")("first drafts")).toBeNull();
    expect(messageSearchGrader("fts")("fts5 index")?.quality).toBe(0.8);
  });

  it("works on Russian text", () => {
    expect(messageSearchGrader("ДЕПЛОЙ")("обсуждали деплой вчера")?.quality).toBe(1);
  });

  it("needs every token and adds a bonus when they sit together", () => {
    const grade = messageSearchGrader("web socket");
    expect(grade("only web here")).toBeNull();
    expect(grade("the web socket reconnects")?.quality).toBe(1.25);
    expect(grade("socket on the web")?.quality).toBe(1);
  });

  it("points at the match", () => {
    expect(messageSearchGrader("target")("some words target more")?.offset).toBe(11);
  });
});

describe("occurrences", () => {
  it("counts and locates, ignoring case, without overlaps", () => {
    expect(countThreadSearchOccurrences("Aaa aAa", "aa")).toBe(2);
    expect(findThreadSearchOccurrences("foo Foo", "foo")).toEqual([0, 4]);
  });

  it("keeps offsets when a letter lowers to two units", () => {
    expect(findThreadSearchOccurrences("İstanbul foo", "foo")).toEqual([9]);
  });
});

describe("threadSearchVisibleText", () => {
  it("reads a link as its label", () => {
    expect(threadSearchVisibleText("see [the doc](https://example.com/secret)")).toBe(
      "see the doc",
    );
  });
});

describe("buildThreadSearchSnippet", () => {
  it("starts a little before the match, on a word, on one line", () => {
    const text = `${"word ".repeat(40)}the\n\nmatch **here** and more`;
    const snippet = buildThreadSearchSnippet(text, text.indexOf("match"));
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet).toContain("the match here and more");
  });

  it("stays within the limit and does not split an emoji", () => {
    const snippet = buildThreadSearchSnippet("😀".repeat(400), 200);
    expect(snippet.length).toBeLessThanOrEqual(240);
    expect(snippet).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
  });
});

describe("threadSearchHighlightParts", () => {
  it("marks each token and merges nothing it should not", () => {
    expect(threadSearchHighlightParts("Deploy the app", "deploy app")).toEqual([
      { text: "Deploy", match: true },
      { text: " the ", match: false },
      { text: "app", match: true },
    ]);
  });
});
