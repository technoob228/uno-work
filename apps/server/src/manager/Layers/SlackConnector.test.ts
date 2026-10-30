import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { fetchThreadBacklog } from "./SlackConnector.ts";

const backlog = (messages: ReadonlyArray<unknown>, excludeTs: string) =>
  Effect.runPromise(
    fetchThreadBacklog({
      web: { conversations: { replies: async () => ({ messages }) } } as never,
      channel: "C1",
      threadTs: "1.0",
      excludeTs,
      botUserId: "BOT",
    }),
  );

describe("fetchThreadBacklog", () => {
  const file = { id: "F1", name: "договор.pdf" };

  it("gives the file of the message the thread hangs under", async () => {
    const result = await backlog(
      [
        { ts: "1.0", user: "U1", text: "вот договор", files: [file] },
        { ts: "2.0", user: "U2", text: "<@BOT> разбери" },
      ],
      "2.0",
    );
    expect(result.rootFiles).toEqual([file]);
    expect(result.lines).toEqual(["<@U1>: вот договор"]);
  });

  it("doesn't take a file twice when the bot is called on that very message", async () => {
    const result = await backlog([{ ts: "1.0", user: "U1", files: [file] }], "1.0");
    expect(result.rootFiles).toEqual([]);
  });

  it("stays quiet when Slack fails", async () => {
    const result = await Effect.runPromise(
      fetchThreadBacklog({
        web: { conversations: { replies: () => Promise.reject(new Error("no")) } } as never,
        channel: "C1",
        threadTs: "1.0",
        excludeTs: "2.0",
        botUserId: "BOT",
      }),
    );
    expect(result).toEqual({ lines: [], rootFiles: [] });
  });
});
