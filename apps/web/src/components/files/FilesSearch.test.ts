import type { FilesEntry } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  filesSearchScope,
  focusFilesSearchOnFind,
  matchFilesByName,
  resultLocation,
} from "./FilesSearch";

const entry = (name: string): FilesEntry => ({
  name,
  path: `/home/uno/${name}`,
  kind: "file",
  size: 1,
  modifiedAt: "2026-10-30T00:00:00.000Z",
  hidden: false,
  isSymlink: false,
});

describe("filesSearchScope", () => {
  it("searches the chat's project while inside it", () => {
    const input = { rootPath: "/home/uno", projectFolder: "/home/uno/projects/site" };
    expect(filesSearchScope({ ...input, currentPath: "/home/uno/projects/site/web" })).toBe(
      "/home/uno/projects/site",
    );
    expect(filesSearchScope({ ...input, currentPath: "/home/uno/projects/site" })).toBe(
      "/home/uno/projects/site",
    );
  });

  it("searches the home folder from anywhere else", () => {
    expect(
      filesSearchScope({
        rootPath: "/home/uno",
        projectFolder: "/home/uno/projects/site",
        currentPath: "/home/uno/projects/site-two",
      }),
    ).toBe("/home/uno");
    expect(filesSearchScope({ rootPath: "/home/uno", currentPath: "/home/uno/docs" })).toBe(
      "/home/uno",
    );
  });
});

describe("matchFilesByName", () => {
  it("ignores case and the spaces around the query", () => {
    const entries = [entry("Report.md"), entry("notes.txt")];
    expect(matchFilesByName(entries, "  rep ").map((item) => item.name)).toEqual(["Report.md"]);
  });

  it("takes any script", () => {
    expect(matchFilesByName([entry("Отчёт.md")], "отчёт")).toHaveLength(1);
  });
});

describe("resultLocation", () => {
  it("names the folder from where the search started", () => {
    expect(resultLocation("/home/uno", "/home/uno/docs/deep/a.md")).toBe("docs/deep");
    expect(resultLocation("/home/uno", "/home/uno/a.md")).toBeNull();
  });
});

describe("focusFilesSearchOnFind", () => {
  const press = (key: string, modifiers: { metaKey?: boolean; shiftKey?: boolean } = {}) => {
    const event = {
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...modifiers,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const input = { focus: vi.fn(), select: vi.fn() };
    return { event, input };
  };
  const send = ({ event, input }: ReturnType<typeof press>, field: unknown = input) =>
    focusFilesSearchOnFind(
      event as unknown as Parameters<typeof focusFilesSearchOnFind>[0],
      field as HTMLInputElement | null,
    );

  it("puts the cursor in the search on ⌘F, with what's there selected", () => {
    const pressed = press("f", { metaKey: true });
    send(pressed);
    expect(pressed.input.focus).toHaveBeenCalled();
    expect(pressed.input.select).toHaveBeenCalled();
    expect(pressed.event.preventDefault).toHaveBeenCalled();
  });

  it("leaves other keys alone", () => {
    for (const pressed of [press("f"), press("f", { metaKey: true, shiftKey: true })]) {
      send(pressed);
      expect(pressed.input.focus).not.toHaveBeenCalled();
      expect(pressed.event.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("leaves ⌘F to the browser where there is no search (Recent)", () => {
    const pressed = press("f", { metaKey: true });
    send(pressed, null);
    expect(pressed.event.preventDefault).not.toHaveBeenCalled();
  });
});
