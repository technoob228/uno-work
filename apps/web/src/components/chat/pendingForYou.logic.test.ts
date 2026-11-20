import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../session-logic";
import {
  derivePendingForYou,
  endingQuestion,
  ownLinksOf,
  pendingForYouSummary,
} from "./pendingForYou.logic";

let minute = 0;
const at = () => new Date(Date.UTC(2026, 10, 20, 10, minute++)).toISOString();

function msg(
  id: string,
  role: "user" | "assistant",
  text: string,
  sentByThreadId?: string,
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: at(),
    message: {
      id: id as never,
      role,
      text,
      createdAt: at(),
      streaming: false,
      ...(sentByThreadId ? { sentByThreadId: sentByThreadId as never } : {}),
    },
  };
}

function card(id: string, title: string): TimelineEntry {
  return {
    id,
    kind: "html-render",
    createdAt: at(),
    htmlRender: {
      attachmentId: id,
      path: `/x/${id}.html`,
      title,
      height: 300,
      source: "card",
    },
  };
}

const isOwnLink = (href: string) => href.includes(".uno4.me");
const base = { openedLinks: new Set<string>(), dismissedIds: new Set<string>(), isOwnLink };

describe("derivePendingForYou", () => {
  it("lists an unanswered card, links, answers to the person first", () => {
    const entries = [
      msg("u1", "user", "Can we ship Thursday?"),
      msg("a1", "assistant", "Your call:"),
      card("c-ship", "Ship on Thursday?"),
      msg("g1", "user", "From pricing: done", "h-pricing"),
      card("c-price", "Pricing"),
      msg("a2", "assistant", "Banners: [A](https://a.uno4.me) · [B](https://b.uno4.me/)."),
    ];
    const { items, marks } = derivePendingForYou({ ...base, entries });
    expect(items.map((item) => item.id)).toEqual(["c-ship", "c-price", "a2"]);
    expect(items[0]?.answersYou).toBe(true);
    expect(items[1]?.broughtByThreadId).toBe("h-pricing");
    expect(items[2]?.links).toHaveLength(2);
    expect(marks.get("c-price")).toBe("waiting");
  });

  it("a card answered from the card, or replaced by a newer one with its title, is gone", () => {
    const entries = [
      card("c1", "Pricing"),
      msg("g1", "user", "From pricing: more", "h-pricing"),
      card("c2", "Pricing"),
      card("c-ship", "Ship on Thursday?"),
      msg("u1", "user", "[from the card «Ship on Thursday?»]\nThursday"),
    ];
    const { items, marks } = derivePendingForYou({ ...base, entries });
    expect(items.map((item) => item.id)).toEqual(["c2"]);
    expect(marks.get("c1")).toBe("replaced");
  });

  it("links wait until each is opened; dismissed items go to hidden", () => {
    const entries = [msg("a1", "assistant", "Up: https://a.uno4.me and https://b.uno4.me")];
    const one = derivePendingForYou({
      ...base,
      entries,
      openedLinks: new Set(["https://a.uno4.me"]),
    });
    expect(one.items[0]?.links.map((link) => link.opened)).toEqual([true, false]);
    const both = derivePendingForYou({
      ...base,
      entries,
      openedLinks: new Set(["https://a.uno4.me", "https://b.uno4.me"]),
    });
    expect(both.items).toHaveLength(0);
    const hidden = derivePendingForYou({ ...base, entries, dismissedIds: new Set(["a1"]) });
    expect(hidden.items).toHaveLength(0);
    expect(hidden.hidden).toHaveLength(1);
  });

  it("a question counts only as the last word of the person's own turn", () => {
    const asked = derivePendingForYou({
      ...base,
      entries: [
        msg("u1", "user", "Deploy?"),
        msg("a1", "assistant", "Ready. Shall I deploy tonight?"),
        msg("g1", "user", "From QA: should I rerun?", "h-qa"),
        msg("a2", "assistant", "Do you want a rerun?"),
      ],
    });
    expect(asked.items.map((item) => [item.id, item.title])).toEqual([
      ["question:a1", "Shall I deploy tonight?"],
    ]);
    const answered = derivePendingForYou({
      ...base,
      entries: [
        msg("u1", "user", "Deploy?"),
        msg("a1", "assistant", "Shall I deploy tonight?"),
        msg("u2", "user", "Yes"),
      ],
    });
    expect(answered.items).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("own links, the ending question, the folded line", () => {
    expect(ownLinksOf("[A](https://a.uno4.me) and https://google.com", isOwnLink)).toEqual([
      { href: "https://a.uno4.me", label: "A" },
    ]);
    expect(endingQuestion("Done. Ship it?")).toBe("Ship it?");
    expect(endingQuestion("Done.")).toBeNull();
    expect(pendingForYouSummary([{ title: "A" }, { title: "B" }, { title: "C" }] as never, 2)).toBe(
      "A · B · +1",
    );
  });
});
