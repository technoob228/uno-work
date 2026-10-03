import { describe, expect, it } from "vitest";

import {
  assignSlackChannels,
  assistantForSlackChannel,
  defaultSlackAssistant,
  isCustomizeRefused,
  matchAssistantName,
  slackIconEmoji,
  slackWhoIsThisFor,
} from "./slackAssistants.ts";

const choices = [
  { projectId: "assistant-home", title: "Uno" },
  { projectId: "assistant-ana", title: "Ana" },
];

describe("several assistants through one Uno Slack app", () => {
  it("each channel answers with its assistant, the rest with the holder", () => {
    const routed = [{ projectId: "assistant-ana", allowedChannelIds: ["CSALES"] }];
    expect(assistantForSlackChannel({ channel: "CSALES", holder: "assistant-home", routed })).toBe(
      "assistant-ana",
    );
    expect(
      assistantForSlackChannel({ channel: "CGENERAL", holder: "assistant-home", routed }),
    ).toBe("assistant-home");
  });

  it("a DM names its assistant by the whole message, else the default", () => {
    expect(matchAssistantName("ana", choices)?.projectId).toBe("assistant-ana");
    expect(matchAssistantName(" @Ana! ", choices)?.projectId).toBe("assistant-ana");
    expect(matchAssistantName("ana, what's new?", choices)).toBeNull();
    expect(defaultSlackAssistant(choices, "assistant-ana")).toBe("assistant-home");
    expect(defaultSlackAssistant([choices[1]!], "assistant-ana")).toBe("assistant-ana");
    expect(slackWhoIsThisFor(choices, "Uno")).toBe(
      "Who is this for? Reply with a name: Uno, Ana. Anything else goes to Uno. To switch later, send just a name.",
    );
  });

  it("writes with a Slack emoji shortcode", () => {
    expect(slackIconEmoji("🦊")).toBe(":fox_face:");
    expect(slackIconEmoji(":tada:")).toBe(":tada:");
    expect(slackIconEmoji("🫠")).toBe(":robot_face:");
    expect(slackIconEmoji(null)).toBe(":robot_face:");
  });

  it("a channel belongs to one assistant; DMs stay where they are", () => {
    const next = assignSlackChannels(
      [
        { projectId: "assistant-home", allowedChannelIds: ["D1", "CGENERAL", "CSALES"] },
        { projectId: "assistant-ana", allowedChannelIds: ["CDEV"] },
      ],
      "assistant-ana",
      ["CSALES", "D9"],
    );
    expect(next.get("assistant-ana")).toEqual(["CSALES"]);
    expect(next.get("assistant-home")).toEqual(["D1", "CGENERAL"]);
  });

  it("recognises a workspace without chat:write.customize", () => {
    expect(isCustomizeRefused({ data: { error: "missing_scope" } })).toBe(true);
    expect(isCustomizeRefused(new Error("channel_not_found"))).toBe(false);
  });
});
