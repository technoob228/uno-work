/**
 * A tool call waiting for the person's Allow while no Uno Work window is
 * open: the person gets Allow / Deny buttons in their messenger (bound to the
 * request), the buttons go once it is answered, and with a window open
 * nothing is sent.
 */
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { BrowserBridge, type BrowserBridgeShape } from "./browserBridge.ts";
import type {
  ConnectorNotifyServiceShape,
  PersonMessageInput,
} from "./manager/Services/ConnectorNotify.ts";
import { askPersonApproval } from "./personApproval.ts";

const harness = (windowOpen: boolean) => {
  const sent: Array<PersonMessageInput> = [];
  const retired: Array<string> = [];
  const notify = {
    sendToPerson: (input: PersonMessageInput) =>
      Effect.sync(() => {
        sent.push(input);
        return { delivered: 1, via: "telegram" as const, note: null };
      }),
    retireButtons: (requestId: string) => Effect.sync(() => void retired.push(requestId)),
  } as unknown as ConnectorNotifyServiceShape;
  const bridge = Layer.succeed(BrowserBridge, {
    hasSubscribers: Effect.succeed(windowOpen),
    requestToolApproval: (input: Parameters<BrowserBridgeShape["requestToolApproval"]>[0]) =>
      Effect.gen(function* () {
        input.onRequestId?.("req-42");
        yield* Effect.sleep("20 millis");
        return "approved" as const;
      }),
  } as unknown as BrowserBridgeShape);
  return { sent, retired, notify, bridge };
};

const ask = (notify: ConnectorNotifyServiceShape) =>
  askPersonApproval(
    {
      tool: "site_publish",
      title: "Publish the site",
      detail: "shop.uno4.me",
      sensitive: false,
      threadId: "thread-1",
      askerName: "Shop",
      inboxSource: { kind: "agent", id: "thread-1" },
    },
    { inbox: null, notify },
  );

it.live("nobody looking: Allow / Deny buttons for this request, gone once answered", () => {
  const { sent, retired, notify, bridge } = harness(false);
  return Effect.gen(function* () {
    expect(yield* ask(notify)).toBe("approved");
    expect(sent).toHaveLength(1);
    const message = sent[0]!;
    expect(message.text).toBe("🔐 Publish the site\nshop.uno4.me");
    expect(message.textWithoutButtons).toContain("open Uno Work");
    expect(message.approval).toBe(true);
    expect(message.buttons?.flat().map((button) => button.action)).toEqual([
      { kind: "tool-approval", requestId: "req-42", approved: true },
      { kind: "tool-approval", requestId: "req-42", approved: false },
    ]);
    expect(retired).toEqual(["req-42"]);
  }).pipe(Effect.provide(bridge));
});

it.live("a window is open: the messenger stays quiet", () => {
  const { sent, retired, notify, bridge } = harness(true);
  return Effect.gen(function* () {
    expect(yield* ask(notify)).toBe("approved");
    expect(sent).toEqual([]);
    expect(retired).toEqual([]);
  }).pipe(Effect.provide(bridge));
});
