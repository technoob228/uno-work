import { describe, expect, it } from "vitest";

import {
  buildSuggestionMessages,
  parseSuggestions,
  requestSuggestions,
  type SuggestionChat,
} from "./homeSuggestions.ts";

const chats: SuggestionChat[] = [
  {
    threadId: "t1",
    title: "Fix login",
    messages: [
      { role: "user", text: "login fails on Safari" },
      { role: "assistant", text: "Fixed the cookie. The Safari test still fails." },
    ],
  },
  { threadId: "t2", title: "Report", messages: [{ role: "user", text: "make a report" }] },
];

describe("parseSuggestions", () => {
  it("reads JSON inside a code fence and maps chat numbers to thread ids", () => {
    const raw =
      '```json\n[{"chat":1,"label":"Fix the Safari test","task":"The Safari login test still fails; fix it."}]\n```';
    expect(parseSuggestions(raw, chats)).toEqual([
      {
        threadId: "t1",
        label: "Fix the Safari test",
        prompt: "The Safari login test still fails; fix it.",
      },
    ]);
  });

  it("drops junk: unknown chat, short fields, a second hint for one chat", () => {
    const raw = JSON.stringify([
      { chat: 9, label: "Do something", task: "Do something useful please" },
      { chat: 1, label: "x", task: "short" },
      { chat: 2, label: "Send the report", task: "Send the report to the team by mail." },
      { chat: 2, label: "Another one", task: "Another thing for the same chat." },
    ]);
    const result = parseSuggestions(raw, chats);
    expect(result.map((s) => s.threadId)).toEqual(["t2"]);
  });

  it("returns nothing for prose or an empty list", () => {
    expect(parseSuggestions("Nothing to suggest.", chats)).toEqual([]);
    expect(parseSuggestions("[]", chats)).toEqual([]);
  });

  it("cuts long labels", () => {
    const raw = JSON.stringify([{ chat: 1, label: "A".repeat(90), task: "Do the thing now ok" }]);
    expect(parseSuggestions(raw, chats)[0]?.label.length).toBeLessThanOrEqual(44);
  });
});

describe("buildSuggestionMessages", () => {
  it("numbers the chats and keeps only the last messages", () => {
    const long: SuggestionChat = {
      threadId: "t3",
      title: "Long",
      messages: Array.from({ length: 20 }, (_, i) => ({ role: "user", text: `m${i}` })),
    };
    const user = buildSuggestionMessages([chats[0]!, long])[1]!.content;
    expect(user).toContain("Chat 1: Fix login");
    expect(user).toContain("Chat 2: Long");
    expect(user).toContain("m19");
    expect(user).not.toContain("m13\n");
  });
});

describe("requestSuggestions", () => {
  it("has no key: no call", async () => {
    const result = await requestSuggestions({ apiKey: " ", chats });
    expect(result).toEqual({ ok: false, reason: "no-key" });
  });

  it("answers from the gateway and survives a refusal", async () => {
    const good = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '[{"chat":1,"label":"Fix the Safari test","task":"Fix the Safari test."}]',
              },
            },
          ],
        }),
      )) as unknown as typeof fetch;
    const ok = await requestSuggestions({ apiKey: "k", chats, fetchImpl: good });
    expect(ok.ok && ok.suggestions).toHaveLength(1);
    const refused = (async () => new Response("no", { status: 402 })) as unknown as typeof fetch;
    expect(await requestSuggestions({ apiKey: "k", chats, fetchImpl: refused })).toEqual({
      ok: false,
      reason: "gateway",
    });
  });
});
