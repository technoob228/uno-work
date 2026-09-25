import { describe, expect, it } from "vitest";

import {
  describeChoice,
  detectLocalAi,
  normalizeLocalBaseUrl,
  normalizeProviderChoice,
  parseModelIds,
  renderProvidersBrief,
  resolveAppAiRoute,
} from "./appAiProviders.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("normalizeLocalBaseUrl", () => {
  it("adds http:// and /v1, drops the trailing slash", () => {
    expect(normalizeLocalBaseUrl("127.0.0.1:11434")).toBe("http://127.0.0.1:11434/v1");
    expect(normalizeLocalBaseUrl("http://localhost:1234/v1/")).toBe("http://localhost:1234/v1");
    expect(normalizeLocalBaseUrl("https://gpu.lan/openai")).toBe("https://gpu.lan/openai");
  });
  it("refuses credentials, queries and other schemes", () => {
    expect(normalizeLocalBaseUrl("http://u:p@host:1/v1")).toBeNull();
    expect(normalizeLocalBaseUrl("http://host:1/v1?x=1")).toBeNull();
    expect(normalizeLocalBaseUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeLocalBaseUrl("  ")).toBeNull();
  });
});

describe("parseModelIds", () => {
  it("reads OpenAI and bare-array shapes, dedupes, keeps the owner", () => {
    expect(
      parseModelIds({ data: [{ id: "qwen3:4b", owned_by: "library" }, { id: "qwen3:4b" }] }),
    ).toEqual({ ids: ["qwen3:4b"], owner: "library" });
    expect(parseModelIds([{ id: "a" }])).toEqual({ ids: ["a"], owner: null });
    expect(parseModelIds({ hello: "world" })).toBeNull();
  });
});

describe("detectLocalAi", () => {
  it("keeps only servers that answer /models in the OpenAI shape, plus manual ones", async () => {
    const seen: string[] = [];
    const found = await detectLocalAi({
      fetch: async (url) => {
        seen.push(url);
        if (url.startsWith("http://127.0.0.1:11434/")) {
          return json({ data: [{ id: "qwen3:4b", owned_by: "library" }] });
        }
        if (url.startsWith("http://127.0.0.1:8080/"))
          return new Response("<html>", { status: 200 });
        if (url.startsWith("http://127.0.0.1:8000/")) {
          return json({ data: [{ id: "Qwen/Qwen3-8B", owned_by: "vllm" }] });
        }
        throw new Error("ECONNREFUSED");
      },
      extraBaseUrls: ["http://10.0.0.5:9000/v1"],
      skipPorts: [1234],
    });
    expect(seen.some((u) => u.includes(":1234/"))).toBe(false);
    expect(found).toEqual([
      {
        id: "ollama",
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        models: ["qwen3:4b"],
        detected: true,
        reachable: true,
      },
      {
        id: "vllm",
        label: "vLLM",
        baseUrl: "http://127.0.0.1:8000/v1",
        models: ["Qwen/Qwen3-8B"],
        detected: true,
        reachable: true,
      },
      {
        id: "manual",
        label: "10.0.0.5:9000",
        baseUrl: "http://10.0.0.5:9000/v1",
        models: [],
        detected: false,
        reachable: false,
      },
    ]);
  });
});

