import { describe, expect, it } from "vitest";

import {
  formatHandedBrief,
  formatHandedNote,
  formatHandedReply,
  HANDED_BRIEF_PREFIX,
  HANDED_DEFAULT_EXPECTED,
  parseHandedBrief,
  parseHandedNote,
  parseHandedReply,
} from "./handedChat.ts";

describe("handedChat", () => {
  it("brief round-trips for the card", () => {
    const text = formatHandedBrief({
      threadId: "t-1",
      title: "Pricing «page»",
      about: "Build the /pricing page:\ncopy, Stripe checkout",
      now: "Copy done, checkout in test mode.",
      expected: "take it to launch, ask me only about money",
    });
    expect(text.startsWith(HANDED_BRIEF_PREFIX)).toBe(true);
    expect(text).toContain("chat_message (threadId t-1)");
    expect(parseHandedBrief(text)).toEqual({
      threadId: "t-1",
      title: 'Pricing "page"',
      computer: null,
      about: "Build the /pricing page: copy, Stripe checkout",
      now: "Copy done, checkout in test mode.",
      expected: "take it to launch, ask me only about money",
    });
  });

  it("no note: the default expectation", () => {
    const text = formatHandedBrief({
      threadId: "t",
      title: "x",
      about: "",
      now: "",
      expected: null,
    });
    expect(parseHandedBrief(text)?.expected).toBe(HANDED_DEFAULT_EXPECTED);
    expect(parseHandedBrief("hello")).toBeNull();
  });

  it("notes read in the person's words", () => {
    expect(
      parseHandedNote(formatHandedNote({ kind: "taken-back", threadId: "t", title: "Pricing" })),
    ).toEqual({ kind: "taken-back", threadId: "t", line: "You took back “Pricing”." });
    expect(
      parseHandedNote(
        formatHandedNote({
          kind: "person-wrote",
          threadId: "t",
          title: "Pricing",
          text: "Use «Pro»",
        }),
      ),
    ).toEqual({ kind: "person-wrote", threadId: "t", line: 'You wrote in “Pricing”: Use "Pro"' });
    expect(
      parseHandedNote(
        formatHandedNote({ kind: "handed-elsewhere", threadId: "t", title: "Pricing" }),
      )?.kind,
    ).toBe("handed-elsewhere");
    expect(parseHandedNote("hi")).toBeNull();
  });
});

describe("a brief for a handler on another computer (T63-C)", () => {
  it("says where the chat lives, and the card reads it back", () => {
    const text = formatHandedBrief({
      threadId: "t-mac",
      title: "Landing page",
      about: "Build the landing",
      now: "Hero done",
      expected: null,
      computer: "Misha's MacBook",
    });
    expect(text).toContain("(threadId t-mac) on “Misha's MacBook”.");
    expect(text).toContain("chat_message (threadId t-mac) reaches it within a minute");
    expect(parseHandedBrief(text)).toMatchObject({
      threadId: "t-mac",
      title: "Landing page",
      computer: "Misha's MacBook",
    });
    expect(
      parseHandedBrief(
        formatHandedBrief({ threadId: "t", title: "x", about: "", now: "", expected: null }),
      )?.computer,
    ).toBeNull();
  });
});

describe("a handed chat's agent writes to its handler on another computer (T63-C)", () => {
  it("names the chat and its computer, and is no note", () => {
    const text = formatHandedReply({
      threadId: "c-1",
      title: "Pricing page",
      computer: "Mac",
      text: "Shorter: «Fresh bread, fair prices.»",
    });
    expect(text).toBe(
      "From the agent in «Pricing page» (threadId c-1) on “Mac”, the chat you handle:\n\nShorter: «Fresh bread, fair prices.»",
    );
    expect(parseHandedNote(text)).toBeNull();
    expect(parseHandedReply(text)).toEqual({
      title: "Pricing page",
      threadId: "c-1",
      computer: "Mac",
      text: "Shorter: «Fresh bread, fair prices.»",
    });
    expect(parseHandedReply("hello")).toBeNull();
  });
});
