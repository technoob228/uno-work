import { beforeEach, describe, expect, it } from "vitest";

import {
  registerStashTarget,
  restoreStashedMessage,
  stashedMessagePreview,
  useComposerStashStore,
} from "./composerStashStore";

const message = (text: string) => ({ text, files: [], quotes: [] });

describe("useComposerStashStore", () => {
  beforeEach(() => useComposerStashStore.setState({ entries: [], loaded: false }));

  it("keeps nothing for an empty message", () => {
    expect(useComposerStashStore.getState().stash(message("  "))).toBeNull();
    expect(useComposerStashStore.getState().entries).toEqual([]);
  });

  it("keeps a message with only a file", () => {
    const file = new File(["x"], "a.txt");
    const entry = useComposerStashStore.getState().stash({ text: "", files: [file], quotes: [] });
    expect(entry?.files).toEqual([file]);
  });

  it("takes a message once", () => {
    const entry = useComposerStashStore.getState().stash(message("hello"))!;
    expect(useComposerStashStore.getState().take(entry.id)?.text).toBe("hello");
    expect(useComposerStashStore.getState().take(entry.id)).toBeNull();
  });
});

describe("restoreStashedMessage", () => {
  beforeEach(() => useComposerStashStore.setState({ entries: [], loaded: false }));

  it("leaves it set aside when no chat is open", () => {
    const entry = useComposerStashStore.getState().stash(message("hello"))!;
    expect(restoreStashedMessage(entry.id)).toBe(false);
    expect(useComposerStashStore.getState().entries).toHaveLength(1);
  });

  it("hands it to the composer on screen", () => {
    const received: string[] = [];
    const unregister = registerStashTarget((entry) => received.push(entry.text));
    const entry = useComposerStashStore.getState().stash(message("hello"))!;
    expect(restoreStashedMessage(entry.id)).toBe(true);
    expect(received).toEqual(["hello"]);
    expect(useComposerStashStore.getState().entries).toEqual([]);
    unregister();
  });
});

describe("stashedMessagePreview", () => {
  it("is the first line and what else is there", () => {
    expect(stashedMessagePreview({ text: "one\ntwo", files: [1, 2], quotes: [] })).toBe(
      "one · 2 attachments",
    );
    expect(stashedMessagePreview({ text: "", files: [], quotes: [1] })).toBe("1 attachment");
  });
});
