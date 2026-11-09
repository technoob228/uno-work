/**
 * The Claude plugin install (09.11): pinned repository + commit instead of
 * the catalog name Hermes 0.21.5 stopped resolving. Real child processes, a
 * fake `hermes` that behaves like 0.21.5 with a catalog over 2 MiB.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  HERMES_CLAUDE_PLUGIN_SHA,
  HERMES_CLAUDE_PLUGIN_VERSION,
} from "../provider/setup/harnessInstallCommands.ts";
import {
  claudePluginInstallArgs,
  claudePluginInstallError,
  HERMES_CLAUDE_PLUGIN_SOURCE,
  installClaudePlugin,
} from "./claudePluginInstall.ts";

const dir = mkdtempSync(join(tmpdir(), "claude-plugin-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What the person may never read: Hermes' catalog/URL vocabulary. */
const HERMES_JARGON = /git url|catalog|owner\/repo|hermes said/i;

/** Hermes 0.21.5's own words for the bare name once the live catalog is over 2 MiB. */
const CATALOG_REFUSAL =
  "Error: 'claude-subscription-directsdk' is not in the Hermes plugin catalog and \nis not a Git URL or owner/repo shorthand. Browse entries with `hermes plugins \nsearch`.\n";

const refusalFile = join(dir, "catalog-refusal.txt");
writeFileSync(refusalFile, CATALOG_REFUSAL);

function fakeHermes(name: string, body: string): string {
  const binary = join(dir, name);
  writeFileSync(binary, `#!/bin/sh\n${body}\n`);
  chmodSync(binary, 0o755);
  return binary;
}

/** Installs only the pinned source at the pinned commit, refuses the bare name. */
const hermes0215 = fakeHermes(
  "hermes-0.21.5",
  [
    'echo "$@" > "$HERMES_HOME/args"',
    'echo "$GIT_TERMINAL_PROMPT" > "$HERMES_HOME/git-prompt"',
    `if [ "$3" = "${HERMES_CLAUDE_PLUGIN_SOURCE}" ] && [ "$4" = "--ref" ] && [ "$5" = "${HERMES_CLAUDE_PLUGIN_SHA}" ]; then`,
    '  mkdir -p "$HERMES_HOME/plugins/claude-subscription-directsdk-experimental"',
    '  echo "name: claude-subscription-directsdk-experimental" > "$HERMES_HOME/plugins/claude-subscription-directsdk-experimental/plugin.yaml"',
    "  echo 'Warning: custom (unreviewed) source'",
    "  exit 0",
    "fi",
    `cat '${refusalFile}' >&2`,
    "exit 1",
  ].join("\n"),
);

function sharedHome(name: string): string {
  return mkdtempSync(join(dir, `${name}-`));
}

function install(binary: string, home: string, timeoutMs = 10_000) {
  return installClaudePlugin({
    binary,
    hermesVersion: "0.21.5",
    sharedHome: home,
    env: { PATH: process.env.PATH, HERMES_HOME: home },
    cwd: dir,
    timeoutMs,
  });
}

describe("claudePluginInstallArgs", () => {
  it("installs the pinned commit from the plugin's repository, not by catalog name", () => {
    expect(claudePluginInstallArgs("0.21.5")).toEqual([
      "plugins",
      "install",
      "https://github.com/NousResearch/hermes-official-plugins.git#claude-subscription-directsdk",
      "--ref",
      HERMES_CLAUDE_PLUGIN_SHA,
      "--no-enable",
    ]);
    // Hermes takes only a full 40-character commit for --ref.
    expect(HERMES_CLAUDE_PLUGIN_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(HERMES_CLAUDE_PLUGIN_VERSION).toBe("0.3.5");
  });

  it("answers the dependency question only on Hermes that has the flag", () => {
    expect(claudePluginInstallArgs("0.21.5")).not.toContain("--yes-deps");
    expect(claudePluginInstallArgs(null)).not.toContain("--yes-deps");
    const args = claudePluginInstallArgs("0.22.1");
    expect(args.slice(-2)).toEqual(["--yes-deps", "--no-enable"]);
    expect(args).not.toContain("claude-subscription-directsdk");
  });
});

describe("installClaudePlugin", () => {
  it("lands the plugin on a Hermes that no longer resolves the catalog name", async () => {
    const home = sharedHome("ok");
    const result = await install(hermes0215, home);
    expect(result).toMatchObject({ installed: true, detail: null });
    expect(readFileSync(join(home, "args"), "utf8").trim()).toBe(
      claudePluginInstallArgs("0.21.5").join(" "),
    );
    // git never waits for a login prompt nobody can answer.
    expect(readFileSync(join(home, "git-prompt"), "utf8").trim()).toBe("0");
  });

  it("tells the person in plain words when it didn't land — Hermes' lines only in the log", async () => {
    const refusing = fakeHermes("hermes-refuses", `cat '${refusalFile}' >&2\nexit 1`);
    const result = await install(refusing, sharedHome("refused"));
    expect(result.installed).toBe(false);
    expect(result.output).toContain("not a Git URL");
    expect(result.detail).toBe(
      "Couldn't connect Uno to your Claude plan on this computer. Try again in a minute, or keep Uno on Uno AI.",
    );
    expect(result.detail).not.toMatch(HERMES_JARGON);
  });

  it("trusts the plugin folder, not the exit code", async () => {
    const quiet = fakeHermes("hermes-exit0-nothing", "exit 0");
    const result = await install(quiet, sharedHome("quiet"));
    expect(result.installed).toBe(false);
  });

  it("stops a hung install at its timeout", async () => {
    const hung = fakeHermes("hermes-hangs", "exec sleep 30");
    const result = await install(hung, sharedHome("hung"), 300);
    expect(result.installed).toBe(false);
    expect(result.detail).toContain("the download took too long");
  });

  it("says so when Hermes isn't there at all", async () => {
    const result = await install(join(dir, "no-such-hermes"), sharedHome("missing"));
    expect(result.installed).toBe(false);
    expect(result.detail).toContain("the assistant's engine didn't start");
  });
});

describe("claudePluginInstallError", () => {
  const cases: ReadonlyArray<readonly [string, string, string | null]> = [
    ["the 0.21.5 catalog refusal", CATALOG_REFUSAL, null],
    [
      "no network",
      "Error: Git clone failed:\nfatal: unable to access 'https://github.com/NousResearch/hermes-official-plugins.git/': Could not resolve host: github.com",
      "GitHub didn't answer",
    ],
    ["no git", "Error: git is not installed or not in PATH.", "git is missing on this computer"],
    [
      "a slow clone",
      "Error: Git clone timed out after 120 seconds. On a slow connection, raise plugins.clone_timeout_seconds in config.yaml.",
      "the download took too long",
    ],
    [
      "a scan block",
      "Error: Security scan blocked plugin install: caution\n… (Scanning can be configured via plugins.scan_on_install in config.yaml.)",
      null,
    ],
  ];

  it.each(cases)("%s", (_label, output, reason) => {
    const detail = claudePluginInstallError({ output, timedOut: false });
    expect(detail).not.toMatch(HERMES_JARGON);
    expect(detail.startsWith("Couldn't connect Uno to your Claude plan on this computer")).toBe(
      true,
    );
    if (reason === null) expect(detail).not.toContain(":");
    else expect(detail).toContain(`: ${reason}.`);
  });
});
