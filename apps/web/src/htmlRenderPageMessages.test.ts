import { HTML_RENDER_MESSAGE_LIMITS } from "@t3tools/shared/htmlRender";
import { beforeEach, describe, expect, it } from "vitest";

import { pageMessagesSent, sendPageMessage, usePageMessagesStore } from "./htmlRenderPageMessages";
import { useQueuedMessageStore } from "./queuedMessageStore";

const THREAD = "env:thread-1";
const queued = () =>
  (useQueuedMessageStore.getState().queuesByThreadKey[THREAD] ?? []).map((m) => m.text);
const send = (
  text: string,
  now: number,
  extra: { gesture?: boolean; attachmentId?: string } = {},
) =>
  sendPageMessage({
    threadKey: THREAD,
    attachmentId: extra.attachmentId ?? "page-1",
    text,
    gesture: extra.gesture ?? true,
    now,
  });

beforeEach(() => {
  useQueuedMessageStore.setState({ queuesByThreadKey: {} });
  usePageMessagesStore.setState({ sentByPage: {} });
});

describe("a page's message", () => {
  it("goes the way the person's Enter goes: into Up next, visible", () => {
    expect(send("  Option A  ", 1_000)).toEqual({ ok: true, text: "Option A" });
    expect(queued()).toEqual(["Option A"]);
    expect(pageMessagesSent("page-1")).toEqual(["Option A"]);
  });

  it("goes nowhere without the person's press", () => {
    expect(send("Option A", 1_000, { gesture: false }).ok).toBe(false);
    expect(queued()).toEqual([]);
    expect(pageMessagesSent("page-1")).toEqual([]);
  });

  it("keeps a pace and a cap per page, not per chat", () => {
    expect(send("one", 1_000).ok).toBe(true);
    expect(send("two", 1_500).ok).toBe(false);
    expect(send("other page", 1_500, { attachmentId: "page-2" }).ok).toBe(true);
    let now = 1_000;
    for (let index = 1; index < HTML_RENDER_MESSAGE_LIMITS.perPage; index += 1) {
      now += HTML_RENDER_MESSAGE_LIMITS.minIntervalMs;
      expect(send(`move ${index}`, now).ok).toBe(true);
    }
    expect(send("one too many", now + 60_000).ok).toBe(false);
    expect(pageMessagesSent("page-1")).toHaveLength(HTML_RENDER_MESSAGE_LIMITS.perPage);
  });
});
