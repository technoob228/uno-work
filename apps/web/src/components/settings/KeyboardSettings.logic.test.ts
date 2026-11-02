import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
} from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vitest";

import {
  browserKeepsShortcut,
  buildKeyRows,
  filterKeyRows,
  groupKeyRows,
  keybindingFromKeyboardEvent,
  keyConflicts,
} from "./KeyboardSettings.logic";

const MAC = "MacIntel";
const rowsOf = (devMode: boolean) =>
  buildKeyRows(DEFAULT_RESOLVED_KEYBINDINGS, { devMode, platform: MAC });

const press = (input: Partial<KeyboardEvent> & { key: string; code: string }) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...input,
});

describe("buildKeyRows", () => {
  it("has one row per action, in groups, with every default key", () => {
    const rows = rowsOf(false);
    const chatNew = rows.find((row) => row.command === "chat.new");
    expect(chatNew?.labels).toEqual(["⌘N", "⇧⌘O"]);
    expect(groupKeyRows(rows).map((section) => section.title)).toEqual([
      "Chats",
      "Message box",
      "Moving around",
    ]);
  });

  it("keeps developer actions and numbered jumps out of the plain list", () => {
    const commands = rowsOf(false).map((row) => row.command);
    expect(commands).not.toContain("terminal.toggle");
    expect(commands).not.toContain("thread.jump.1");
    expect(rowsOf(true).map((row) => row.command)).toContain("terminal.toggle");
  });

  it("marks an action with its own keys, and keeps its condition for the next change", () => {
    const custom = compileResolvedKeybindingsConfig([
      { key: "mod+y", command: "sidebar.toggle", when: "!terminalFocus" },
    ]);
    const rest = DEFAULT_RESOLVED_KEYBINDINGS.filter((rule) => rule.command !== "sidebar.toggle");
    const row = buildKeyRows([...rest, ...custom], { devMode: false, platform: MAC }).find(
      (candidate) => candidate.command === "sidebar.toggle",
    );
    expect(row).toMatchObject({ changed: true, labels: ["⌘Y"], when: "!terminalFocus" });
    expect(rowsOf(false).some((candidate) => candidate.changed)).toBe(false);
  });
});

describe("filterKeyRows", () => {
  it("finds by words and by keys", () => {
    const rows = rowsOf(false);
    expect(filterKeyRows(rows, "SIDEBAR").map((row) => row.command)).toEqual(["sidebar.toggle"]);
    expect(filterKeyRows(rows, "⌘B").map((row) => row.command)).toEqual(["sidebar.toggle"]);
  });
});

describe("keyConflicts", () => {
  it("names the action already on these keys, in the same place", () => {
    const rows = rowsOf(false);
    expect(
      keyConflicts(rows, { command: "thread.pin", key: "mod+b", when: "!terminalFocus" }, MAC),
    ).toEqual(["Show or hide the sidebar"]);
  });

  it("doesn't count keys that work in another place", () => {
    // ⌘D also splits the terminal, but only while the terminal has focus.
    expect(
      keyConflicts(
        rowsOf(true),
        { command: "chat.new", key: "mod+d", when: "!terminalFocus" },
        MAC,
      ),
    ).toEqual(["Show changes"]);
  });
});

describe("recording", () => {
  it("reads the physical key on any layout", () => {
    expect(keybindingFromKeyboardEvent(press({ key: "и", code: "KeyB", metaKey: true }), MAC)).toBe(
      "mod+b",
    );
    expect(
      keybindingFromKeyboardEvent(
        press({ key: "S", code: "KeyS", ctrlKey: true, shiftKey: true }),
        "Win32",
      ),
    ).toBe("mod+shift+s");
  });

  it("waits for a whole shortcut", () => {
    expect(
      keybindingFromKeyboardEvent(press({ key: "Meta", code: "MetaLeft", metaKey: true }), MAC),
    ).toBeNull();
    expect(keybindingFromKeyboardEvent(press({ key: "a", code: "KeyA" }), MAC)).toBeNull();
    expect(keybindingFromKeyboardEvent(press({ key: "F5", code: "F5" }), MAC)).toBe("f5");
  });
});

describe("browserKeepsShortcut", () => {
  it("knows what a tab never receives", () => {
    expect(browserKeepsShortcut("mod+n")).toBe(true);
    expect(browserKeepsShortcut("mod+shift+n")).toBe(true);
    expect(browserKeepsShortcut("mod+k")).toBe(false);
  });
});
