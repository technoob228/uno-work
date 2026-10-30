import { describe, expect, it } from "vitest";

import {
  acceptsChatDrop,
  carriesChats,
  chatTranscriptFileName,
  readChatDrag,
  useComposerDropStore,
  writeChatDrag,
} from "./chatDrop";

function transfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    effectAllowed: "none",
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  } as unknown as DataTransfer;
}

const chat = { environmentId: "env-1", threadId: "thread-1" } as never;

describe("chat drag data", () => {
  it("round-trips chats and is seen by its type", () => {
    const dataTransfer = transfer();
    expect(acceptsChatDrop(dataTransfer)).toBe(false);
    writeChatDrag(dataTransfer, [chat]);
    expect(carriesChats(dataTransfer)).toBe(true);
    expect(readChatDrag(dataTransfer)).toEqual([chat]);
  });

  it("ignores data that isn't chats", () => {
    const dataTransfer = transfer();
    dataTransfer.setData("application/x-uno-chats", "{nope");
    expect(readChatDrag(dataTransfer)).toEqual([]);
    dataTransfer.setData("application/x-uno-chats", '[{"threadId":"x"},1]');
    expect(readChatDrag(dataTransfer)).toEqual([]);
  });
});

describe("chatTranscriptFileName", () => {
  it("makes a title safe for a file name", () => {
    expect(chatTranscriptFileName('Fix: "a/b" <now>?')).toBe("Chat - Fix a b now.md");
    expect(chatTranscriptFileName("  ")).toBe("Chat - untitled.md");
    expect(chatTranscriptFileName("x".repeat(100))).toBe(`Chat - ${"x".repeat(60)}.md`);
  });
});

describe("useComposerDropStore", () => {
  it("adds up what waits for a chat and hands it over once", () => {
    const { offer, take } = useComposerDropStore.getState();
    offer("key", { files: [], chats: [chat] });
    offer("key", { files: [], chats: [chat] });
    expect(take("key")?.chats).toHaveLength(2);
    expect(take("key")).toBeNull();
  });
});
