import { lstat, mkdir, mkdtemp, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProviderInstanceId } from "@t3tools/contracts";

import {
  accountDisplayName,
  accountFolder,
  accountFolderOf,
  accountInstanceConfig,
  accountsRoot,
  instanceClaudeConfigDir,
  isAccountFolder,
  newAccountInstanceId,
  prepareAccountFolder,
  removeAccountFolder,
} from "./providerAccounts.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(nodePath.join(tmpdir(), "accounts-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const claudeDir = () => nodePath.join(home, ".claude");
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe("provider instance of a second account", () => {
  it("gives Claude a config dir of its own and leaves HOME alone", () => {
    const instance = accountInstanceConfig({
      driver: "claudeAgent",
      name: "Personal",
      folder: "/h/.uno-accounts/x",
    });
    expect(instance.displayName).toBe("Claude · Personal");
    expect(instanceClaudeConfigDir(instance.environment)).toBe("/h/.uno-accounts/x");
    expect(instance.config).toEqual({});
    expect(accountFolderOf(instance)).toBe("/h/.uno-accounts/x");
  });

  it("gives ChatGPT a shadow home: auth.json apart, sessions shared", () => {
    const instance = accountInstanceConfig({
      driver: "codex",
      name: "Work",
      folder: "/h/.uno-accounts/y",
    });
    expect(instance.displayName).toBe("ChatGPT · Work");
    expect(instance.environment).toBeUndefined();
    expect(instance.config).toEqual({ shadowHomePath: "/h/.uno-accounts/y" });
    expect(accountFolderOf(instance)).toBe("/h/.uno-accounts/y");
  });

  it("makes ids the provider-instance schema accepts", () => {
    expect(() => ProviderInstanceId.make(newAccountInstanceId("claudeAgent"))).not.toThrow();
    expect(() => ProviderInstanceId.make(newAccountInstanceId("codex"))).not.toThrow();
    expect(newAccountInstanceId("codex")).toMatch(/^codex_account_[0-9a-f]{8}$/);
    expect(accountDisplayName("codex", "  Work ")).toBe("ChatGPT · Work");
  });
});

describe("the sign-in folder", () => {
  it("is private to the daemon's user", async () => {
    const id = newAccountInstanceId("claudeAgent");
    const folder = accountFolder(home, id);
    await prepareAccountFolder({ driver: "claudeAgent", home, folder, claudeDir: claudeDir() });
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(accountsRoot(home))).mode & 0o777).toBe(0o700);
  });

  it("links the person's skills and preferences, never who is signed in", async () => {
    await mkdir(nodePath.join(claudeDir(), "skills"), { recursive: true });
    await writeFile(nodePath.join(claudeDir(), "settings.json"), "{}");
    await writeFile(nodePath.join(claudeDir(), ".credentials.json"), "secret");
    await writeFile(nodePath.join(claudeDir(), ".claude.json"), "{}");
    await mkdir(nodePath.join(claudeDir(), "projects"));
    const folder = accountFolder(home, newAccountInstanceId("claudeAgent"));

    await prepareAccountFolder({ driver: "claudeAgent", home, folder, claudeDir: claudeDir() });

    expect(await readlink(nodePath.join(folder, "skills"))).toBe(
      nodePath.join(claudeDir(), "skills"),
    );
    expect(await readlink(nodePath.join(folder, "settings.json"))).toBe(
      nodePath.join(claudeDir(), "settings.json"),
    );
    expect(await exists(nodePath.join(folder, ".credentials.json"))).toBe(false);
    expect(await exists(nodePath.join(folder, ".claude.json"))).toBe(false);
    expect(await exists(nodePath.join(folder, "projects"))).toBe(false);
    // Something that isn't there isn't linked.
    expect(await exists(nodePath.join(folder, "commands"))).toBe(false);
  });

  it("is safe to prepare twice", async () => {
    await mkdir(nodePath.join(claudeDir(), "skills"), { recursive: true });
    const folder = accountFolder(home, newAccountInstanceId("claudeAgent"));
    const input = { driver: "claudeAgent", home, folder, claudeDir: claudeDir() } as const;
    await prepareAccountFolder(input);
    await expect(prepareAccountFolder(input)).resolves.toBeUndefined();
  });

  it("removes only a folder of its own, and never follows a link out of it", async () => {
    await mkdir(nodePath.join(claudeDir(), "skills", "mine"), { recursive: true });
    const folder = accountFolder(home, newAccountInstanceId("claudeAgent"));
    await prepareAccountFolder({ driver: "claudeAgent", home, folder, claudeDir: claudeDir() });

    expect(await removeAccountFolder(home, folder)).toBe(true);
    expect(await exists(folder)).toBe(false);
    expect(await exists(nodePath.join(claudeDir(), "skills", "mine"))).toBe(true);

    expect(await removeAccountFolder(home, claudeDir())).toBe(false);
    expect(await removeAccountFolder(home, accountsRoot(home))).toBe(false);
    expect(await removeAccountFolder(home, nodePath.join(accountsRoot(home), ".."))).toBe(false);
    expect(await exists(claudeDir())).toBe(true);
  });

  it("knows a folder of its own", () => {
    expect(isAccountFolder(home, nodePath.join(accountsRoot(home), "x"))).toBe(true);
    expect(isAccountFolder(home, nodePath.join(accountsRoot(home), "x", "y"))).toBe(false);
    expect(isAccountFolder(home, nodePath.join(accountsRoot(home), "..", "x"))).toBe(false);
    expect(isAccountFolder(home, accountsRoot(home))).toBe(false);
  });
});
