import { describe, expect, it } from "vitest";

import {
  NEW_PROJECT_SOURCES,
  freeProjectName,
  newProjectSources,
  projectsFolderPath,
  uploadProjectName,
  uploadedProjectPath,
  checkNewFolderName,
  checkRepositoryInput,
  connectGithubPrompt,
  githubRepoSlug,
  isRepoAccessError,
  clampToHome,
  homeCrumbs,
  isInsideHome,
  isPickableFolder,
  recentHomeFolders,
  tildePath,
} from "./newProject.logic";

const HOME = "/home/uno";

describe("home fence", () => {
  it("knows what is inside the home folder", () => {
    expect(isInsideHome("/home/uno", HOME)).toBe(true);
    expect(isInsideHome("/home/uno/projects/", HOME)).toBe(true);
    expect(isInsideHome("/home/unother", HOME)).toBe(false);
    expect(isInsideHome("/etc", HOME)).toBe(false);
  });

  it("clamps anything outside back to home", () => {
    expect(clampToHome("/etc", HOME)).toBe(HOME);
    expect(clampToHome(null, HOME)).toBe(HOME);
    expect(clampToHome("/home/uno/site/", HOME)).toBe("/home/uno/site");
  });

  it("builds crumbs from the home folder down", () => {
    expect(homeCrumbs("/home/uno/projects/site", HOME)).toEqual([
      { label: "Home folder", path: HOME },
      { label: "projects", path: "/home/uno/projects" },
      { label: "site", path: "/home/uno/projects/site" },
    ]);
    expect(homeCrumbs("/var/log", HOME)).toEqual([{ label: "Home folder", path: HOME }]);
    expect(tildePath("/home/uno/projects", HOME)).toBe("~/projects");
    expect(tildePath(HOME, HOME)).toBe("~");
  });
});

it("hides dot-folders and system folders at the home root only", () => {
  expect(isPickableFolder(".config", HOME, HOME)).toBe(false);
  expect(isPickableFolder("Library", HOME, HOME)).toBe(false);
  expect(isPickableFolder("Library", "/home/uno/projects", HOME)).toBe(true);
  expect(isPickableFolder("projects", HOME, HOME)).toBe(true);
});

describe("recentHomeFolders", () => {
  it("lists folders inside home, newest first, without home itself", () => {
    const projects = [
      { id: "a", cwd: "/home/uno/a", name: "a", updatedAt: "2026-09-01T00:00:00Z" },
      { id: "b", cwd: "/home/uno/b", name: "b", updatedAt: "2026-09-20T00:00:00Z" },
      { id: "home", cwd: HOME, name: "Home folder", updatedAt: "2026-09-24T00:00:00Z" },
      { id: "out", cwd: "/srv/x", name: "x", updatedAt: "2026-09-24T00:00:00Z" },
      { id: "dup", cwd: "/home/uno/b/", name: "b", updatedAt: "2026-09-10T00:00:00Z" },
    ];
    expect(recentHomeFolders(projects, HOME).map((project) => project.id)).toEqual(["b", "a"]);
  });
});

describe("checkNewFolderName", () => {
  it("normalizes and refuses taken or empty names", () => {
    expect(checkNewFolderName("My site", new Set())).toEqual({ ok: true, name: "My-site" });
    expect(checkNewFolderName("  ", new Set()).ok).toBe(false);
    expect(checkNewFolderName("///", new Set()).ok).toBe(false);
    expect(checkNewFolderName("site", new Set(["site"])).ok).toBe(false);
  });
});

describe("checkRepositoryInput", () => {
  it("accepts the ways people paste a GitHub repo", () => {
    for (const input of [
      "owner/repo",
      "https://github.com/owner/repo",
      "https://github.com/owner/repo.git",
      "https://github.com/owner/repo/tree/main/src",
    ]) {
      expect(checkRepositoryInput(input, new Set())).toEqual({
        ok: true,
        remoteUrl: "https://github.com/owner/repo.git",
        name: "repo",
      });
    }
    expect(checkRepositoryInput("git@github.com:owner/repo.git", new Set())).toMatchObject({
      ok: true,
      name: "repo",
    });
  });

  it("refuses junk and taken folder names", () => {
    expect(checkRepositoryInput("hello world", new Set()).ok).toBe(false);
    expect(checkRepositoryInput("owner/repo", new Set(["repo"])).ok).toBe(false);
  });
});

it("does not offer templates until there are project templates", () => {
  expect(NEW_PROJECT_SOURCES).not.toContain("template");
});

describe("upload as a new project", () => {
  it("offers upload first, then GitHub, then empty, then a folder on the computer — no Dev mode", () => {
    expect(newProjectSources()).toEqual(["upload", "github", "empty", "folder"]);
  });

  it("names the project after the folder or the zip", () => {
    expect(uploadProjectName([{ relativePath: "My Site/index.html" }])).toBe("My-Site");
    expect(uploadProjectName([{ relativePath: "shop.zip" }])).toBe("shop");
    // One loose file is not a project name.
    expect(uploadProjectName([{ relativePath: "index.html" }])).toBe("my-project");
    expect(uploadProjectName([{ relativePath: "a.txt" }, { relativePath: "b.txt" }])).toBe(
      "my-project",
    );
  });

  it("lands in ~/projects and never over an existing folder", () => {
    expect(uploadedProjectPath("/home/uno/", "shop")).toBe("/home/uno/projects/shop");
    expect(projectsFolderPath("/home/uno/")).toBe("/home/uno/projects");
    expect(freeProjectName("shop", new Set(["shop", "shop-2"]))).toBe("shop-3");
    expect(freeProjectName("shop", new Set())).toBe("shop");
  });
});

describe("private repository on clone (icp3 09.10)", () => {
  it("tells git's sign-in failures from other errors", () => {
    expect(
      isRepoAccessError(
        "git clone -- https://github.com/a/b.git b failed: Cloning into 'b'... fatal: could not read Username for 'https://github.com': No such device or address",
      ),
    ).toBe(true);
    expect(isRepoAccessError("remote: Repository not found.")).toBe(true);
    expect(isRepoAccessError("git@github.com: Permission denied (publickey).")).toBe(true);
    expect(isRepoAccessError("fatal: destination path 'b' already exists")).toBe(false);
  });

  it("asks Uno for an SSH key and the SSH address", () => {
    expect(githubRepoSlug("https://github.com/technoob228/uno-workspace.git")).toBe(
      "technoob228/uno-workspace",
    );
    expect(githubRepoSlug("git@github.com:technoob228/uno-workspace.git")).toBe(
      "technoob228/uno-workspace",
    );
    const prompt = connectGithubPrompt("https://github.com/technoob228/uno-workspace.git");
    expect(prompt).toContain("git@github.com:technoob228/uno-workspace.git");
    expect(prompt).toContain("https://github.com/settings/ssh/new");
    expect(prompt).not.toMatch(/token:/i);
  });
});
