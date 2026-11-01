import type { MyComputerImportStatus, MyComputerImportTool } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  alsoFoundLine,
  hasOffer,
  historyNotice,
  importedLine,
  importResultLine,
  offeredTools,
  selectedChats,
  selectedTools,
  skippedLine,
} from "./chatImport.logic";

const tool = (overrides: Partial<MyComputerImportTool>): MyComputerImportTool => ({
  id: "claude",
  name: "Claude Code",
  chats: 10,
  newChats: 10,
  projects: 2,
  available: true,
  unavailableReason: null,
  ...overrides,
});

const status = (overrides: Partial<MyComputerImportStatus>): MyComputerImportStatus => ({
  computerId: "c1",
  state: "ready",
  declined: false,
  tools: [],
  alsoFound: [],
  skipped: { unreadable: 0, unknownFormat: 0 },
  scanned: { done: 0, total: 0 },
  progress: { done: 0, total: 0 },
  result: null,
  importedChats: 0,
  importedProjects: 0,
  message: null,
  ...overrides,
});

describe("the offer", () => {
  const tools = [
    tool({ id: "claude", newChats: 12 }),
    tool({ id: "codex", name: "Codex", newChats: 3 }),
    tool({ id: "opencode", name: "OpenCode", newChats: 0, chats: 4 }),
  ];

  it("hides programs with nothing new, keeps the ones it can't read", () => {
    expect(offeredTools(tools).map((one) => one.id)).toEqual(["claude", "codex"]);
    const locked = tool({ id: "opencode", newChats: 0, available: false });
    expect(offeredTools([locked]).map((one) => one.id)).toEqual(["opencode"]);
  });

  it("counts only what stays ticked", () => {
    expect(selectedChats(tools, new Set())).toBe(15);
    expect(selectedChats(tools, new Set(["claude"]))).toBe(3);
    expect(selectedTools(tools, new Set(["claude"]))).toEqual(["codex"]);
  });

  it("never selects a program it can't read", () => {
    const locked = tool({ id: "opencode", newChats: 5, available: false });
    expect(selectedTools([locked], new Set())).toEqual([]);
    expect(selectedChats([locked], new Set())).toBe(0);
  });

  it("appears only when there is something to import", () => {
    expect(hasOffer(undefined)).toBe(false);
    expect(hasOffer(status({ tools }))).toBe(true);
    expect(hasOffer(status({ state: "scanning", tools }))).toBe(false);
    expect(hasOffer(status({ tools: [tool({ newChats: 0 })] }))).toBe(false);
    expect(hasOffer(status({ tools: [tool({ available: false })] }))).toBe(false);
  });
});

describe("the lines", () => {
  it("promises only the default folders for apps found alongside", () => {
    expect(alsoFoundLine([])).toBeNull();
    expect(alsoFoundLine(["T3 Code"])).toBe(
      "T3 Code runs these tools, so chats in its default folders are included.",
    );
    expect(alsoFoundLine(["T3 Code", "Orca"])).toBe(
      "T3 Code and Orca run these tools, so chats in their default folders are included.",
    );
    expect(alsoFoundLine(["T3 Code", "Orca", "bb"])).toBe(
      "T3 Code, Orca and bb run these tools, so chats in their default folders are included.",
    );
  });

  it("counts skipped files together", () => {
    expect(skippedLine({ unreadable: 0, unknownFormat: 0 })).toBeNull();
    expect(skippedLine({ unreadable: 1, unknownFormat: 0 })).toBe(
      "1 file couldn't be read and was skipped.",
    );
    expect(skippedLine({ unreadable: 2, unknownFormat: 3 })).toBe(
      "5 files couldn't be read and were skipped.",
    );
  });

  it("says where the chats went", () => {
    expect(importResultLine({ imported: 88, recent: 12, snoozed: 76, failed: 0 })).toBe(
      "12 from today are in the list, 76 older ones in Snoozed.",
    );
    expect(importResultLine({ imported: 5, recent: 0, snoozed: 5, failed: 1 })).toBe(
      "5 older ones in Snoozed, 1 couldn't be added.",
    );
    expect(importResultLine({ imported: 0, recent: 0, snoozed: 0, failed: 0 })).toBe(
      "Nothing new to import.",
    );
  });

  it("stays quiet until something was imported", () => {
    expect(importedLine(undefined)).toBeNull();
    expect(importedLine(status({}))).toBeNull();
    expect(importedLine(status({ importedChats: 1, importedProjects: 1 }))).toBe(
      "1 chat · 1 project",
    );
    expect(importedLine(status({ importedChats: 240, importedProjects: 12 }))).toBe(
      "240 chats · 12 projects",
    );
  });
});

describe("an imported chat's notice", () => {
  const base = { loading: false, computerName: "MacBook" };

  it("shows loading first, and a way out if that failed", () => {
    expect(historyNotice({ ...base, history: undefined, loading: true })?.text).toBe(
      "Loading this chat from MacBook...",
    );
    expect(historyNotice({ ...base, history: undefined })).toEqual({
      text: "Couldn't load this chat.",
      retry: true,
    });
  });

  it("explains an offline computer and offers another try", () => {
    expect(
      historyNotice({ ...base, history: { kind: "offline", computerName: "MacBook" } }),
    ).toEqual({ text: "MacBook is offline. Turn it on to open this chat.", retry: true });
  });

  it("doesn't offer to retry a chat that's gone", () => {
    expect(historyNotice({ ...base, history: { kind: "gone" } })).toEqual({
      text: "This chat is no longer on MacBook.",
      retry: false,
    });
  });

  it("says nothing about a chat that loaded whole", () => {
    expect(
      historyNotice({
        ...base,
        history: { kind: "ready", messages: [], truncated: false, stale: false },
      }),
    ).toBeNull();
  });

  it("marks a saved copy and a cut history", () => {
    expect(
      historyNotice({
        ...base,
        history: { kind: "ready", messages: [], truncated: false, stale: true },
      })?.text,
    ).toBe("Saved copy: MacBook is offline.");
    expect(
      historyNotice({
        ...base,
        history: { kind: "ready", messages: [], truncated: true, stale: false },
      })?.text,
    ).toBe("Only the latest messages are shown.");
  });
});
