/**
 * `~/.uno/docs/` — the custom harness contract (docs/custom-harness.md) and
 * the minimal ACP example, written by the daemon at start so any agent on
 * the machine can read how to plug an agent into Uno Work, and the Settings
 * screen can point at a real path.
 *
 * @module provider/customHarness/harnessGuide
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { HARNESS_GUIDE_BUNDLE } from "./harnessGuide.generated.ts";

export function resolveHarnessDocsDir(home = os.homedir()): string {
  return path.join(home, ".uno", "docs");
}

export function resolveHarnessGuidePath(home = os.homedir()): string {
  return path.join(resolveHarnessDocsDir(home), "custom-harness.md");
}

export function resolveEchoHarnessExamplePath(home = os.homedir()): string {
  return path.join(resolveHarnessDocsDir(home), "examples", "acp-echo-harness.mjs");
}

export function harnessGuideFiles(home = os.homedir()): ReadonlyArray<readonly [string, string]> {
  return [
    [resolveHarnessGuidePath(home), HARNESS_GUIDE_BUNDLE.guide],
    [resolveEchoHarnessExamplePath(home), HARNESS_GUIDE_BUNDLE.echoHarness],
  ];
}

/** Write (or refresh) the guide files; unchanged files are left alone. */
export async function installHarnessGuide(home = os.homedir()): Promise<void> {
  for (const [file, body] of harnessGuideFiles(home)) {
    const current = await readFile(file, "utf8").catch(() => null);
    if (current === body) continue;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, { mode: file.endsWith(".mjs") ? 0o755 : 0o644 });
  }
}
