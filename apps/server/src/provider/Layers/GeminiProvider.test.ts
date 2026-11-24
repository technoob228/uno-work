import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { GeminiSettings } from "@t3tools/contracts";
import { GEMINI_ANTIGRAVITY_DETECTED_MESSAGE } from "@t3tools/shared/agentVersions";

import {
  buildGeminiModels,
  checkGeminiProviderStatus,
  detectAntigravityApp,
  geminiModelLabel,
} from "./GeminiProvider.ts";

const settings = Schema.decodeSync(GeminiSettings)({});

describe("Gemini CLI models", () => {
  it("Auto first, the CLI's lineup until a session reports its own", () => {
    const fallback = buildGeminiModels(settings, []);
    expect(fallback[0]).toMatchObject({ slug: "auto", name: "Auto", isDefault: true });
    expect(fallback.map((model) => model.slug)).toContain("gemini-3-flash-preview");
    const discovered = buildGeminiModels({ customModels: ["my-tuned"] }, [
      { id: "auto", name: "Auto" },
      { id: "gemini-2.5-pro", name: "gemini-2.5-pro" },
    ]);
    expect(discovered.map((model) => [model.slug, model.name, model.isCustom])).toEqual([
      ["auto", "Auto", false],
      ["gemini-2.5-pro", "Gemini 2.5 Pro", false],
      ["my-tuned", "my-tuned", true],
    ]);
    expect(geminiModelLabel("gemini-3.5-flash-lite")).toBe("Gemini 3.5 Flash Lite");
    expect(geminiModelLabel("Gemini 3 Pro")).toBe("Gemini 3 Pro");
  });
});

/** A `gemini` that only answers --version, and a ~/.gemini. */
const machine = (settingsJson: unknown, extra: Record<string, string> = {}) =>
  Effect.promise(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uno-gemini-status-"));
    await mkdir(path.join(root, "bin"));
    await writeFile(path.join(root, "bin", "gemini"), "#!/bin/sh\necho 0.70.0\n");
    await chmod(path.join(root, "bin", "gemini"), 0o755);
    await mkdir(path.join(root, ".gemini"));
    await writeFile(path.join(root, ".gemini", "settings.json"), JSON.stringify(settingsJson));
    for (const [name, text] of Object.entries(extra)) {
      await writeFile(path.join(root, ".gemini", name), text);
    }
    return { PATH: `${path.join(root, "bin")}:/usr/bin:/bin`, GEMINI_CLI_HOME: root };
  });

const check = (environment: NodeJS.ProcessEnv, config = settings) =>
  checkGeminiProviderStatus({ config, environment, discoveredModels: () => [] }).pipe(
    Effect.provide(NodeServices.layer),
  );

describe("Gemini CLI status", () => {
  it.effect("signed in to Google: ready, with the account", () =>
    Effect.gen(function* () {
      const env = yield* machine(
        { security: { auth: { selectedType: "oauth-personal" } } },
        { "google_accounts.json": JSON.stringify({ active: "me@example.com" }) },
      );
      const snapshot = yield* check(env);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.70.0");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "oauth-personal",
        label: "Google account",
        email: "me@example.com",
      });
    }),
  );

  it.effect("installed, nothing selected and no key: needs a sign-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* check(yield* machine({}));
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toMatch(/not signed in/);
    }),
  );

  it.effect("an API key in the instance environment: ready", () =>
    Effect.gen(function* () {
      const env = { ...(yield* machine({})), GEMINI_API_KEY: "AIzaTEST" };
      const snapshot = yield* check(env);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toMatchObject({ status: "authenticated", type: "gemini-api-key" });
    }),
  );

  it.effect("not installed but Antigravity is on the Mac: points to Antigravity (T64)", () =>
    Effect.gen(function* () {
      const config = { ...settings, binaryPath: "/nonexistent/gemini" };
      const withApp = yield* checkGeminiProviderStatus({
        config,
        environment: { PATH: "/nonexistent" },
        discoveredModels: () => [],
        detectAntigravity: async () => true,
      }).pipe(Effect.provide(NodeServices.layer));
      expect(withApp.installed).toBe(false);
      expect(withApp.message).toBe(GEMINI_ANTIGRAVITY_DETECTED_MESSAGE);
      const without = yield* checkGeminiProviderStatus({
        config,
        environment: { PATH: "/nonexistent" },
        discoveredModels: () => [],
        detectAntigravity: async () => false,
      }).pipe(Effect.provide(NodeServices.layer));
      expect(without.message).toMatch(/not installed/);
    }),
  );

  it("finds Antigravity.app only on a Mac", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "uno-antigravity-"));
    expect(await detectAntigravityApp("darwin", home)).toBe(
      await import("node:fs/promises").then((fs) =>
        fs.access("/Applications/Antigravity.app").then(
          () => true,
          () => false,
        ),
      ),
    );
    await mkdir(path.join(home, "Applications", "Antigravity.app"), { recursive: true });
    expect(await detectAntigravityApp("darwin", home)).toBe(true);
    expect(await detectAntigravityApp("linux", home)).toBe(false);
  });

  it.effect("not on PATH: not installed (Install is offered)", () =>
    Effect.gen(function* () {
      const snapshot = yield* check({ PATH: "/nonexistent", GEMINI_CLI_HOME: os.tmpdir() });
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toMatch(/not installed/);
    }),
  );
});
