import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  decideInstall,
  fetchLatestUnoCodeReleaseVersion,
  releaseTagToNumericVersion,
  sha256File,
  UNO_CODE_ASSET_SHA256,
  UNO_CODE_RELEASE_TAG,
  UnoCodeInstallError,
  verifyArchiveChecksum,
} from "./unoCodeInstaller.ts";

describe("pinned release checksums", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) FS.rmSync(dir, { recursive: true, force: true });
  });
  const tempFile = (contents: string) => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "uno-code-installer-"));
    dirs.push(dir);
    const file = Path.join(dir, "uno-code-linux-x64.tar.gz");
    FS.writeFileSync(file, contents);
    return file;
  };
  const sha256 = (contents: string) => Crypto.createHash("sha256").update(contents).digest("hex");

  it("pins a tag and a well-formed SHA-256 for every published asset", () => {
    expect(UNO_CODE_RELEASE_TAG).toMatch(/^uno-v\d+\.\d+\.\d+/);
    expect(Object.keys(UNO_CODE_ASSET_SHA256).toSorted()).toEqual([
      "uno-code-darwin-arm64.zip",
      "uno-code-linux-arm64.tar.gz",
      "uno-code-linux-x64.tar.gz",
      "uno-code-windows-x64.zip",
    ]);
    for (const hash of Object.values(UNO_CODE_ASSET_SHA256)) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("the upgrade target is the pinned release, not GitHub's latest", async () => {
    await expect(fetchLatestUnoCodeReleaseVersion()).resolves.toBe(
      releaseTagToNumericVersion(UNO_CODE_RELEASE_TAG),
    );
  });

  it("hashes a file and accepts a matching checksum", async () => {
    const file = tempFile("uno-code archive");
    await expect(sha256File(file)).resolves.toBe(sha256("uno-code archive"));
    await expect(
      verifyArchiveChecksum(file, sha256("uno-code archive").toUpperCase()),
    ).resolves.toBeUndefined();
  });

  it("fails closed on a tampered archive", async () => {
    const file = tempFile("tampered archive");
    const error = await verifyArchiveChecksum(file, sha256("uno-code archive")).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(UnoCodeInstallError);
    expect((error as UnoCodeInstallError).code).toBe("checksum-mismatch");
    await expect(verifyArchiveChecksum(file, "")).rejects.toBeInstanceOf(UnoCodeInstallError);
  });
});

describe("decideInstall", () => {
  it("installs when the binary is missing", () => {
    const decision = decideInstall({ exists: false, installedVersionRaw: null });
    expect(decision.install).toBe(true);
    expect(decision.reason).toBe("missing");
  });

  it("upgrades when the installed version is older than the target", () => {
    const decision = decideInstall({
      exists: true,
      installedVersionRaw: "1.14.40",
      targetVersion: "1.14.48",
    });
    expect(decision.install).toBe(true);
    expect(decision.reason).toBe("outdated");
    expect(decision.installedVersion).toBe("1.14.40");
    expect(decision.targetVersion).toBe("1.14.48");
  });

  it("does nothing when the installed version meets the target", () => {
    const decision = decideInstall({
      exists: true,
      installedVersionRaw: "1.14.48",
      targetVersion: "1.14.48",
    });
    expect(decision.install).toBe(false);
    expect(decision.reason).toBe("up-to-date");
  });

  it("treats a dev prerelease build as the same numeric version as the release", () => {
    // `1.14.48-uno.dev` shares the numeric core `1.14.48` with the published
    // `1.14.48-uno.1`, so it must NOT be flagged for reinstall.
    const decision = decideInstall({
      exists: true,
      installedVersionRaw: "1.14.48-uno.dev",
      targetVersion: "1.14.48-uno.1",
    });
    expect(decision.install).toBe(false);
    expect(decision.reason).toBe("up-to-date");
  });

  it("reinstalls when the binary cannot report a parseable version", () => {
    const decision = decideInstall({
      exists: true,
      installedVersionRaw: "garbage output",
      targetVersion: "1.14.48",
    });
    expect(decision.install).toBe(true);
    expect(decision.reason).toBe("outdated");
  });

  it("ignores prerelease suffixes when comparing newer installs", () => {
    const decision = decideInstall({
      exists: true,
      installedVersionRaw: "1.15.0-uno.3",
      targetVersion: "1.14.48",
    });
    expect(decision.install).toBe(false);
    expect(decision.reason).toBe("up-to-date");
  });
});

describe("releaseTagToNumericVersion", () => {
  it("extracts the numeric core from a release tag", () => {
    expect(releaseTagToNumericVersion("uno-v1.14.48-uno.1")).toBe("1.14.48");
  });

  it("returns null for a tag without a numeric version", () => {
    expect(releaseTagToNumericVersion("nightly")).toBeNull();
  });
});
