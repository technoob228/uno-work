import { describe, expect, it } from "vitest";

import { chatProjectOffer } from "./turnChatIntoProject";

const chat = {
  worktreePath: null,
  branch: null,
  projectRoot: "/home/u",
  homeFolder: "/home/u",
  isAssistantChat: false,
};

describe("chatProjectOffer", () => {
  it("asks for a folder for a chat in the home folder", () => {
    expect(chatProjectOffer(chat)).toEqual({ kind: "pick-folder" });
  });

  it("reads the home folder with a trailing slash as the same folder", () => {
    expect(chatProjectOffer({ ...chat, homeFolder: "/home/u/" })).toEqual({ kind: "pick-folder" });
  });

  it("uses a chat's own folder", () => {
    expect(chatProjectOffer({ ...chat, worktreePath: "/home/u/site" })).toEqual({
      kind: "own-folder",
      folder: "/home/u/site",
    });
  });

  it("offers nothing to a chat already in a project", () => {
    expect(chatProjectOffer({ ...chat, projectRoot: "/home/u/app" })).toBeNull();
  });

  it("leaves a separate copy of a project alone", () => {
    expect(
      chatProjectOffer({
        ...chat,
        projectRoot: "/home/u/app",
        worktreePath: "/home/u/.t3/worktrees/app/x",
        branch: "t3code/x",
      }),
    ).toBeNull();
  });

  it("leaves the assistant's chat alone", () => {
    expect(chatProjectOffer({ ...chat, isAssistantChat: true })).toBeNull();
  });
});
