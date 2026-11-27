/**
 * Uno Work sends usage events to the Uno console only (TELEMETRY.md). Upstream
 * T3 Code sends them to T3's own analytics and reads other tools' credential
 * files to tell users apart; an upstream merge would bring that back silently.
 * This check fails the build when it does.
 *
 * What to do instead: send events through `AnalyticsService` (it goes to the
 * Uno console), and never read `~/.codex` or `~/.claude.json` for telemetry.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const THIS_FILE = path.resolve(import.meta.filename);

const SOURCE_ROOTS = ["apps/server/src", "apps/web/src", "apps/desktop/src", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "build"]);
const SOURCE_FILE = /\.(?:ts|tsx|mts|js|mjs)$/u;

// Assembled from parts so this file does not match itself.
const THIRD_PARTY_SINKS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a PostHog endpoint", new RegExp(["posthog", "\\.com"].join(""), "iu")],
  ["T3's ingest endpoint", new RegExp(["ingest", "\\.t3", "\\.codes"].join(""), "iu")],
  ["a PostHog project key", new RegExp(["\\bphc", "_[A-Za-z0-9]{20,}"].join(""), "u")],
];
const OTHER_TOOLS_FILES = new RegExp(
  [["\\.codex", "auth\\.json"].join("[\"'/,\\s]+"), ["\\.claude", "\\.json"].join("")].join("|"),
  "u",
);

function listSourceFiles(dir: string, out: Array<string>): Array<string> {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, out);
    else if (SOURCE_FILE.test(entry.name) && path.resolve(full) !== THIS_FILE) out.push(full);
  }
  return out;
}

const isTestFile = (file: string) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file);

describe("no telemetry to third parties", () => {
  const files = SOURCE_ROOTS.flatMap((root) => listSourceFiles(path.join(REPO_ROOT, root), []));

  it("finds the sources it guards", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no source sends usage data to PostHog or T3", () => {
    const hits: Array<string> = [];
    for (const file of files) {
      if (isTestFile(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const [what, pattern] of THIRD_PARTY_SINKS) {
        if (pattern.test(text)) hits.push(`${path.relative(REPO_ROOT, file)}: ${what}`);
      }
    }
    expect(hits, "send usage events through AnalyticsService (Uno console only)").toEqual([]);
  });

  it("telemetry does not read other tools' credential files", () => {
    const telemetryDir = path.join(REPO_ROOT, "apps/server/src/telemetry");
    const hits = listSourceFiles(telemetryDir, [])
      .filter((file) => OTHER_TOOLS_FILES.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(REPO_ROOT, file));
    expect(hits, "the install id is a random UUID; never read ~/.codex or ~/.claude.json").toEqual(
      [],
    );
  });
});
