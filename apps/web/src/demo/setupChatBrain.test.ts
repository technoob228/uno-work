import { describe, expect, it } from "vitest";

import { NEW_TEAMMATE_ACCESS } from "../components/assistants/assistantTeam.logic";
import { useAssistantTeamStore } from "../components/assistants/assistantTeamStore";
import { answerSetupChatTurn, isSetupChatThread, startSetupChat } from "./setupChatBrain";

const world = {
  projects: ["landing", "fishcode"],
  connected: (provider: string) => provider === "github",
  keys: [{ id: "cred-x", label: "X token" }],
};

describe("an assistant sets itself up in a chat", () => {
  it("asks one question at a time, saves each answer, skips, and wraps up", () => {
    useAssistantTeamStore.getState().upsert({
      environmentId: "env",
      projectId: "assistant-ada",
      name: "Ada",
      emoji: "🚀",
      tone: "violet",
      roles: [],
      character: "",
      skills: [],
      preset: "full",
      brain: "uno",
      channel: "uno-bot",
      channelHandle: null,
      projects: "all",
      computers: ["env"],
      createdBy: null,
      createdAt: "2026-10-16T00:00:00Z",
      setUpAt: null,
      revokedAt: null,
      access: NEW_TEAMMATE_ACCESS,
    });
    const first = startSetupChat("t1", { environmentId: "env", key: "env:assistant-ada" }, world);
    expect(first.text).toContain("Hi, I'm Ada");
    expect(first.question?.id).toBe("role");

    const role = answerSetupChatTurn("t1", "Sales", world);
    expect(role?.text).toContain("✓ **Saved:** role — Sales");
    expect(role?.question?.id).toBe("tone");
    expect(useAssistantTeamStore.getState().profiles["env:assistant-ada"]?.roles).toEqual([
      "Sales",
    ]);

    const skipped = answerSetupChatTurn("t1", "Skip", world);
    expect(skipped?.text).toContain("Skipped");

    answerSetupChatTurn("t1", "Only here", world);
    const rights = answerSetupChatTurn("t1", "Observer", world);
    // Limited rights: it offers a computer of its own, with the price.
    expect(rights?.question?.id).toBe("own-computer");
    expect(rights?.question?.detail).toContain("$5/mo");
    const profile = useAssistantTeamStore.getState().profiles["env:assistant-ada"]!;
    expect(profile.access?.connectors).toBe("read");

    let next = answerSetupChatTurn("t1", "Make ada-box", world);
    while (next?.question) next = answerSetupChatTurn("t1", "Skip", world);
    expect(next?.text).toContain("All set");
    expect(isSetupChatThread("t1")).toBe(false);
    expect(useAssistantTeamStore.getState().profiles["env:assistant-ada"]?.ownComputer).toBe(
      "ada-box",
    );
  });
});
