import { describe, expect, it } from "vitest";

import {
  applyPendingPersonAction,
  derivePendingForYouState,
  isOwnSiteLink,
  ownLinksOf,
  parsePendingForYouState,
  pendingFeedOf,
  pendingForYouSummary,
  pendingForYouView,
  stepPendingForYou,
  type PendingFeedEntry,
} from "./pendingForYou.ts";

let minute = 0;
const at = () => new Date(Date.UTC(2026, 10, 23, 10, minute++)).toISOString();
const SINCE = new Date(Date.UTC(2026, 10, 23, 9)).toISOString();

const msg = (
  id: string,
  role: "user" | "assistant",
  text: string,
  sentByThreadId: string | null = null,
): PendingFeedEntry => ({ type: "message", id, role, text, sentByThreadId, createdAt: at() });

const card = (
  id: string,
  title: string,
  extra: { waitsForAnswer?: boolean; replaces?: string } = { waitsForAnswer: true },
): PendingFeedEntry => ({
  type: "page",
  activityId: `act-${id}`,
  createdAt: at(),
  page: { attachmentId: id, path: `/x/${id}.html`, title, height: 300, source: "card", ...extra },
});

const view = (entries: PendingFeedEntry[]) =>
  pendingForYouView(derivePendingForYouState(SINCE, entries));

describe("pendingForYou", () => {
  it("lists an unanswered card and links, answers to the person first", () => {
    const { items } = view([
      msg("g0", "user", "From pricing: started", "h-pricing"),
      card("c-price", "Pricing"),
      msg("u1", "user", "Can we ship Thursday?"),
      card("c-ship", "Ship on Thursday?"),
      msg("a2", "assistant", "Banners: [A](https://a.uno4.me) · [B](https://b.uno4.me/)."),
    ]);
    expect(items.map((item) => item.id)).toEqual(["card:c-ship", "links:a2", "card:c-price"]);
    expect(items[0]?.answersYou).toBe(true);
    expect(items[0]?.activityId).toBe("act-c-ship");
    expect(items[2]?.broughtByThreadId).toBe("h-pricing");
    expect(items[1]?.links.map((link) => link.label)).toEqual(["A", "B"]);
  });

  it("a card is answered from the card, replaced by the same title or by replaces", () => {
    const result = view([
      card("c1", "Pricing"),
      card("c2", "Pricing"),
      card("c-ship", "Ship on Thursday?"),
      card("c-old", "Banner copy"),
      card("c-new", "Banner copy v2", { waitsForAnswer: true, replaces: "c-old" }),
      msg("u1", "user", "[from the card «Ship on Thursday?»]\nThursday"),
    ]);
    expect(result.items.map((item) => item.id)).toEqual(["card:c2", "card:c-new"]);
    expect(result.replacedActivityIds).toEqual(["act-c1", "act-c-old"]);
  });

  it("a report to look at, an old card, and anything before since are not listed", () => {
    const early: PendingFeedEntry = {
      type: "page",
      activityId: "act-early",
      createdAt: new Date(Date.UTC(2026, 10, 23, 8)).toISOString(),
      page: {
        attachmentId: "early",
        path: "/x/early.html",
        title: "Early",
        height: 1,
        source: "card",
        waitsForAnswer: true,
      },
    };
    const { items } = view([
      early,
      card("report", "Done", { waitsForAnswer: false }),
      card("old", "From 0.0.190", {}),
      msg("a1", "assistant", "Dev server: http://localhost:5173 and https://github.com/x"),
    ]);
    expect(items).toEqual([]);
  });

  it("links wait until each is opened; hidden items and Show again", () => {
    let state = derivePendingForYouState(SINCE, [
      msg("a1", "assistant", "Up: https://a.uno4.me and https://b.uno4.me"),
    ]);
    state = applyPendingPersonAction(state, { opened: ["https://a.uno4.me/"] });
    expect(pendingForYouView(state).items[0]?.links.map((link) => link.opened)).toEqual([
      true,
      false,
    ]);
    const hidden = applyPendingPersonAction(state, { dismiss: ["links:a1"] });
    expect(pendingForYouView(hidden).items).toEqual([]);
    expect(pendingForYouView(hidden).hidden.map((item) => item.id)).toEqual(["links:a1"]);
    const back = applyPendingPersonAction(hidden, { restore: ["links:a1"] });
    expect(pendingForYouView(back).items).toHaveLength(1);
    const done = applyPendingPersonAction(state, { opened: ["https://b.uno4.me#top"] });
    expect(pendingForYouView(done).items).toEqual([]);
  });

  it("a link already waiting is not listed twice; a message folded again stays one item", () => {
    let state = derivePendingForYouState(SINCE, [
      msg("g1", "user", "From banners: https://a.uno4.me", "h-banners"),
      msg("a1", "assistant", "Relaying: https://a.uno4.me"),
    ]);
    expect(pendingForYouView(state).items.map((item) => item.id)).toEqual(["links:g1"]);
    const again = msg("g1", "user", "From banners: https://a.uno4.me", "h-banners");
    state = stepPendingForYou(state, again);
    expect(pendingForYouView(state).items).toHaveLength(1);
  });

  it("the stored state round-trips; a broken one reads as none", () => {
    const state = derivePendingForYouState(SINCE, [card("c1", "Pricing")]);
    expect(parsePendingForYouState(JSON.stringify(state))).toEqual(state);
    expect(parsePendingForYouState("{")).toBeNull();
    expect(parsePendingForYouState({ version: 2 })).toBeNull();
  });

  it("helpers", () => {
    expect(isOwnSiteLink("https://x.uno4.me/a")).toBe(true);
    expect(isOwnSiteLink("http://localhost:3000")).toBe(false);
    expect(ownLinksOf("[A](https://a.uno4.me) and https://google.com")).toEqual([
      { href: "https://a.uno4.me", label: "A" },
    ]);
    expect(pendingForYouSummary([{ title: "A" }, { title: "B" }, { title: "C" }])).toBe(
      "A · B · +1",
    );
    const feed = pendingFeedOf({
      messages: [
        { id: "m2", role: "assistant", text: "b", createdAt: "2026-11-23T10:02:00.000Z" },
        {
          id: "m3",
          role: "assistant",
          text: "c",
          createdAt: "2026-11-23T10:03:00.000Z",
          streaming: true,
        },
      ],
      pages: [
        {
          activityId: "p1",
          createdAt: "2026-11-23T10:01:00.000Z",
          page: { attachmentId: "p1", path: "/p1.html", title: "P", height: 1 },
        },
      ],
    });
    expect(feed.map((entry) => (entry.type === "page" ? entry.activityId : entry.id))).toEqual([
      "p1",
      "m2",
    ]);
  });
});
