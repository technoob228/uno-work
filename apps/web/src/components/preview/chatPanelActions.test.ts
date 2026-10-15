import { beforeEach, describe, expect, it } from "vitest";

import { useChatPanelActionsStore } from "./chatPanelActions";

describe("chat panel actions", () => {
  beforeEach(() => {
    useChatPanelActionsStore.setState({ actions: null });
  });

  it("a chat leaving takes back only its own actions", () => {
    const { publish, withdraw } = useChatPanelActionsStore.getState();
    publish({ threadId: "b", openTerminal: () => {}, openChanges: null });
    // Chat A unmounts after chat B already published (chat → chat).
    withdraw("a");
    expect(useChatPanelActionsStore.getState().actions?.threadId).toBe("b");
    withdraw("b");
    expect(useChatPanelActionsStore.getState().actions).toBeNull();
  });
});
