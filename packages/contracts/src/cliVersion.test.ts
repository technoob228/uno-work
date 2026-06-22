import { assert, describe, it } from "@effect/vitest";

import {
  UNO_CODE_MINIMUM_VERSION,
  compareCliVersions,
  extractNumericCliVersion,
  normalizeCliVersion,
} from "./cliVersion.ts";

describe("cliVersion", () => {
  it("normalizes versions with a missing patch segment", () => {
    assert.strictEqual(normalizeCliVersion("2.1"), "2.1.0");
  });

  it("compares prerelease versions before stable versions", () => {
    assert.isTrue(compareCliVersions("2.1.111-beta.1", "2.1.111") < 0);
  });

  it("rejects malformed numeric segments", () => {
    assert.isTrue(compareCliVersions("1.2.3abc", "1.2.10") > 0);
  });

  describe("extractNumericCliVersion", () => {
    it("strips a prerelease suffix to the numeric core", () => {
      assert.strictEqual(extractNumericCliVersion("1.14.48-uno.1"), "1.14.48");
    });

    it("extracts from noisy CLI output", () => {
      assert.strictEqual(extractNumericCliVersion("opencode 1.14.48 (abc1234)"), "1.14.48");
    });

    it("returns null for non-version output", () => {
      assert.strictEqual(extractNumericCliVersion("no version here"), null);
    });

    it("treats the dev fork build as the same numeric version as the release", () => {
      // `1.14.48-uno.dev` and the published `1.14.48-uno.1` share the numeric
      // core `1.14.48`, so the installer must not consider one newer than the
      // other when gating on the numeric version.
      assert.strictEqual(
        extractNumericCliVersion("1.14.48-uno.dev"),
        extractNumericCliVersion("1.14.48-uno.1"),
      );
    });
  });

  it("pins the minimum uno-code version", () => {
    assert.strictEqual(UNO_CODE_MINIMUM_VERSION, "1.14.48");
  });
});
