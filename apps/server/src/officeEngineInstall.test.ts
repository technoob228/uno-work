import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OFFICE_ENGINE_API_SCRIPT } from "./officeEngine.ts";
import { installOfficeEngine, isOfficeEngineInstalledAt } from "./officeEngineInstall.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "office-install-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makePackage(): { bytes: Buffer; sha256: string } {
  const src = tempDir();
  const api = nodePath.join(src, OFFICE_ENGINE_API_SCRIPT);
  fs.mkdirSync(nodePath.dirname(api), { recursive: true });
  fs.writeFileSync(api, "window.DocsAPI = {};");
  fs.writeFileSync(nodePath.join(src, "LICENSE.txt"), "AGPL");
  const archive = nodePath.join(tempDir(), "engine.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", src, "vendor", "LICENSE.txt"]);
  const bytes = fs.readFileSync(archive);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const fetchBytes = (bytes: Buffer) =>
  (async () => new Response(new Uint8Array(bytes), { status: 200 })) as unknown as typeof fetch;

describe("installOfficeEngine", () => {
  it("installs a package whose checksum matches, replacing an old one", async () => {
    const pkg = makePackage();
    const engineDir = nodePath.join(tempDir(), "office-engine");
    fs.mkdirSync(engineDir);
    fs.writeFileSync(nodePath.join(engineDir, "stale.txt"), "old");
    await installOfficeEngine(
      engineDir,
      { url: "https://example.invalid/e.tgz", sha256: pkg.sha256 },
      fetchBytes(pkg.bytes),
    );
    expect(await isOfficeEngineInstalledAt(engineDir)).toBe(true);
    expect(fs.existsSync(nodePath.join(engineDir, "stale.txt"))).toBe(false);
    expect(fs.readdirSync(nodePath.dirname(engineDir))).toEqual(["office-engine"]);
  });

  it("refuses a download with the wrong checksum and leaves nothing behind", async () => {
    const pkg = makePackage();
    const engineDir = nodePath.join(tempDir(), "office-engine");
    await expect(
      installOfficeEngine(
        engineDir,
        { url: "https://example.invalid/e.tgz", sha256: "0".repeat(64) },
        fetchBytes(pkg.bytes),
      ),
    ).rejects.toThrow(/checksum/);
    expect(await isOfficeEngineInstalledAt(engineDir)).toBe(false);
    expect(fs.readdirSync(nodePath.dirname(engineDir))).toEqual([]);
  });
});
