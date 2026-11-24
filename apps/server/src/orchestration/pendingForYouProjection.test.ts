import { parsePendingForYouState, pendingForYouView } from "@t3tools/shared/pendingForYou";
import { describe, expect, it } from "vitest";

import {
  applyPendingActionJson,
  initialPendingForYouJson,
  pendingMessageEntry,
  pendingPageEntry,
  rebuildPendingForYouJson,
  stepPendingForYouJson,
} from "./pendingForYouProjection.ts";

const view = (json: string | null) => {
  const state = parsePendingForYouState(json);
  return state === null ? null : pendingForYouView(state);
};

const cardActivity = (id: string, title: string, createdAt: string) => ({
  id,
  kind: "html.render",
  createdAt,
  payload: {
    attachmentId: `page-${id}`,
    path: `/a/page-${id}.html`,
    title,
    height: 200,
    source: "card",
    waitsForAnswer: true,
  },
});

describe("pendingForYouProjection", () => {
  it("steps a card in, the person's answer out", () => {
    let json = initialPendingForYouJson("2026-11-23T10:00:00.000Z");
    const page = pendingPageEntry(cardActivity("c1", "Ship?", "2026-11-23T10:01:00.000Z"));
    expect(page).not.toBeNull();
    json = stepPendingForYouJson(json, page!);
    expect(view(json)?.items.map((item) => [item.id, item.activityId])).toEqual([
      ["card:page-c1", "c1"],
    ]);
    json = stepPendingForYouJson(
      json,
      pendingMessageEntry({
        messageId: "m1",
        role: "user",
        text: "[from the card «Ship?»]\nThursday",
        createdAt: "2026-11-23T10:02:00.000Z",
      }),
    );
    expect(view(json)?.items).toEqual([]);
  });

  it("an untracked chat starts at its first entry; other activities are skipped", () => {
    expect(
      pendingPageEntry({ id: "x", kind: "tool.started", payload: {}, createdAt: "z" }),
    ).toBeNull();
    const json = stepPendingForYouJson(
      null,
      pendingPageEntry(cardActivity("c1", "Ship?", "2026-11-23T10:01:00.000Z"))!,
    );
    expect(view(json)?.items).toHaveLength(1);
  });

  it("the person's actions stick; a revert rebuilds from the feed and keeps them", () => {
    let json = initialPendingForYouJson("2026-11-23T10:00:00.000Z");
    json = stepPendingForYouJson(
      json,
      pendingPageEntry(cardActivity("c1", "Ship?", "2026-11-23T10:01:00.000Z"))!,
    );
    json = stepPendingForYouJson(
      json,
      pendingPageEntry(cardActivity("c2", "Pricing", "2026-11-23T10:02:00.000Z"))!,
    );
    json = applyPendingActionJson(json, { dismiss: ["card:page-c1"] }, "2026-11-23T10:03:00.000Z");
    expect(view(json)?.hidden.map((item) => item.id)).toEqual(["card:page-c1"]);
    const rebuilt = rebuildPendingForYouJson(json, {
      messages: [],
      activities: [
        { ...cardActivity("c1", "Ship?", "2026-11-23T10:01:00.000Z"), activityId: "c1" },
      ],
    });
    expect(view(rebuilt)).toMatchObject({ items: [], hidden: [{ id: "card:page-c1" }] });
  });
});
