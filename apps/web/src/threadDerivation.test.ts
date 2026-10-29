import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { selectEnvironmentState, useStore } from "./store";
import { selectThreadDetailLoaded } from "./threadDerivation";

describe("selectThreadDetailLoaded", () => {
  const threadId = ThreadId.make("thread-1");
  const empty = selectEnvironmentState(useStore.getState(), null);

  it("is false until the chat's messages arrive, true after - even with none", () => {
    expect(selectThreadDetailLoaded(empty, threadId)).toBe(false);
    expect(
      selectThreadDetailLoaded({ ...empty, messageIdsByThreadId: { [threadId]: [] } }, threadId),
    ).toBe(true);
  });
});
