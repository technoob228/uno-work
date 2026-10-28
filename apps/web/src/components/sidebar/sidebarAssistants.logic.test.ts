import { describe, expect, it } from "vitest";

import {
  assistantChatsUnfolded,
  assistantRowNote,
  assistantRowTarget,
  assistantsHeaderState,
  toggledFoldChoice,
  unoSetupHref,
} from "./sidebarAssistants.logic";

describe("sidebar assistants header", () => {
  it('"+" and the gear are always there with the team, whatever the team size', () => {
    expect(assistantsHeaderState({ teamShown: true })).toEqual({
      showHeader: true,
      showCreate: true,
      showSettings: true,
      showList: true,
      showRestore: false,
    });
  });

  it("without the team on the account: Uno alone, no header, no '+'", () => {
    expect(assistantsHeaderState({ teamShown: false })).toEqual({
      showHeader: false,
      showCreate: false,
      showSettings: false,
      showList: true,
      showRestore: false,
    });
  });

  it("hidden by the person: only the small Show assistants line", () => {
    expect(assistantsHeaderState({ teamShown: true, hidden: true })).toEqual({
      showHeader: false,
      showCreate: false,
      showSettings: false,
      showList: false,
      showRestore: true,
    });
  });

  it("Uno alone (no header to hide it from) ignores a stale hidden choice", () => {
    expect(assistantsHeaderState({ teamShown: false, hidden: true }).showList).toBe(true);
  });
});

describe("an assistant's group of chats folds (28.10 bug)", () => {
  it("untouched: open while one of its chats is open, else folded", () => {
    expect(assistantChatsUnfolded({ choice: undefined, holdsOpenChat: true, chatCount: 3 })).toBe(
      true,
    );
    expect(assistantChatsUnfolded({ choice: undefined, holdsOpenChat: false, chatCount: 3 })).toBe(
      false,
    );
  });

  it("folds even while it holds the open chat", () => {
    const unfoldedNow = assistantChatsUnfolded({
      choice: undefined,
      holdsOpenChat: true,
      chatCount: 3,
    });
    const choice = toggledFoldChoice(unfoldedNow);
    expect(choice).toBe("closed");
    expect(assistantChatsUnfolded({ choice, holdsOpenChat: true, chatCount: 3 })).toBe(false);
  });

  it("unfolds by hand and stays so", () => {
    expect(toggledFoldChoice(false)).toBe("open");
    expect(assistantChatsUnfolded({ choice: "open", holdsOpenChat: false, chatCount: 2 })).toBe(
      true,
    );
  });

  it("nothing to unfold without chats", () => {
    expect(assistantChatsUnfolded({ choice: "open", holdsOpenChat: false, chatCount: 0 })).toBe(
      false,
    );
  });
});

describe("a click on an assistant's row", () => {
  it("Uno not set up: its first-run screen, not the dialog", () => {
    expect(
      assistantRowTarget({ configured: false, isUno: true, teamShown: true, environmentId: "e1" }),
    ).toEqual({ kind: "uno-setup", environmentId: "e1" });
    expect(unoSetupHref("e1")).toBe("/assistants?view=uno-setup&env=e1");
  });

  it("set up: its chat; another assistant not set up: its setup", () => {
    expect(
      assistantRowTarget({ configured: true, isUno: true, teamShown: true, environmentId: "e1" }),
    ).toEqual({ kind: "chat" });
    expect(
      assistantRowTarget({ configured: false, isUno: false, teamShown: true, environmentId: "e1" }),
    ).toEqual({ kind: "setup" });
  });

  it("without the team: the old introduction", () => {
    expect(
      assistantRowTarget({ configured: false, isUno: true, teamShown: false, environmentId: "e1" }),
    ).toEqual({ kind: "setup" });
  });
});

describe("the line after an assistant's name", () => {
  const base = {
    isUno: false,
    role: "Developer",
    environmentId: "mac",
    homeEnvironmentId: "work",
    computerLabel: "MacBook",
    multiComputer: true,
  };
  it("a persona on another computer says which", () => {
    expect(assistantRowNote(base)).toEqual({ text: "Developer · MacBook", computer: "MacBook" });
  });
  it("at home, or with one computer: the role alone", () => {
    expect(assistantRowNote({ ...base, environmentId: "work" })).toEqual({
      text: "Developer",
      computer: null,
    });
    expect(assistantRowNote({ ...base, multiComputer: false }).computer).toBeNull();
  });
  it("Uno is everything, wherever it is", () => {
    expect(assistantRowNote({ ...base, isUno: true })).toEqual({
      text: "Everything",
      computer: null,
    });
  });
});
