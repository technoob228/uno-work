import { describe, expect, it } from "vitest";

import {
  detectSourceControlProviderFromRemoteUrl,
  getChangeRequestTerminologyForKind,
  parseChangeRequestUrl,
  parseRemoteRepositoryPath,
  resolveChangeRequestPresentation,
} from "./sourceControl.ts";

describe("source control presentation", () => {
  it("uses merge request terminology for GitLab", () => {
    expect(getChangeRequestTerminologyForKind("gitlab")).toEqual({
      shortLabel: "MR",
      singular: "merge request",
    });
  });

  it("uses pull request terminology for GitHub-compatible providers", () => {
    expect(getChangeRequestTerminologyForKind("github")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind("azure-devops")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind("bitbucket")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
  });

  it("falls back to generic change request copy for unknown providers", () => {
    expect(
      resolveChangeRequestPresentation({ kind: "unknown", name: "forge", baseUrl: "" }),
    ).toEqual(
      expect.objectContaining({
        shortName: "change request",
        longName: "change request",
      }),
    );
  });
});

describe("detectSourceControlProviderFromRemoteUrl", () => {
  it("detects common source control hosts", () => {
    expect(detectSourceControlProviderFromRemoteUrl("git@github.com:owner/repo.git")?.kind).toBe(
      "github",
    );
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.com/group/repo.git")?.kind,
    ).toBe("gitlab");
    expect(
      detectSourceControlProviderFromRemoteUrl("https://dev.azure.com/org/project/_git/repo")?.kind,
    ).toBe("azure-devops");
    expect(
      detectSourceControlProviderFromRemoteUrl("git@bitbucket.org:workspace/repo.git")?.kind,
    ).toBe("bitbucket");
  });
});

describe("parseRemoteRepositoryPath", () => {
  it.each([
    ["git@github.com:acme/app.git", "acme/app"],
    ["https://github.com/acme/app.git", "acme/app"],
    ["https://github.com/acme/app/", "acme/app"],
    ["ssh://git@github.com:22/acme/app.git", "acme/app"],
    ["git@gitlab.com:group/sub/app.git", "group/sub/app"],
    ["https://gitlab.example.com/group/sub/app", "group/sub/app"],
  ])("reads %s", (remote, repository) => {
    expect(parseRemoteRepositoryPath(remote)).toBe(repository);
  });

  it("refuses what is not a repository", () => {
    expect(parseRemoteRepositoryPath("uno::team/app")).toBe(null);
    expect(parseRemoteRepositoryPath("https://github.com/acme")).toBe(null);
    expect(parseRemoteRepositoryPath("")).toBe(null);
  });
});

describe("parseChangeRequestUrl", () => {
  it("reads a GitHub pull request", () => {
    expect(parseChangeRequestUrl("https://github.com/acme/app/pull/12")).toEqual({
      provider: "github",
      host: "github.com",
      repository: "acme/app",
      number: 12,
      url: "https://github.com/acme/app/pull/12",
    });
  });

  it("reads a GitLab merge request in a nested group", () => {
    expect(
      parseChangeRequestUrl("https://gitlab.com/group/sub/app/-/merge_requests/7"),
    ).toMatchObject({ provider: "gitlab", repository: "group/sub/app", number: 7 });
  });

  it("refuses other pages", () => {
    expect(parseChangeRequestUrl("https://github.com/acme/app/issues/12")).toBe(null);
    expect(parseChangeRequestUrl("https://github.com/acme/app/pull/12/files")).toBe(null);
  });
});
