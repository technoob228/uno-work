import { CustomHarnessSettings } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildHarnessInstance,
  draftFromInstance,
  EMPTY_HARNESS_DRAFT,
  newHarnessInstanceId,
  parseModelsText,
} from "./customHarnessForm";

const draft = (patch: Partial<typeof EMPTY_HARNESS_DRAFT>) => ({
  ...EMPTY_HARNESS_DRAFT,
  name: "Gemini CLI",
  commandLine: "gemini --acp",
  ...patch,
});

describe("buildHarnessInstance", () => {
  it("builds an acp providerInstances entry with secrets marked sensitive", () => {
    const result = buildHarnessInstance(
      draft({
        icon: "✨",
        installLine: "npm install -g @google/gemini-cli",
        detectLine: "gemini --version",
        modelsText: "gemini-2.5-pro = Gemini 2.5 Pro\ngemini-2.5-flash",
        env: [
          { key: "a", name: "GEMINI_API_KEY", value: "sk-1", secret: true, redacted: false },
          { key: "b", name: "LOG", value: "warn", secret: false, redacted: false },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance).toMatchObject({
      driver: "acp",
      displayName: "Gemini CLI",
      enabled: true,
      environment: [
        { name: "GEMINI_API_KEY", value: "sk-1", sensitive: true },
        { name: "LOG", value: "warn", sensitive: false },
      ],
    });
    expect(result.config).toMatchObject({
      command: "gemini",
      args: ["--acp"],
      installCommand: ["npm", "install", "-g", "@google/gemini-cli"],
      detectCommand: ["gemini", "--version"],
      models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }, { id: "gemini-2.5-flash" }],
      icon: "✨",
    });
    // The result decodes as the driver config schema.
    expect(() => Schema.decodeUnknownSync(CustomHarnessSettings)(result.config)).not.toThrow();
  });

  it("keeps an unchanged stored secret redacted instead of blanking it", () => {
    const result = buildHarnessInstance(
      draft({ env: [{ key: "a", name: "KEY", value: "", secret: true, redacted: true }] }),
    );
    expect(result.ok && result.instance.environment).toEqual([
      { name: "KEY", value: "", sensitive: true, valueRedacted: true },
    ]);
  });

  it("reports per-field errors", () => {
    const result = buildHarnessInstance(
      draft({
        name: " ",
        commandLine: "curl https://x | sh",
        detectLine: "./check",
        env: [{ key: "a", name: "BAD-NAME", value: "", secret: false, redacted: false }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).toSorted()).toEqual([
      "commandLine",
      "detectLine",
      "env",
      "name",
    ]);
    expect(result.errors.commandLine).toMatch(/shell/);
  });

  it("requires an absolute fixed folder", () => {
    const result = buildHarnessInstance(
      draft({ workingDirectory: "custom", customDirectory: "agents" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.customDirectory).toBeDefined();
  });
});

describe("draftFromInstance round-trip", () => {
  it("edits what it saved", () => {
    const built = buildHarnessInstance(
      draft({ commandLine: `node "/My Agents/agent.mjs" --acp`, modelsText: "a = A" }),
    );
    if (!built.ok) throw new Error("expected ok");
    const back = draftFromInstance(built.instance, built.config);
    expect(back.commandLine).toBe(`node '/My Agents/agent.mjs' --acp`);
    expect(back.modelsText).toBe("a = A");
    const rebuilt = buildHarnessInstance(back);
    expect(rebuilt.ok && rebuilt.config).toEqual(built.config);
  });
});

describe("helpers", () => {
  it("parses models and picks non-colliding custom- ids", () => {
    expect(parseModelsText("a, b = B\n\na")).toEqual([{ id: "a" }, { id: "b", name: "B" }]);
    expect(newHarnessInstanceId("Codex", new Set(["codex"]))).toBe("custom-codex");
    expect(newHarnessInstanceId("Codex", new Set(["custom-codex"]))).toBe("custom-codex-2");
  });
});