describe("resolveAppAiRoute", () => {
  const deps = {
    gateway: async () => ({ baseUrl: "https://gw/v1", key: "unollm_machine" }),
    gatewayChatModel: async () => "deepseek/deepseek-v3.2",
    byokKey: async (provider: string) =>
      provider === "openrouter"
        ? { apiKey: "sk-or-secret", baseUrl: "https://openrouter.ai/api/v1/" }
        : null,
  };

  it("defaults to the metered Uno gateway with the model for answers", async () => {
    const result = await resolveAppAiRoute(null, deps);
    expect(result).toMatchObject({
      ok: true,
      route: {
        kind: "uno",
        metered: true,
        defaultModel: "deepseek/deepseek-v3.2",
        apiKey: "unollm_machine",
      },
    });
  });

  it("local: no key, not metered, the chosen model", async () => {
    const result = await resolveAppAiRoute(
      { kind: "local", baseUrl: "127.0.0.1:11434", model: "qwen3:4b" },
      deps,
    );
    expect(result).toMatchObject({
      ok: true,
      route: {
        kind: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: null,
        metered: false,
        defaultModel: "qwen3:4b",
        label: "Ollama on this computer",
      },
    });
  });

  it("byok: the stored key, not metered; a missing key is a clear 503", async () => {
    expect(
      await resolveAppAiRoute({ kind: "byok", keyProvider: "openrouter" }, deps),
    ).toMatchObject({
      ok: true,
      route: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-secret", metered: false },
    });
    expect(await resolveAppAiRoute({ kind: "byok", keyProvider: "xai" }, deps)).toMatchObject({
      ok: false,
      status: 503,
      code: "provider_not_configured",
    });
  });

  it("personal: the GPU endpoint with the machine key and quiet warm-up", async () => {
    expect(await resolveAppAiRoute({ kind: "personal", model: "qwen-27b" }, deps)).toMatchObject({
      ok: true,
      route: {
        baseUrl: "https://gpu.uno4.dev/v1",
        headers: { "X-Uno-Warmup": "quiet" },
        metered: false,
        defaultModel: "qwen-27b",
      },
    });
  });

  it("no Uno key: gateway and personal are not connected, local still works", async () => {
    const offline = { ...deps, gateway: async () => null };
    expect(await resolveAppAiRoute(null, offline)).toMatchObject({
      ok: false,
      code: "ai_not_connected",
    });
    expect(
      await resolveAppAiRoute({ kind: "local", baseUrl: "http://127.0.0.1:1234/v1" }, offline),
    ).toMatchObject({ ok: true });
  });
});

describe("normalizeProviderChoice / describeChoice", () => {
  it("drops unknown or unusable choices to null (Uno AI)", () => {
    expect(normalizeProviderChoice({ kind: "local", baseUrl: "ftp://x" })).toBeNull();
    expect(normalizeProviderChoice({ kind: "byok", keyProvider: "evil" })).toBeNull();
    expect(normalizeProviderChoice({ kind: "uno" })).toBeNull();
    expect(normalizeProviderChoice({ kind: "uno", model: "x-ai/grok" })).toEqual({
      kind: "uno",
      model: "x-ai/grok",
    });
    expect(normalizeProviderChoice({ kind: "local", baseUrl: "localhost:11434" })).toEqual({
      kind: "local",
      baseUrl: "http://localhost:11434/v1",
      model: null,
    });
  });

  it("names the provider and model the way a person reads it", () => {
    const providers = {
      local: [
        {
          id: "ollama",
          label: "Ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          models: ["qwen3:4b"],
          detected: true,
          reachable: true,
        },
      ],
    };
    expect(describeChoice(null, providers, "deepseek/deepseek-v3.2")).toBe(
      "Uno AI · deepseek/deepseek-v3.2",
    );
    expect(
      describeChoice({ kind: "local", baseUrl: "http://127.0.0.1:11434/v1" }, providers, "m"),
    ).toBe("Ollama on this computer · qwen3:4b");
    expect(describeChoice({ kind: "byok", keyProvider: "custom", model: "gpt" }, null, "m")).toBe(
      "Custom (your key) · gpt",
    );
  });
});

describe("renderProvidersBrief", () => {
  it("lists what is here now and never a key", () => {
    const brief = renderProvidersBrief({
      providers: {
        unoConnected: true,
        local: [
          {
            id: "ollama",
            label: "Ollama",
            baseUrl: "http://127.0.0.1:11434/v1",
            models: ["qwen3:4b"],
            detected: true,
            reachable: true,
          },
        ],
        personal: [],
        keys: [
          {
            provider: "openrouter",
            configured: true,
            keyHint: "abcd",
            baseUrl: "https://openrouter.ai/api/v1",
            updatedAt: null,
          },
        ],
        checkedAt: null,
      },
      apps: [{ id: "translator", name: "Translator", label: "Uno AI · deepseek/deepseek-v3.2" }],
      apiUrl: "http://127.0.0.1:3779",
      now: new Date("2026-09-24T00:00:00Z"),
    });
    expect(brief).toContain(
      "Ollama on this computer** — http://127.0.0.1:11434/v1 · models: qwen3:4b",
    );
    expect(brief).toContain("OpenRouter");
    expect(brief).toContain("`translator` (Translator) → Uno AI");
    expect(brief).not.toContain("abcd");
  });
});
