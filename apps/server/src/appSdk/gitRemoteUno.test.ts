import { describe, expect, it } from "vitest";

import {
  GIT_REMOTE_UNO_ALIAS_KEY,
  ensureGitRemoteUnoAlias,
  gitRemoteUnoAliasValue,
  type GitConfigResult,
} from "./gitRemoteUno.ts";

function fakeConfig(initial: string | null) {
  let value = initial;
  const calls: string[][] = [];
  return {
    calls,
    get value() {
      return value;
    },
    gitConfigGlobal: async (args: ReadonlyArray<string>): Promise<GitConfigResult> => {
      calls.push([...args]);
      if (args[0] === "--get")
        return value === null ? { code: 1, stdout: "" } : { code: 0, stdout: `${value}\n` };
      value = args[1] ?? null;
      return { code: 0, stdout: "" };
    },
  };
}

describe("ensureGitRemoteUnoAlias", () => {
  it("points git's remote-uno alias at the SDK helper, once", async () => {
    const config = fakeConfig(null);
    expect(await ensureGitRemoteUnoAlias({ home: "/home/me", ...config })).toBe("added");
    expect(config.value).toBe("!'/home/me/.uno/sdk/bin/git-remote-uno'");
    expect(config.calls.at(-1)?.[0]).toBe(GIT_REMOTE_UNO_ALIAS_KEY);
    expect(await ensureGitRemoteUnoAlias({ home: "/home/me", ...config })).toBe("kept");
    expect(config.calls).toHaveLength(3);
  });

  it("updates an older copy of ours, leaves the person's own alias alone", async () => {
    const ours = fakeConfig("!'/old/home/.uno/sdk/bin/git-remote-uno'");
    expect(await ensureGitRemoteUnoAlias({ home: "/home/me", ...ours })).toBe("added");
    const theirs = fakeConfig("!my-helper");
    expect(await ensureGitRemoteUnoAlias({ home: "/home/me", ...theirs })).toBe("foreign");
    expect(theirs.value).toBe("!my-helper");
  });

  it("quotes a home with a quote in it for the shell", () => {
    expect(gitRemoteUnoAliasValue("/home/o'neil")).toBe(
      "!'/home/o'\\''neil/.uno/sdk/bin/git-remote-uno'",
    );
  });
});
