import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { GrokSettings } from "@t3tools/contracts";

import { buildGrokModels, checkGrokProviderStatus, grokModelLabel } from "./GrokProvider.ts";

const settings = Schema.decodeSync(GrokSettings)({});

describe("Grok models", () => {
  it("grok-4.6 first and default, the CLI's lineup until a session reports its own", () => {
    const fallback = buildGrokModels(settings, []);
    expect(fallback.map((model) => [model.slug, model.name, model.isDefault ?? false])).toEqual([
      ["grok-4.6", "Grok 4.6", true],
      ["grok-4.5", "Grok 4.5", false],
    ]);
    const discovered = buildGrokModels({ customModels: ["grok-code-fast-1"] }, [
      { id: "grok-4.6", name: "grok-4.6" },
      { id: "grok-5", name: "grok-5" },
    ]);
    expect(discovered.map((model) => [model.slug, model.name, model.isCustom])).toEqual([
      ["grok-4.6", "Grok 4.6", false],
      ["grok-5", "Grok 5", false],
      ["grok-code-fast-1", "grok-code-fast-1", true],
    ]);
    expect(grokModelLabel("grok-code-fast-1")).toBe("Grok Code Fast 1");
    expect(grokModelLabel("Grok 4.6")).toBe("Grok 4.6");
  });
});

/** A `grok` that only answers --version, and a GROK_HOME. */
const machine = (authJson?: string) =>
  Effect.promise(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uno-grok-status-"));
    await mkdir(path.join(root, "bin"));
    await writeFile(path.join(root, "bin", "grok"), "#!/bin/sh\necho 1.0.92\n");
    await chmod(path.join(root, "bin", "grok"), 0o755);
    const home = path.join(root, ".grok");
    await mkdir(home);
    if (authJson !== undefined) await writeFile(path.join(home, "auth.json"), authJson);
    return { PATH: `${path.join(root, "bin")}:/usr/bin:/bin`, GROK_HOME: home };
  });

const check = (environment: NodeJS.ProcessEnv, config = settings) =>
  checkGrokProviderStatus({ config, environment, discoveredModels: () => [] }).pipe(
    Effect.provide(NodeServices.layer),
  );

describe("Grok status", () => {
  it.effect("signed in to xAI: ready", () =>
    Effect.gen(function* () {
      const env = yield* machine(
        JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "token" } }),
      );
      const snapshot = yield* check(env);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("1.0.92");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "xai-account",
        label: "xAI account",
      });
    }),
  );

  it.effect("installed, no sign-in and no key: needs a sign-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* check(yield* machine("{}"));
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toMatch(/not signed in/);
    }),
  );

  it.effect("an API key in the instance environment: ready, and the key is what a chat uses", () =>
    Effect.gen(function* () {
      const env = { ...(yield* machine()), XAI_API_KEY: "xai-TEST" };
      const snapshot = yield* check(env);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toMatchObject({ status: "authenticated", type: "xai-api-key" });
    }),
  );

  it.effect("not on PATH: not installed (Install is offered)", () =>
    Effect.gen(function* () {
      const snapshot = yield* check({ PATH: "/nonexistent", GROK_HOME: os.tmpdir() });
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toMatch(/not installed/);
    }),
  );
});
