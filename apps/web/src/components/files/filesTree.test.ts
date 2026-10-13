import { describe, expect, it } from "vitest";

import { filesPlaceKey, visitPlace } from "./filesHistory";
import { ancestorFolders } from "./FilesTree";

describe("ancestorFolders", () => {
  it("lists the folders from the root down to the one holding the file", () => {
    expect(ancestorFolders("/home/u", "/home/u/projects/app/src/a.ts")).toEqual([
      "/home/u",
      "/home/u/projects",
      "/home/u/projects/app",
      "/home/u/projects/app/src",
    ]);
  });

  it("is just the root for a file in the root or outside it", () => {
    expect(ancestorFolders("/home/u", "/home/u/a.md")).toEqual(["/home/u"]);
    expect(ancestorFolders("/home/u", "/etc/hosts")).toEqual(["/home/u"]);
    expect(ancestorFolders("/home/u/", "/home/u/x/a.md")).toEqual(["/home/u", "/home/u/x"]);
  });
});

describe("visitPlace", () => {
  const key = (path?: string) => filesPlaceKey(path ? { path } : {});
  const start = { entries: [] as string[], index: -1 };

  it("pushes places and ignores the one it is already on", () => {
    const a = visitPlace(start, key());
    const b = visitPlace(a, key("/h/x"));
    expect(visitPlace(b, key("/h/x"))).toBe(b);
    expect(b.entries).toHaveLength(2);
    expect(b.index).toBe(1);
  });

  it("drops the forward part when a new place is opened after going back", () => {
    let stack = visitPlace(visitPlace(visitPlace(start, key()), key("/h/a")), key("/h/b"));
    stack = { ...stack, index: 0 };
    stack = visitPlace(stack, key("/h/c"));
    expect(stack.entries).toEqual([key(), key("/h/c")]);
    expect(stack.index).toBe(1);
  });
});
