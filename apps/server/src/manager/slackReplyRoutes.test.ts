import { describe, expect, it } from "vitest";

import { REPLY_ROUTE_TTL_MS } from "./connectorButtons.ts";
import {
  addSlackReplyRoute,
  decodeSlackReplyRoutes,
  EMPTY_SLACK_REPLY_ROUTES,
  findSlackReplyRoute,
  resolveSlackOptionReply,
  slackOptionsText,
  slackReplyOptions,
  type SlackReplyRoute,
} from "./slackReplyRoutes.ts";

const route = (over: Partial<SlackReplyRoute> = {}): SlackReplyRoute => ({
  connectorProjectId: "assistant-home",
  channel: "D0OWNER",
  ts: "1700000000.000100",
  threadId: "thread-site",
  options: [],
  atMs: 1_000,
  ...over,
});

describe("slack reply routes", () => {
  it("finds the chat of a reply in the message's thread, on the same app and DM only", () => {
    const state = addSlackReplyRoute(EMPTY_SLACK_REPLY_ROUTES, route(), 1_000);
    const find = (over: Partial<Parameters<typeof findSlackReplyRoute>[1]> = {}) =>
      findSlackReplyRoute(state, {
        connectorProjectId: "assistant-home",
        channel: "D0OWNER",
        threadTs: "1700000000.000100",
        nowMs: 2_000,
        ...over,
      })?.threadId ?? null;
    expect(find()).toBe("thread-site");
    expect(find({ channel: "D0OTHER" })).toBeNull();
    expect(find({ connectorProjectId: "proj-2" })).toBeNull();
    expect(find({ threadTs: "1700000000.000200" })).toBeNull();
    expect(find({ nowMs: 1_000 + REPLY_ROUTE_TTL_MS })).toBeNull();
  });

  it("a second message in the same thread replaces the route, not duplicates it", () => {
    let state = addSlackReplyRoute(EMPTY_SLACK_REPLY_ROUTES, route(), 1_000);
    state = addSlackReplyRoute(state, route({ threadId: "thread-other" }), 1_500);
    expect(state.routes).toHaveLength(1);
    expect(state.routes[0]!.threadId).toBe("thread-other");
  });

  it("a number, '#2', '2.' or the label picks the option; anything else is the text", () => {
    const options = [
      { label: "Deploy", value: "Deploy it" },
      { label: "Wait a day", value: "Wait" },
    ];
    expect(resolveSlackOptionReply("2", options)).toEqual({ text: "Wait", picked: options[1] });
    expect(resolveSlackOptionReply(" #1 ", options).text).toBe("Deploy it");
    expect(resolveSlackOptionReply("2.", options).text).toBe("Wait");
    expect(resolveSlackOptionReply("wait  a day!", options).text).toBe("Wait");
    expect(resolveSlackOptionReply("3", options)).toEqual({ text: "3", picked: null });
    expect(resolveSlackOptionReply("deploy tomorrow", options).picked).toBeNull();
    expect(resolveSlackOptionReply("1", [])).toEqual({ text: "1", picked: null });
  });

  it("only buttons that send a value become options", () => {
    expect(
      slackReplyOptions([
        [
          { label: "Yes", action: { kind: "reply", value: "yes" } },
          { label: "Allow", action: { kind: "tool-approval", requestId: "r", approved: true } },
        ],
        [
          { label: "Red", action: { kind: "toggle", value: "red" } },
          { label: "Done", action: { kind: "submit" } },
        ],
      ]),
    ).toEqual([
      { label: "Yes", value: "yes" },
      { label: "Red", value: "red" },
    ]);
  });

  it("numbered options in English and Russian", () => {
    const options = [{ label: "A", value: "a" }];
    expect(slackOptionsText(options, "en")).toBe("1. A\n_Reply in the thread with a number._");
    expect(slackOptionsText(options, "ru")).toBe("1. A\n_Ответьте в ветке номером варианта._");
  });

  it("drops malformed entries read from disk", () => {
    expect(
      decodeSlackReplyRoutes({
        routes: [route(), { channel: "x" }, route({ options: [{}] as never })],
      }).routes,
    ).toEqual([route()]);
    expect(decodeSlackReplyRoutes("nope")).toEqual(EMPTY_SLACK_REPLY_ROUTES);
  });
});
