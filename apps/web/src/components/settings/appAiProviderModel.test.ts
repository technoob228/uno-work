import type { AppAiProviders } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  MANUAL_LOCAL_VALUE,
  addAiPrompt,
  choiceFromValue,
  choiceValue,
  installAiLines,
  providerOptions,
  providersSummary,
  storeAiLine,
  tileAiNote,
} from "./appAiProviderModel";

const providers: AppAiProviders = {
  unoConnected: true,
  local: [
    {
      id: "ollama",
      label: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      models: ["qwen3:4b", "qwen2.5:7b"],
      detected: true,
      reachable: true,
    },
  ],
  personal: [],
  keys: [
    {
      provider: "custom",
      configured: true,
      keyHint: "1234",
      baseUrl: "https://gw/v1",
      updatedAt: null,
    },
  ],
  checkedAt: null,
};

describe("store and install wording", () => {
  it("says what the app uses, how much and through what", () => {
    expect(storeAiLine({ chat: true, tasks: false, limitUsd: 5 })).toBe(
      "Uses AI for answers · up to $5 · via Uno AI",
    );
    expect(storeAiLine({ chat: true, tasks: true, limitUsd: null })).toBe(
      "Uses AI for answers and jobs · up to $10 · via Uno AI",
    );
    const lines = installAiLines({ chat: false, tasks: true, limitUsd: 2 });
    expect(lines[0]).toContain("for jobs");
    expect(lines.join(" ")).toContain("up to $2 of your Uno AI credits");
    expect(lines.join(" ")).toContain("Settings → Apps");
  });
});

describe("tileAiNote", () => {
  const base = {
    chat: true,
    tasks: false,
    status: "active" as const,
    spentUsd: 0.4,
    limitUsd: 10,
  };
  it("shows spend only for Uno AI", () => {
    expect(tileAiNote({ ...base, providerLabel: "Uno AI · m", metered: true })).toBe(
      "Uses AI for answers · Uno AI · m · $0.40 of $10",
    );
    expect(
      tileAiNote({ ...base, providerLabel: "Ollama on this computer · qwen3:4b", metered: false }),
    ).toBe("Uses AI for answers · Ollama on this computer · qwen3:4b");
    expect(tileAiNote({ ...base, status: "revoked" })).toBe("AI turned off");
    expect(tileAiNote({ ...base, chat: false })).toBeNull();
  });
});

describe("Answers from", () => {
  it("offers Uno AI, what runs here, own keys and a manual address", () => {
    const options = providerOptions(providers, { kind: "uno" });
    expect(options.map((o) => o.value)).toEqual([
      "uno",
      "local:http://127.0.0.1:11434/v1",
      "byok:custom",
      MANUAL_LOCAL_VALUE,
    ]);
    expect(options[1]).toMatchObject({
      label: "Ollama on this computer",
      hint: "2 models · free, no limit",
    });
  });

  it("keeps a choice that isn't available any more, saying so", () => {
    const options = providerOptions(providers, { kind: "byok", keyProvider: "openai" });
    expect(options.find((o) => o.value === "byok:openai")?.label).toBe("OpenAI (key removed)");
  });

  it("round-trips values and keeps the model only for the same provider", () => {
    const current = {
      kind: "local" as const,
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3:4b",
    };
    expect(choiceValue(current)).toBe("local:http://127.0.0.1:11434/v1");
    expect(choiceFromValue("local:http://127.0.0.1:11434/v1", current)).toEqual(current);
    expect(choiceFromValue("uno", current)).toEqual({ kind: "uno", model: null });
    expect(choiceFromValue("byok:custom", current)).toEqual({
      kind: "byok",
      keyProvider: "custom",
      model: null,
    });
    expect(choiceFromValue(MANUAL_LOCAL_VALUE, current)).toBeNull();
    expect(choiceFromValue("byok:evil", current)).toBeNull();
  });

  it("sums up what is here", () => {
    expect(providersSummary(providers)).toBe(
      "Available here: Uno AI · Ollama on this computer (qwen3:4b, qwen2.5:7b) · your Custom key",
    );
  });
});

describe("addAiPrompt", () => {
  it("asks the agent for <uno-chat> through the SDK, with the manifest", () => {
    const prompt = addAiPrompt({
      id: "notes",
      name: "Notes",
      codeDir: "~/apps/notes",
      hasAi: false,
    });
    expect(prompt).toContain('Add AI to my app "Notes" (code in ~/apps/notes).');
    expect(prompt).toContain('"ai": {"chat": true} to ~/.uno/apps/notes.json');
    expect(prompt).toContain("<uno-chat>");
    expect(prompt).toContain("~/.uno/ai-providers.md");
  });
});
