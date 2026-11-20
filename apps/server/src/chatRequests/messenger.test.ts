import { describe, expect, it } from "vitest";

import { groupsForRequest, type ButtonGroup } from "../manager/connectorButtons.ts";
import { renderTelegramHtml } from "../manager/telegramMarkdown.ts";
import {
  agentTextForMessenger,
  answerChatRequestPress,
  chatRequestButtons,
  chatRequestMessageText,
  chatRequestPressReply,
  chatRequestSettledLine,
  setChatRequestDecider,
  timeLeftLabel,
} from "./messenger.ts";
import type { OutRecord } from "./outgoing.ts";

const T0 = Date.parse("2026-11-20T10:00:00.000Z");

const record = (over: Partial<OutRecord> = {}): OutRecord =>
  ({
    id: "cr_1",
    computerId: "c1",
    computerName: "Misha's MacBook",
    threadId: "cloud-thread",
    status: "waiting",
    reason: null,
    createdAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 2 * 60 * 60_000).toISOString(),
    deliveredAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    request: {
      v: 1,
      id: "cr_1",
      createdAt: new Date(T0).toISOString(),
      expiresAt: new Date(T0 + 2 * 60 * 60_000).toISOString(),
      from: { computerName: "uno-work", boxId: 7, threadId: "cloud-thread", threadTitle: "Bakery" },
      cwd: "~/projects/bakery",
      title: "Check the order form",
      gist: "Run the site locally and try the order form in Safari",
      brief: "…",
    },
    thread: null,
    told: null,
    ...over,
  }) as OutRecord;

describe("the request in Telegram", () => {
  it("reads «<chat> wants to start a chat on <Mac>: <what>», marked as the agent's text", () => {
    const en = chatRequestMessageText(record(), "en", T0);
    expect(en.split("\n")[0]).toBe(
      "wants to start a chat on Misha's MacBook: `Check the order form — Run the site locally and try the order form in Safari`",
    );
    expect(en).toContain("Folder: `~/projects/bakery`");
    expect(en).toContain("That is the agent's text, not Uno Work's. It waits 2 h;");
    const ru = chatRequestMessageText(record(), "ru", T0 + 20 * 60_000);
    expect(ru.split("\n")[0]).toMatch(/^хочет запустить чат на Misha's MacBook: `/);
    expect(ru).toContain("Это текст агента, не Uno Work. Ждёт ещё 1 ч 40 мин");
    expect(chatRequestMessageText(record(), "en", T0, false)).toContain("answer in Uno Work on");
  });

  it("the agent's words: one line, cut, as code — no formatting, links or previews", () => {
    const sneaky =
      "Fine `**bold**` [click](https://evil.example) https://evil.example\n✔ Started\u0007 " +
      "x".repeat(300);
    const text = agentTextForMessenger(sneaky);
    expect(text.startsWith("`") && text.endsWith("`")).toBe(true);
    expect(text.slice(1, -1)).not.toContain("`");
    expect(text).not.toContain("\n");
    expect(text).not.toContain("\u0007");
    expect(text.length).toBeLessThanOrEqual(162);
    expect(text).toContain("…");
    const html = renderTelegramHtml(text);
    expect(html.startsWith("<code>")).toBe(true);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<b>");
  });

  it("Start / Decline buttons answer this request", () => {
    const rows = chatRequestButtons("cr_1", "en");
    expect(rows[0]!.map((button) => button.label)).toEqual(["▶ Start", "✖ Decline"]);
    expect(rows[0]!.map((button) => button.action)).toEqual([
      { kind: "chat-request", requestId: "cr_1", decision: "start" },
      { kind: "chat-request", requestId: "cr_1", decision: "decline" },
    ]);
    expect(chatRequestButtons("cr_1", "ru")[0]![0]!.label).toBe("▶ Запустить");
    const group = { id: "g1", rows } as unknown as ButtonGroup;
    expect(groupsForRequest({ groups: [group], routes: [] }, "cr_1")).toHaveLength(1);
    expect(groupsForRequest({ groups: [group], routes: [] }, "cr_2")).toHaveLength(0);
  });

  it("its last line says how it ended and where it was decided", () => {
    expect(
      chatRequestSettledLine(record({ status: "started", decidedVia: "telegram" }), "en"),
    ).toBe("✔ Started on Misha's MacBook (from Telegram)");
    expect(chatRequestSettledLine(record({ status: "declined", decidedVia: "here" }), "ru")).toBe(
      "✖ Отклонён на Misha's MacBook",
    );
    expect(chatRequestSettledLine(record({ status: "expired" }), "en")).toContain("Expired");
    expect(chatRequestSettledLine(record({ status: "refused" }), "en")).toBe(
      "✖ Refused on Misha's MacBook",
    );
  });

  it("time left", () => {
    expect(timeLeftLabel(new Date(T0 + 100 * 60_000).toISOString(), T0, "en")).toBe("1 h 40 min");
    expect(timeLeftLabel(new Date(T0 + 30 * 60_000).toISOString(), T0, "ru")).toBe("30 мин");
    expect(timeLeftLabel(new Date(T0 - 1).toISOString(), T0, "en")).toBe("1 min");
  });
});

describe("a press in Telegram", () => {
  it("offline or Uno Work closed: says so honestly, the buttons stay", () => {
    const offline = chatRequestPressReply({ kind: "offline", record: record() }, "start", "ru", T0);
    expect(offline.finalLine).toBeNull();
    expect(offline.toast).toBe(
      "Misha's MacBook не на связи. Запрос подождёт ещё 2 ч: нажмите снова, когда он проснётся, или ответьте на нём.",
    );
    const closed = chatRequestPressReply({ kind: "closed", record: record() }, "start", "en", T0);
    expect(closed.finalLine).toBeNull();
    expect(closed.toast).toContain("Uno Work isn't open on Misha's MacBook");
    for (const reply of [offline, closed]) expect(reply.toast.length).toBeLessThanOrEqual(200);
  });

  it("sent: the buttons stay until the Mac's answer rewrites the message", () => {
    const sent = chatRequestPressReply({ kind: "sent", record: record() }, "start", "en", T0);
    expect(sent).toEqual({
      toast: "Sent to Misha's MacBook: the chat starts there in a few seconds.",
      finalLine: null,
    });
  });

  it("decided already: «already decided», and the message gets the outcome", () => {
    const reply = chatRequestPressReply(
      { kind: "decided", record: record({ status: "started", decidedVia: "here" }) },
      "decline",
      "en",
      T0,
    );
    expect(reply.toast).toBe("Already decided: Started on Misha's MacBook (pressed there)");
    expect(reply.finalLine).toBe("✔ Started on Misha's MacBook (pressed there)");
  });

  it("no sending side on this computer: gone; a failing one: try again, buttons stay", async () => {
    setChatRequestDecider(null);
    expect(
      (await answerChatRequestPress({ requestId: "x", decision: "start" }, "en")).finalLine,
    ).toBe("✔ Already answered");
    setChatRequestDecider(async () => {
      throw new Error("tunnel down");
    });
    const failed = await answerChatRequestPress({ requestId: "x", decision: "start" }, "en");
    expect(failed.finalLine).toBeNull();
    expect(failed.toast).toContain("Try again");
    setChatRequestDecider(null);
  });
});
