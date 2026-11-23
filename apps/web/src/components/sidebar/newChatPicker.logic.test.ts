import { describe, expect, it } from "vitest";

import {
  LAST_NEW_CHAT_STORAGE_KEY,
  defaultNewChatComputer,
  defaultNewChatFolderIndex,
  filterNewChatFolders,
  moveHighlight,
  nextConnectedComputer,
  readLastNewChatTarget,
  writeLastNewChatTarget,
} from "./newChatPicker.logic";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  };
}

const computers = [
  { id: "work", name: "uno-work", connected: true },
  { id: "mac", name: "MacBook", connected: true },
  { id: "free", name: "Free", connected: false },
];

const folders = [
  { key: "home", name: "Home folder", cwd: "/home/me" },
  { key: "project:a", name: "landing", cwd: "/home/me/landing" },
  { key: "project:b", name: "orders-bot", cwd: "/home/me/orders-bot" },
];

describe("the remembered choice", () => {
  it("is written and read back", () => {
    const storage = memoryStorage();
    writeLastNewChatTarget({ environmentId: "mac", cwd: "/Users/me/site" }, storage);
    expect(readLastNewChatTarget(storage)).toEqual({ environmentId: "mac", cwd: "/Users/me/site" });
  });

  it("ignores junk and an empty folder means the home folder", () => {
    const storage = memoryStorage();
    storage.setItem(LAST_NEW_CHAT_STORAGE_KEY, "{not json");
    expect(readLastNewChatTarget(storage)).toBeNull();
    storage.setItem(LAST_NEW_CHAT_STORAGE_KEY, JSON.stringify({ cwd: "/x" }));
    expect(readLastNewChatTarget(storage)).toBeNull();
    storage.setItem(LAST_NEW_CHAT_STORAGE_KEY, JSON.stringify({ environmentId: "work", cwd: "" }));
    expect(readLastNewChatTarget(storage)).toEqual({ environmentId: "work", cwd: null });
  });
});

describe("the computer the picker opens on", () => {
  it("is the one used last", () => {
    expect(
      defaultNewChatComputer({
        computers,
        last: { environmentId: "mac", cwd: null },
        lastChat: { environmentId: "work", cwd: null },
        activeEnvironmentId: "work",
      }),
    ).toBe("mac");
  });

  it("skips one that isn't connected now: the last chat's, then the one on screen", () => {
    expect(
      defaultNewChatComputer({
        computers,
        last: { environmentId: "free", cwd: null },
        lastChat: { environmentId: "mac", cwd: null },
        activeEnvironmentId: "work",
      }),
    ).toBe("mac");
    expect(
      defaultNewChatComputer({
        computers,
        last: null,
        lastChat: null,
        activeEnvironmentId: "work",
      }),
    ).toBe("work");
  });

  it("falls back to the first connected one, or none", () => {
    expect(
      defaultNewChatComputer({ computers, last: null, lastChat: null, activeEnvironmentId: null }),
    ).toBe("work");
    expect(
      defaultNewChatComputer({
        computers: [{ id: "free", name: "Free", connected: false }],
        last: null,
        lastChat: null,
        activeEnvironmentId: "free",
      }),
    ).toBeNull();
  });
});

describe("the folder highlighted", () => {
  it("is the one used last on that computer, trailing slash or not", () => {
    expect(
      defaultNewChatFolderIndex({
        environmentId: "work",
        folders,
        last: { environmentId: "work", cwd: "/home/me/orders-bot/" },
        lastChat: { environmentId: "work", cwd: "/home/me/landing" },
      }),
    ).toBe(2);
  });

  it("then the last chat's, then the home folder", () => {
    expect(
      defaultNewChatFolderIndex({
        environmentId: "work",
        folders,
        last: { environmentId: "mac", cwd: "/Users/me/x" },
        lastChat: { environmentId: "work", cwd: "/home/me/landing" },
      }),
    ).toBe(1);
    expect(
      defaultNewChatFolderIndex({
        environmentId: "work",
        folders,
        last: { environmentId: "work", cwd: "/gone" },
        lastChat: null,
      }),
    ).toBe(0);
  });

  it("the home folder used last is the home folder row", () => {
    expect(
      defaultNewChatFolderIndex({
        environmentId: "work",
        folders,
        last: { environmentId: "work", cwd: "/home/me" },
        lastChat: { environmentId: "work", cwd: "/home/me/landing" },
      }),
    ).toBe(0);
  });
});

describe("search and keys", () => {
  it("filters by name or path, case aside", () => {
    expect(filterNewChatFolders(folders, "LAND").map((f) => f.key)).toEqual(["project:a"]);
    expect(filterNewChatFolders(folders, "home").map((f) => f.key)).toEqual([
      "home",
      "project:a",
      "project:b",
    ]);
    expect(filterNewChatFolders(folders, "  ")).toBe(folders);
  });

  it("↑/↓ wrap round", () => {
    expect(moveHighlight(2, 3, 1)).toBe(0);
    expect(moveHighlight(0, 3, -1)).toBe(2);
    expect(moveHighlight(0, 0, 1)).toBe(0);
  });

  it("Tab goes to the next connected computer", () => {
    expect(nextConnectedComputer(computers, "work", 1)).toBe("mac");
    expect(nextConnectedComputer(computers, "mac", 1)).toBe("work");
    expect(nextConnectedComputer(computers, "work", -1)).toBe("mac");
    expect(nextConnectedComputer(computers, null, 1)).toBe("work");
    expect(nextConnectedComputer([computers[2]!], "free", 1)).toBeNull();
  });
});
