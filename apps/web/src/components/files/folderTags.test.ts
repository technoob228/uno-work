import { describe, expect, it } from "vitest";

import { expandHome, folderTagOf, folderTags } from "./folderTags";

describe("folderTags", () => {
  const tags = folderTags({
    projectFolders: ["/home/unowork/projects/schedule/", "/home/unowork", "/home/unowork/projects/notes"],
    appFolders: ["~/projects/notes", null, "~"],
    home: "/home/unowork/",
  });

  it("tags project folders and app code folders, the app winning", () => {
    expect(folderTagOf(tags, "/home/unowork/projects/schedule")).toBe("Project");
    expect(folderTagOf(tags, "/home/unowork/projects/notes/")).toBe("App");
  });

  it("leaves the home folder and everything else alone", () => {
    expect(folderTagOf(tags, "/home/unowork")).toBeNull();
    expect(folderTagOf(tags, "/home/unowork/projects")).toBeNull();
    expect(folderTagOf(tags, "/home/unowork/Downloads")).toBeNull();
  });

  it("expands ~ only when home is known", () => {
    expect(expandHome("~/a", "/home/u")).toBe("/home/u/a");
    expect(expandHome("~/a", null)).toBeNull();
    expect(expandHome("relative/a", "/home/u")).toBeNull();
  });
});
