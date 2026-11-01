import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTIVITY_KEEP_ENTRIES, makeActivityLog } from "./activityLog.ts";
import { maskSecrets, summarize, SUMMARY_MAX_CHARS } from "./activitySummary.ts";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), "my-computer-activity-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("masking", () => {
  it.each([
    ["API_KEY=abc123", "API_KEY=[redacted]"],
    ["export GITHUB_TOKEN=abc123 && ls", "export GITHUB_TOKEN=[redacted] && ls"],
    ['DB_PASSWORD="two words" ./run', "DB_PASSWORD=[redacted] ./run"],
    ["my_secret='x y'", "my_secret=[redacted]"],
    ["curl --api-key=abc123 x", "curl --api-key=[redacted] x"],
    ["mysql --password hunter2 -u me", "mysql --password [redacted] -u me"],
    ["curl -H 'Authorization: Bearer abc.def-1'", "curl -H 'Authorization: Bearer [redacted]'"],
    ["curl -H 'Authorization: Basic dXNlcjpwYXNz'", "curl -H 'Authorization: Basic [redacted]'"],
    ["Bearer abcdef", "Bearer [redacted]"],
    [
      "git clone https://me:hunter2@github.com/a/b",
      "git clone https://me:[redacted]@github.com/a/b",
    ],
  ])("%s", (input, expected) => {
    expect(maskSecrets(input)).toBe(expected);
  });

  it.each([
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnopqrst",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-1234567890-abcdefghij",
    "glpat-abcdefghijklmnopqrst",
    "sk-abcdefghijklmnopqrstuvwxyz",
    "uno_cmp_abcdefghijklmnopqrstuvwxyz012345",
    "uno_usr_abcdefghijklmnopqrstuvwxyz012345",
    "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2",
  ])("a key on its own: %s", (secret) => {
    const masked = maskSecrets(`deploy ${secret} now`);
    expect(masked).not.toContain(secret);
    expect(masked).toContain("[redacted]");
  });

  it("leaves ordinary commands alone", () => {
    for (const command of [
      "ls -la ~/projects",
      "git log --oneline -5",
      "npm run build && npm test",
      "cat /etc/hosts | grep local",
      "keychain list",
    ]) {
      expect(maskSecrets(command)).toBe(command);
    }
  });
});

describe("the summary line", () => {
  it("is one line, clipped, and masks before it clips", () => {
    expect(summarize("  a\n\n  b\tc ")).toBe("a b c");
    const line = summarize(`${"x ".repeat(95)}TOKEN=abcdefghijklmnopqrstuvwxyz`);
    expect(line.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(line).not.toContain("abcdefgh");
    expect(summarize("a".repeat(300), 10)).toBe(`${"a".repeat(9)}…`);
  });
});

describe("the journal on disk", () => {
  it("newest first, up to the limit, and it survives a restart", async () => {
    const log = makeActivityLog({ stateDir });
    for (const summary of ["one", "two", "three"]) {
      await log.record("c1", { kind: "run", summary });
    }
    const again = makeActivityLog({ stateDir });
    expect((await again.read("c1", 2)).map((entry) => entry.summary)).toEqual(["three", "two"]);
  });

  it("a computer's id can't climb out of the folder", async () => {
    const log = makeActivityLog({ stateDir });
    await log.record("../../evil", { kind: "run", summary: "x" });
    expect(readdirSync(stateDir)).toEqual(["my-computer"]);
    expect((await log.read("../../evil")).map((entry) => entry.summary)).toEqual(["x"]);
  });

  it("many writers at once lose nothing", async () => {
    const log = makeActivityLog({ stateDir });
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        log.record("c1", { kind: "list", summary: `n${index}` }),
      ),
    );
    expect(await log.read("c1", 100)).toHaveLength(40);
  });

  it("skips a damaged line instead of failing", async () => {
    const log = makeActivityLog({ stateDir });
    await log.record("c1", { kind: "run", summary: "good" });
    const file = path.join(stateDir, "my-computer", "c1.activity.jsonl");
    appendFileSync(file, '{"half\n{"at":"x","kind":"nope","summary":"y"}\n');
    expect((await log.read("c1")).map((entry) => entry.summary)).toEqual(["good"]);
  });

  it("keeps the newest lines when it grows, with its 0600 mode", async () => {
    const log = makeActivityLog({ stateDir });
    // Words, not one long blob: that would be masked as a key.
    const long = "word ".repeat(38);
    for (let index = 0; index < 1_400; index += 1) {
      await log.record("c1", { kind: "run", summary: `${long}${index}` });
    }
    const entries = await log.read("c1", 5_000);
    const file = path.join(stateDir, "my-computer", "c1.activity.jsonl");
    expect(entries.length).toBeLessThanOrEqual(ACTIVITY_KEEP_ENTRIES + 1_000);
    expect(entries[0]!.summary.endsWith("1399")).toBe(true);
    expect(statSync(file).size).toBeLessThan(512 * 1024);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").split("\n").length).toBeLessThan(1_500);
  });
});
