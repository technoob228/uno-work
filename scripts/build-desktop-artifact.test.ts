import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option } from "effect";

import {
  createBuildConfig,
  resolveBuildOptions,
  resolveDesktopAppId,
  resolveDesktopArtifactName,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveMacSigningIdentity,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "Uno Work");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "Uno Work (Nightly)");
  });

  it("names Uno Work Stage as its own app, the release unchanged", () => {
    assert.equal(resolveDesktopProductName("0.0.139", "stage"), "Uno Work Stage");
    assert.equal(resolveDesktopProductName("0.0.139", "release"), "Uno Work");
    assert.equal(resolveDesktopAppId("stage"), "com.unotools.work.stage");
    assert.equal(resolveDesktopAppId(), "com.unotools.work");
    assert.equal(resolveDesktopArtifactName("stage"), "Uno-Work-Stage.${ext}");
    assert.equal(resolveDesktopArtifactName(), "Uno-Work.${ext}");
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.139", "stage"), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it.effect("takes the flavor from the flag, then T3CODE_DESKTOP_FLAVOR, else release", () =>
    Effect.gen(function* () {
      const input = {
        platform: Option.some("mac" as const),
        target: Option.none(),
        arch: Option.some("arm64" as const),
        buildVersion: Option.none(),
        outputDir: Option.none(),
        skipBuild: Option.none(),
        keepStage: Option.none(),
        signed: Option.none(),
        verbose: Option.none(),
        mockUpdates: Option.none(),
        mockUpdateServerPort: Option.none(),
      };
      const withEnv = (env: Record<string, string>) =>
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));
      assert.equal((yield* resolveBuildOptions(input).pipe(withEnv({}))).flavor, "release");
      assert.equal(
        (yield* resolveBuildOptions(input).pipe(withEnv({ T3CODE_DESKTOP_FLAVOR: "stage" })))
          .flavor,
        "stage",
      );
      assert.equal(
        (yield* resolveBuildOptions({ ...input, flavor: Option.some("stage" as const) }).pipe(
          withEnv({}),
        )).flavor,
        "stage",
      );
    }),
  );

  it.effect("never gives the stage an update feed, even in CI", () =>
    Effect.gen(function* () {
      const saved = process.env.GITHUB_REPOSITORY;
      process.env.GITHUB_REPOSITORY = "technoob228/uno-work";
      try {
        const release = yield* createBuildConfig("mac", "dmg", "0.0.139", false, false, undefined);
        const stage = yield* createBuildConfig(
          "mac",
          "dmg",
          "0.0.139",
          false,
          true,
          undefined,
          "stage",
        );
        assert.equal(release.appId, "com.unotools.work");
        assert.ok(Array.isArray(release.publish));
        assert.equal(stage.appId, "com.unotools.work.stage");
        assert.equal(stage.productName, "Uno Work Stage");
        assert.equal(stage.publish, undefined);
      } finally {
        if (saved === undefined) delete process.env.GITHUB_REPOSITORY;
        else process.env.GITHUB_REPOSITORY = saved;
      }
    }),
  );

  it("uses ad-hoc macOS signing while Apple signing is not configured", () => {
    assert.equal(resolveMacSigningIdentity(false), "-");
    assert.equal(resolveMacSigningIdentity(true), undefined);
  });

  it("switches desktop packaging icons to the nightly artwork for nightly versions", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_KEEP_STAGE: "true",
                T3CODE_DESKTOP_SIGNED: "true",
                T3CODE_DESKTOP_VERBOSE: "true",
                T3CODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );
});
