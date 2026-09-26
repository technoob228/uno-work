import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyHermesAcpModelSelection,
  buildHermesAcpSpawnInput,
  buildHermesConfigYaml,
  hermesLlmRouteEnvironment,
  buildHermesSpawnEnvironment,
  parseMcpJsonToAcpServers,
  resolveHermesBaseModelId,
  resolveHermesModeId,
} from "./HermesAcpSupport.ts";

describe("buildHermesSpawnEnvironment", () => {
  it("pins hermes to the uno gateway with an isolated home", () => {
    const env = buildHermesSpawnEnvironment({
      unoApiKey: "sk-test",
      hermesHome: "/state/hermes-home-hermes",
    });
    expect(env).toEqual({
      HERMES_HOME: "/state/hermes-home-hermes",
      HERMES_INFERENCE_PROVIDER: "openai-api",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: "https://api.getuno.xyz/v1",
      STT_OPENAI_BASE_URL: "https://api.getuno.xyz/v1",
    });
  });
});

describe("buildHermesAcpSpawnInput", () => {
  it("spawns `hermes acp` and falls back to the bare binary name", () => {
    expect(buildHermesAcpSpawnInput(undefined, "/ws").command).toBe("hermes");
    expect(buildHermesAcpSpawnInput({ binaryPath: "/opt/hermes" }, "/ws")).toMatchObject({
      command: "/opt/hermes",
      args: ["acp"],
      cwd: "/ws",
    });
  });
});

describe("resolveHermesBaseModelId", () => {
  it("strips a provider namespace prefix", () => {
    expect(resolveHermesBaseModelId("openai-api:anthropic/claude-haiku-4.5")).toBe(
      "anthropic/claude-haiku-4.5",
    );
    expect(resolveHermesBaseModelId("openrouter:openai/gpt-5.5")).toBe("openai/gpt-5.5");
  });

  it("keeps plain gateway ids and model ids with non-provider colons", () => {
    expect(resolveHermesBaseModelId("anthropic/claude-haiku-4.5")).toBe(
      "anthropic/claude-haiku-4.5",
    );
    // ':free'-суффиксы OpenRouter: слева от двоеточия не slug провайдера.
    expect(resolveHermesBaseModelId("nvidia/nemotron-3:free")).toBe("nvidia/nemotron-3:free");
    expect(resolveHermesBaseModelId("  ")).toBeUndefined();
    expect(resolveHermesBaseModelId(undefined)).toBeUndefined();
  });
});

describe("resolveHermesModeId", () => {
  it("maps runtime modes onto hermes edit-approval modes", () => {
    expect(resolveHermesModeId("full-access")).toBe("dont_ask");
    expect(resolveHermesModeId("approval-required")).toBe("default");
  });
});

describe("applyHermesAcpModelSelection", () => {
  it("sends the openrouter pivot before the openai-api switch", async () => {
    const calls: Array<{ method: string; payload: unknown }> = [];
    await Effect.runPromise(
      applyHermesAcpModelSelection({
        runtime: {
          request: (method, payload) =>
            Effect.sync(() => {
              calls.push({ method, payload });
              return {};
            }),
        },
        sessionId: "session-1",
        model: "anthropic/claude-haiku-4.5",
        mapError: (cause) => cause,
      }),
    );
    expect(calls).toEqual([
      {
        method: "session/set_model",
        payload: {
          sessionId: "session-1",
          modelId: "openrouter:anthropic/claude-haiku-4.5",
        },
      },
      {
        method: "session/set_model",
        payload: {
          sessionId: "session-1",
          modelId: "openai-api:anthropic/claude-haiku-4.5",
        },
      },
    ]);
  });

  it("maps request failures through mapError", async () => {
    const result = await Effect.runPromise(
      Effect.flip(
        applyHermesAcpModelSelection({
          runtime: {
            request: () =>
              Effect.fail(
                new EffectAcpErrors.AcpRequestError({
                  code: -32000,
                  errorMessage: "boom",
                }),
              ),
          },
          sessionId: "session-1",
          model: "anthropic/claude-haiku-4.5",
          mapError: () => "mapped" as const,
        }),
      ),
    );
    expect(result).toBe("mapped");
  });
});

