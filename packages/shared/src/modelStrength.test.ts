import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { fallbackListedModel, isWeakModel, strongestReadySelection } from "./modelStrength.ts";

const models = (slugs: ReadonlyArray<string>) => slugs.map((slug) => ({ slug }));

const provider = (
  driver: string,
  slugs: ReadonlyArray<string>,
  patch: Partial<Record<string, unknown>> = {},
): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(driver),
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-13T00:00:00.000Z",
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...patch,
  }) as unknown as ServerProvider;

const ready = () => true;

const meta = (unoGroup: string, tier: string) => ({ metadata: { unoGroup, tier } });

describe("isWeakModel", () => {
  it("small / fast models", () => {
    for (const slug of [
      "gpt-5.6-luna",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
      "uno/uno/fast",
      "claude-haiku-4-5",
      "z-ai/glm-5.3-flash",
    ]) {
      expect(isWeakModel(slug)).toBe(true);
    }
    for (const slug of ["gpt-5.6-terra", "gpt-5.6-sol", "claude-opus-5-5", "uno/uno/smart"]) {
      expect(isWeakModel(slug)).toBe(false);
    }
  });
});

describe("fallbackListedModel", () => {
  it("never the first model blindly (2709: Luna listed first)", () => {
    expect(fallbackListedModel("codex", models(["gpt-5.6-luna", "gpt-5.6-sol"]))).toBe(
      "gpt-5.6-sol",
    );
    expect(fallbackListedModel("codex", models(["gpt-5.6-luna", "gpt-5.4-mini"]))).toBeNull();
  });

  it("a harness of unknown strength keeps its first model", () => {
    expect(fallbackListedModel("opencode", models(["opencode/grok-code-fast"]))).toBe(
      "opencode/grok-code-fast",
    );
  });
});

describe("strongestReadySelection", () => {
  const claude = provider("claudeAgent", [
    "claude-sonnet-5",
    "claude-opus-5-5",
    "claude-haiku-4-5",
  ]);
  const codex = provider("codex", ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5"]);

  it("Claude Opus 5.5 first", () => {
    expect(strongestReadySelection([codex, claude], ready)).toEqual({
      tier: "claude",
      selection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    });
  });

  it("Claude Opus 5 (no minor in the slug) still counts as Opus", () => {
    const plain = provider("claudeAgent", ["claude-sonnet-5", "claude-opus-5"]);
    expect(strongestReadySelection([codex, plain], ready)).toEqual({
      tier: "claude",
      selection: { instanceId: "claudeAgent", model: "claude-opus-5" },
    });
  });

  it("no Claude ready: Codex's strongest, never Luna", () => {
    expect(
      strongestReadySelection([codex, claude], (entry) => entry.driver !== "claudeAgent"),
    ).toEqual({ tier: "codex", selection: { instanceId: "codex", model: "gpt-5.6-terra" } });
    expect(
      strongestReadySelection([provider("codex", ["gpt-5.6-luna", "gpt-5.5"])], ready)?.selection
        .model,
    ).toBe("gpt-5.5");
  });

  it("a harness that didn't confirm a sign-in is not 'their plan' (12.11)", () => {
    const noAccount = provider("codex", ["gpt-5.6-terra"], { auth: { status: "unknown" } });
    expect(strongestReadySelection([noAccount], ready)).toBeNull();
    const claudeUnknown = provider("claudeAgent", ["claude-opus-5-5"], {
      auth: { status: "unknown" },
    });
    expect(strongestReadySelection([claudeUnknown, codex], ready)?.tier).toBe("codex");
  });

  it("14.11: the model the CLI recommends wins over the built-in order", () => {
    const fable = provider("claudeAgent", ["claude-opus-5-5", "claude-fable-5-2"], {
      models: [
        { slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: null },
        {
          slug: "claude-fable-5-2",
          name: "Fable 5.2",
          isCustom: false,
          capabilities: null,
          isDefault: true,
        },
      ],
    });
    expect(strongestReadySelection([fable], ready)?.selection.model).toBe("claude-fable-5-2");
    const codexSol = provider("codex", [], {
      models: [
        { slug: "gpt-5.6-terra", name: "Terra", isCustom: false, capabilities: null },
        { slug: "gpt-5.7", name: "GPT-5.7", isCustom: false, capabilities: null, isDefault: true },
      ],
    });
    expect(strongestReadySelection([codexSol], ready)?.selection.model).toBe("gpt-5.7");
    // A small model as the CLI's default is not taken for complex work.
    const lunaDefault = provider("codex", [], {
      models: [
        {
          slug: "gpt-5.6-luna",
          name: "Luna",
          isCustom: false,
          capabilities: null,
          isDefault: true,
        },
        { slug: "gpt-5.6-terra", name: "Terra", isCustom: false, capabilities: null },
      ],
    });
    expect(strongestReadySelection([lunaDefault], ready)?.selection.model).toBe("gpt-5.6-terra");
  });

  it("Codex with only small models is skipped", () => {
    expect(strongestReadySelection([provider("codex", ["gpt-5.6-luna"])], ready)).toBeNull();
  });

  it("Claude on Uno credits ranks as Uno AI premium, after Codex", () => {
    const claudeOnUno = provider("claudeAgent", ["claude-opus-5-5"], {
      auth: { status: "authenticated", type: "unoAi" },
    });
    expect(strongestReadySelection([claudeOnUno, codex], ready)?.tier).toBe("codex");
    expect(strongestReadySelection([claudeOnUno], ready)).toEqual({
      tier: "uno-premium",
      selection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    });
  });

  it("Uno Code: the newest premium Opus, never Smart / Fast", () => {
    const uno = {
      ...provider("uno", []),
      models: [
        {
          slug: "uno/uno/smart",
          name: "Smart",
          isCustom: false,
          capabilities: meta("included", "strong"),
        },
        {
          slug: "uno/openai/gpt-5.5",
          name: "GPT",
          isCustom: false,
          capabilities: meta("premium", "frontier"),
        },
        {
          slug: "uno/anthropic/claude-opus-4.7",
          name: "Opus 4.7",
          isCustom: false,
          capabilities: meta("premium", "frontier"),
        },
        {
          slug: "uno/anthropic/claude-opus-4.8",
          name: "Opus 4.8",
          isCustom: false,
          capabilities: meta("premium", "frontier"),
        },
      ],
    } as unknown as ServerProvider;
    expect(strongestReadySelection([uno], ready)).toEqual({
      tier: "uno-premium",
      selection: { instanceId: "uno", model: "uno/anthropic/claude-opus-4.8" },
    });
  });

  it("nothing ready: null (the project's default decides)", () => {
    expect(strongestReadySelection([claude, codex], () => false)).toBeNull();
  });
});
