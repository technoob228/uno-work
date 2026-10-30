import { Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  NEW_PROJECT_SOURCES,
  cloudCrumbs,
  cloudProjectName,
  freeProjectName,
  newProjectSources,
  projectsFolderPath,
  uploadProjectName,
  uploadedProjectPath,
  checkNewFolderName,
  checkRepositoryInput,
  connectGithubPrompt,
  cloneFailureMessage,
  githubHttpsRemote,
  githubRepoSlug,
  repoAccessOffer,
  isRepoAccessError,
  clampToHome,
  homeCrumbs,
  isInsideHome,
  isPickableFolder,
  recentHomeFolders,
  tildePath,
  describedProjectPrompt,
  destinationKey,
  destinationRepository,
  projectDestinations,
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
  it("offers what the person already has first — laptop, this computer, cloud, GitHub — then empty", () => {
    expect(newProjectSources()).toEqual(["upload", "folder", "cloud", "github", "empty"]);
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

describe("a project from Cloud storage", () => {
  it("is named after the picked folder, or the bucket at its root", () => {
    expect(cloudProjectName("my-files", "sites/landing page/")).toBe("landing-page");
    expect(cloudProjectName("my-files", "")).toBe("my-files");
    expect(cloudProjectName("", "")).toBe("my-project");
  });

  it("walks from the bucket down to the folder", () => {
    expect(cloudCrumbs("my-files", "")).toEqual([{ label: "my-files", prefix: "" }]);
    expect(cloudCrumbs("my-files", "sites/landing/")).toEqual([
      { label: "my-files", prefix: "" },
      { label: "sites", prefix: "sites/" },
      { label: "landing", prefix: "sites/landing/" },
    ]);
  });
});

describe("describedProjectPrompt", () => {
  const base = {
    name: "shop",
    folder: "/home/unowork/projects/shop",
    about: "  An online shop.  ",
  };

  it("no folder: starts from the person's words and asks before doing", () => {
    const prompt = describedProjectPrompt({ ...base, contents: "none" });
    expect(prompt).toContain("the folder is empty for now");
    expect(prompt).toContain("What I have in mind: An online shop.");
    expect(prompt).toContain("Ask me what you need to know");
  });

  it("files or a repository: their words, then look inside", () => {
    expect(describedProjectPrompt({ ...base, contents: "files" })).toContain(
      `I've added my project "shop" to /home/unowork/projects/shop.`,
    );
    const cloned = describedProjectPrompt({ ...base, contents: "repository" });
    expect(cloned).toContain(`I've cloned my project "shop"`);
    expect(cloned).toContain("About it, in my words: An online shop.");
    expect(cloned).toContain("Look at what's inside");
  });

  it("part of the upload didn't fit: says so and where the list is, even with no words", () => {
    const prompt = describedProjectPrompt({
      ...base,
      about: "",
      contents: "files",
      notUploaded: { files: 87741, listFile: ".uno-not-uploaded.txt" },
    });
    expect(prompt).not.toContain("About it");
    expect(prompt).toContain(
      "Not everything fit in the upload: 87,741 files stayed on my computer. The list is in .uno-not-uploaded.txt.",
    );
    expect(prompt).toContain("Start your reply with one line on what's missing");
    expect(prompt).toContain("Then look at what's inside");
  });
});

describe("checkRepositoryInput without a scheme", () => {
  it("github.com/owner/repo is the repository it names", () => {
    expect(checkRepositoryInput("github.com/owner/repo", new Set())).toEqual({
      ok: true,
      remoteUrl: "https://github.com/owner/repo.git",
      name: "repo",
    });
    expect(checkRepositoryInput("www.github.com/owner/repo/tree/main", new Set())).toMatchObject({
      ok: true,
      remoteUrl: "https://github.com/owner/repo.git",
    });
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

const github = (connected: boolean, available = true) => ({
  available,
  connected,
  accounts: connected ? ["technoob228"] : [],
});

describe("GitHub of the account on a refused clone (icp3 10.10)", () => {
  const repo = "https://github.com/technoob228/uno-workspace.git";

  it("offers one Connect GitHub for the whole account", () => {
    expect(repoAccessOffer(repo, github(false))).toBe("connect");
  });

  it("asks to add the repository when GitHub is connected already", () => {
    expect(repoAccessOffer(repo, github(true))).toBe("add-repo");
    expect(repoAccessOffer("git@github.com:technoob228/uno-workspace.git", github(true))).toBe(
      "add-repo",
    );
  });

  it("falls back to this computer's SSH key where the account's GitHub can't help", () => {
    expect(repoAccessOffer(repo, null)).toBe("ssh-key");
    expect(repoAccessOffer(repo, github(false, false))).toBe("ssh-key");
    expect(repoAccessOffer("https://gitlab.com/a/b.git", github(true))).toBe("ssh-key");
  });

  it("clones over https once the account signs git in", () => {
    expect(githubHttpsRemote("git@github.com:technoob228/uno-workspace.git")).toBe(repo);
    expect(githubHttpsRemote(repo)).toBe(repo);
    expect(githubHttpsRemote("git@gitlab.com:a/b.git")).toBe("git@gitlab.com:a/b.git");
  });
});

const wrapped = (detail: string) =>
  `Source control repository operation cloneRepository failed for unknown: git clone -- https://github.com/a/b.git b failed: Cloning into 'b'... ${detail}`;

describe("a failed clone in words for people (Misha 20.10)", () => {
  it("never passes git's own text through", () => {
    for (const detail of [
      "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com",
      "fatal: early EOF",
      "error: RPC failed; curl 56 GnuTLS recv error",
      "fatal: something nobody has seen before",
    ]) {
      const message = cloneFailureMessage(wrapped(detail));
      expect(message).not.toContain("fatal");
      expect(message).not.toContain("Source control");
      expect(message).not.toContain("git clone");
    }
  });

  it("names the cause it can tell", () => {
    expect(
      cloneFailureMessage(wrapped("fatal: unable to access …: Could not resolve host: github.com")),
    ).toMatch(/internet connection/);
    expect(cloneFailureMessage("Destination path already exists and is not empty.")).toMatch(
      /already a folder/,
    );
    expect(cloneFailureMessage(wrapped("fatal: write error: No space left on device"))).toMatch(
      /no free space/,
    );
  });

  it("sends the access refusals to the GitHub notice, not here", () => {
    expect(
      isRepoAccessError(
        wrapped(
          "Uno: GitHub isn't connected to your Uno account yet.\nfatal: could not read Username for 'https://github.com': No such device or address",
        ),
      ),
    ).toBe(true);
  });
});

describe("where a new project syncs", () => {
  const provider = (
    kind: "github" | "gitlab",
    status: "authenticated" | "unauthenticated" | "unknown",
    installed: "available" | "missing" = "available",
  ) => ({
    kind,
    label: kind,
    status: installed,
    version: Option.none(),
    installHint: "install it",
    detail: Option.none(),
    auth: {
      status,
      account: status === "authenticated" ? Option.some("misha") : Option.none(),
      host: Option.none(),
      detail: Option.none(),
    },
  });
  const discovery = (...providers: ReadonlyArray<ReturnType<typeof provider>>) => ({
    versionControlSystems: [],
    sourceControlProviders: providers,
  });
  const keys = (input: Parameters<typeof projectDestinations>[0]) =>
    projectDestinations(input).map(destinationKey);

  it("Uno first, for everyone, with nothing connected", () => {
    expect(keys({ discovery: null, unoCloud: null })).toEqual(["uno", "here"]);
    expect(keys({ discovery: discovery(), unoCloud: true })).toEqual(["uno", "here"]);
  });

  it("offers a host only when this computer is signed in to it", () => {
    expect(
      keys({
        discovery: discovery(
          provider("github", "authenticated"),
          provider("gitlab", "authenticated"),
        ),
        unoCloud: true,
      }),
    ).toEqual(["uno", "github", "gitlab", "here"]);
    expect(
      keys({
        discovery: discovery(provider("github", "unauthenticated"), provider("gitlab", "unknown")),
        unoCloud: true,
      }),
    ).toEqual(["uno", "here"]);
    expect(
      keys({
        discovery: discovery(provider("github", "authenticated", "missing")),
        unoCloud: true,
      }),
    ).toEqual(["uno", "here"]);
  });

  it("doesn't offer Uno on a computer that isn't signed in to it", () => {
    expect(keys({ discovery: discovery(), unoCloud: false })).toEqual(["here"]);
    expect(
      keys({ discovery: discovery(provider("github", "authenticated")), unoCloud: false }),
    ).toEqual(["github", "here"]);
  });

  it("names the repository under the account, when it's known", () => {
    const [host] = projectDestinations({
      discovery: discovery(provider("github", "authenticated")),
      unoCloud: false,
    });
    if (host?.kind !== "host") throw new Error("expected a host");
    expect(destinationRepository(host, "site")).toBe("misha/site");
    expect(destinationRepository({ ...host, owner: null }, "site")).toBe("site");
  });
});