describe("buildHermesConfigYaml", () => {
  it("pins provider+default model and inlines mcp servers (survives set_model rebuilds)", () => {
    const yaml = buildHermesConfigYaml({
      model: "anthropic/claude-haiku-4.5",
      mcpServers: [
        {
          type: "http",
          name: "uno-manager",
          url: "http://127.0.0.1:13776/api/manager/mcp",
          headers: [{ name: "Authorization", value: "Bearer uwm_test" }],
        },
        { name: "local", command: "node", args: ["bridge.mjs"], env: [{ name: "K", value: "v" }] },
      ],
    });
    expect(yaml).toBe(
      [
        "agent:",
        "  api_max_retries: 8",
        "  intent_ack_continuation: true",
        "model:",
        '  provider: "openai-api"',
        '  default: "anthropic/claude-haiku-4.5"',
        "providers:",
        '  "openai-api":',
        "    request_timeout_seconds: 180",
        "    stale_timeout_seconds: 120",
        "stt:",
        "  enabled: true",
        '  provider: "openai"',
        "  openai:",
        '    model: "openai/whisper-large-v3"',
        "mcp_servers:",
        '  "uno-manager":',
        '    url: "http://127.0.0.1:13776/api/manager/mcp"',
        "    headers:",
        '      "Authorization": "Bearer uwm_test"',
        '  "local":',
        '    command: "node"',
        '    args: ["bridge.mjs"]',
        "    env:",
        '      "K": "v"',
        "",
      ].join("\n"),
    );
  });

  it("omits the mcp_servers block when empty", () => {
    const yaml = buildHermesConfigYaml({ model: "openai/gpt-5.5", mcpServers: [] });
    expect(yaml).not.toContain("mcp_servers");
    expect(yaml).toContain('default: "openai/gpt-5.5"');
  });

  it("always pins gateway timeouts and the openai stt fallback", () => {
    const yaml = buildHermesConfigYaml({ model: "openai/gpt-5.5", mcpServers: [] });
    expect(yaml).toContain("request_timeout_seconds: 180");
    expect(yaml).toContain("stale_timeout_seconds: 120");
    expect(yaml).toContain('provider: "openai"');
    expect(yaml).toContain('model: "openai/whisper-large-v3"');
  });

  it("raises agent retries above the default so a provider 429 does not eat the turn", () => {
    const yaml = buildHermesConfigYaml({ model: "openai/gpt-5.5", mcpServers: [] });
    expect(yaml).toContain("api_max_retries: 8");
    expect(yaml).toContain("intent_ack_continuation: true");
  });
});

describe("parseMcpJsonToAcpServers", () => {
  it("converts http entries with headers (assistant workspace format)", () => {
    const servers = parseMcpJsonToAcpServers(
      JSON.stringify({
        mcpServers: {
          "uno-manager": {
            type: "http",
            url: "http://127.0.0.1:13776/api/manager/mcp",
            headers: { Authorization: "Bearer uwm_test" },
          },
        },
      }),
    );
    expect(servers).toEqual([
      {
        type: "http",
        name: "uno-manager",
        url: "http://127.0.0.1:13776/api/manager/mcp",
        headers: [{ name: "Authorization", value: "Bearer uwm_test" }],
      },
    ]);
  });

  it("converts stdio entries and skips malformed ones", () => {
    const servers = parseMcpJsonToAcpServers(
      JSON.stringify({
        mcpServers: {
          local: { command: "node", args: ["bridge.mjs"], env: { KEY: "v" } },
          broken: { nope: true },
        },
      }),
    );
    expect(servers).toEqual([
      {
        name: "local",
        command: "node",
        args: ["bridge.mjs"],
        env: [{ name: "KEY", value: "v" }],
      },
    ]);
  });

  it("returns empty for invalid json", () => {
    expect(parseMcpJsonToAcpServers("{oops")).toEqual([]);
    expect(parseMcpJsonToAcpServers("null")).toEqual([]);
  });
});

describe("buildHermesConfigYaml skills", () => {
  it("points Hermes at the shared skill folders", () => {
    const yaml = buildHermesConfigYaml({
      model: "openai/gpt-5.5",
      mcpServers: [],
      skillsExternalDirs: ["/home/u/.claude/skills"],
    });
    expect(yaml).toContain('skills:\n  external_dirs:\n    - "/home/u/.claude/skills"');
  });
});

describe("hermes LLM route (0.0.84)", () => {
  it("points the openai-api provider at the route's endpoint and key", () => {
    expect(
      hermesLlmRouteEnvironment({
        provider: "xai",
        apiKey: "xai-key",
        baseUrl: "https://api.x.ai/v1",
      }),
    ).toEqual({
      HERMES_INFERENCE_PROVIDER: "openai-api",
      OPENAI_API_KEY: "xai-key",
      OPENAI_BASE_URL: "https://api.x.ai/v1",
    });
  });

  it("turns speech-to-text off for a brought key (it would go to the gateway)", () => {
    const yaml = buildHermesConfigYaml({
      model: "grok-4.7",
      mcpServers: [],
      speechToText: false,
    });
    expect(yaml).toContain("stt:\n  enabled: false\n");
    expect(yaml).not.toContain("whisper");
    expect(buildHermesConfigYaml({ model: "m", mcpServers: [] })).toContain("  enabled: true");
  });

  it("moves Hermes' own session titles to the side-task model when given one", () => {
    const yaml = buildHermesConfigYaml({
      model: "uno/smart",
      mcpServers: [],
      sideTaskModel: "uno/fast",
    });
    expect(yaml).toContain(
      'auxiliary:\n  title_generation:\n    model: "uno/fast"\n    timeout: 15\n',
    );
    expect(buildHermesConfigYaml({ model: "uno/smart", mcpServers: [] })).not.toContain(
      "auxiliary",
    );
  });
});
