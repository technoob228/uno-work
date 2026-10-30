import { describe, expect, it } from "vitest";

import {
  parsePromptLink,
  PROMPT_LINK_MAX_PROMPT_LENGTH,
  promptLinkAppPath,
  sanitizeLinkedPrompt,
} from "./promptLinks.ts";

describe("sanitizeLinkedPrompt", () => {
  it("removes what a person can't see and counts it", () => {
    const hidden = String.fromCodePoint(0xe0041);
    expect(sanitizeLinkedPrompt(`Fix\u200B the${hidden} build\u202E`)).toEqual({
      text: "Fix the build",
      hiddenCharacters: 3,
    });
  });

  it("removes the composer's own placeholder", () => {
    expect(sanitizeLinkedPrompt("before \uFFFC after").text).toBe("before  after");
  });

  it("keeps emoji sequences", () => {
    expect(sanitizeLinkedPrompt("\u{1F469}\u200D\u{1F4BB} ship it")).toEqual({
      text: "\u{1F469}\u200D\u{1F4BB} ship it",
      hiddenCharacters: 0,
    });
  });
});

describe("parsePromptLink", () => {
  it("reads the prompt, numbers stay text", () => {
    expect(parsePromptLink("?prompt=123")).toEqual({
      ok: true,
      value: { text: "123", hiddenCharacters: 0 },
    });
  });

  it("refuses a link without a prompt, an empty one and a long one", () => {
    expect(parsePromptLink("?foo=1").ok).toBe(false);
    expect(parsePromptLink("?prompt=%20%20").ok).toBe(false);
    const long = `?prompt=${"x".repeat(PROMPT_LINK_MAX_PROMPT_LENGTH + 1)}`;
    expect(parsePromptLink(long).ok).toBe(false);
  });

  it("refuses a prompt of only hidden characters and says why", () => {
    const parsed = parsePromptLink(`?prompt=${encodeURIComponent("\u200B\u200B")}`);
    expect(parsed).toEqual({
      ok: false,
      error: "This prompt had only hidden characters, so it may be malicious. Work didn't open it.",
    });
  });
});

describe("promptLinkAppPath", () => {
  it("opens only the new chat route", () => {
    expect(promptLinkAppPath("uno-work://new?prompt=hi%20there")).toBe("/new?prompt=hi+there");
    expect(promptLinkAppPath("uno-work://settings?prompt=hi")).toBeNull();
    expect(promptLinkAppPath("uno-work://new/../settings?prompt=hi")).toBeNull();
    expect(promptLinkAppPath("https://uno.place/new?prompt=hi")).toBeNull();
    expect(promptLinkAppPath("uno-work://new")).toBeNull();
    expect(promptLinkAppPath("not a url")).toBeNull();
  });

  it("drops everything but the prompt", () => {
    expect(promptLinkAppPath("uno-work://new?prompt=a&send=1&model=x")).toBe("/new?prompt=a");
  });
});
