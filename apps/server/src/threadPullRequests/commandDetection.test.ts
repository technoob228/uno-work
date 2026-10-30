import { describe, expect, it } from "vitest";

import { changeRequestsCreatedBy, closesChangeRequest, shellCallOf } from "./commandDetection.ts";

const URL_12 = "https://github.com/acme/app/pull/12";

describe("changeRequestsCreatedBy", () => {
  it("takes the URL `gh pr create` printed", () => {
    expect(changeRequestsCreatedBy("gh pr create --fill", `Creating...\n${URL_12}\n`)).toMatchObject(
      [{ provider: "github", repository: "acme/app", number: 12 }],
    );
  });

  it("reads a command Codex wrapped in a login shell", () => {
    const input = `/bin/zsh -lc "git push -u origin HEAD && gh pr create --fill"`;
    expect(changeRequestsCreatedBy(input, `${URL_12}\n`)).toHaveLength(1);
  });

  it("takes a GitLab merge request from `glab mr create`", () => {
    const url = "https://gitlab.com/group/sub/app/-/merge_requests/7";
    expect(changeRequestsCreatedBy("glab mr create --fill --yes", `${url}\n`)).toMatchObject([
      { provider: "gitlab", repository: "group/sub/app", number: 7 },
    ]);
  });

  it("ignores text that only mentions the command", () => {
    expect(changeRequestsCreatedBy('echo "gh pr create"', `${URL_12}\n`)).toEqual([]);
    expect(
      changeRequestsCreatedBy("cat <<EOF\ngh pr create\nEOF", `${URL_12}\n`),
    ).toEqual([]);
  });

  it("ignores a URL an existing PR's command printed beside it", () => {
    expect(changeRequestsCreatedBy("gh pr view 12 && gh pr create", `${URL_12}\n`)).toEqual([]);
  });

  it("takes nothing when a list command printed URLs next to the create", () => {
    expect(
      changeRequestsCreatedBy(
        "gh pr create --fill; gh pr list",
        `${URL_12}\nhttps://github.com/acme/app/pull/9\n`,
      ),
    ).toEqual([]);
  });

  it("takes nothing when more URLs came out than creates ran", () => {
    expect(
      changeRequestsCreatedBy(
        "gh pr create --fill",
        `${URL_12}\nhttps://github.com/acme/app/pull/13\n`,
      ),
    ).toEqual([]);
  });

  it("does not take a GitLab URL from a GitHub create", () => {
    expect(
      changeRequestsCreatedBy(
        "gh pr create",
        "https://gitlab.com/group/app/-/merge_requests/1\n",
      ),
    ).toEqual([]);
  });
});

describe("closesChangeRequest", () => {
  it.each(["gh pr merge 12 --squash", "gh pr close 12", "glab mr merge 7", 'zsh -lc "gh pr merge"'])(
    "sees %s",
    (command) => {
      expect(closesChangeRequest(command)).toBe(true);
    },
  );

  it("leaves other commands alone", () => {
    expect(closesChangeRequest("gh pr view 12")).toBe(false);
    expect(closesChangeRequest("git merge main")).toBe(false);
  });
});

describe("shellCallOf", () => {
  const activity = (data: unknown, overrides: Record<string, unknown> = {}) => ({
    kind: "tool.completed",
    payload: { itemType: "command_execution", data, ...overrides },
  });

  it("reads Claude Code's shape", () => {
    expect(
      shellCallOf(
        activity({
          toolName: "Bash",
          input: { command: "gh pr create" },
          result: { type: "tool_result", content: [{ type: "text", text: URL_12 }] },
        }),
      ),
    ).toEqual({ command: "gh pr create", output: URL_12 });
  });

  it("reads Codex's shape", () => {
    expect(
      shellCallOf(activity({ item: { command: "gh pr create", aggregatedOutput: URL_12 } })),
    ).toEqual({ command: "gh pr create", output: URL_12 });
  });

  it("skips what isn't a finished shell call", () => {
    expect(shellCallOf({ kind: "tool.started", payload: {} })).toBe(null);
    expect(shellCallOf(activity({}, { itemType: "file_change" }))).toBe(null);
    expect(shellCallOf(activity({}))).toBe(null);
  });
});
