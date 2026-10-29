import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyHermesAcpModelSelection,
  buildHermesAcpSpawnInput,
  buildHermesConfigYaml,
  HERMES_DISPATCHER_COMPRESSION,
  HERMES_DISPATCHER_DISABLED_TOOLSETS,
  HERMES_DISPATCHER_MCP_TOOLS,
  applyHermesLlmRoute,
  applyHermesAcpModelSelection as applyModelSelectionForTest,
  hermesProviderIdOf,
  hermesThreadHomeLinks,
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
  it("writes a server's tool-call timeout (ACP session/new can't carry it)", () => {
    const yaml = buildHermesConfigYaml({
      model: "uno/smart",
      mcpServers: [
        { type: "http", name: "uno-work", url: "http://127.0.0.1:1/api/uno-work/mcp", headers: [] },
        { type: "http", name: "docs", url: "https://docs.example/mcp", headers: [] },
      ],
      mcpToolTimeoutSec: { "uno-work": 900 },
    });
    expect(yaml).toContain(
      '  "uno-work":\n    timeout: 900\n    url: "http://127.0.0.1:1/api/uno-work/mcp"',
    );
    expect(yaml).toContain('  "docs":\n    url: "https://docs.example/mcp"');
  });

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
        "  api_max_retries: 3",
        "  intent_ack_continuation: true",
        "  verify_on_stop: false",
        "model:",
        '  provider: "openai-api"',
        '  default: "anthropic/claude-haiku-4.5"',
        '  api_mode: "chat_completions"',
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
    expect(yaml).toContain("api_max_retries: 3");
    expect(yaml).toContain("intent_ack_continuation: true");
    // Hermes' verify-before-stop guard is what made a bot turn 7–9 minutes
    // and leaked "hermes-verify-" / "fresh evidence" to the person.
    expect(yaml).toContain("verify_on_stop: false");
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

describe("buildHermesConfigYaml for the Uno dispatcher", () => {
  const yaml = buildHermesConfigYaml({
    model: "uno/glm-5.3-flash",
    mcpServers: [
      { type: "http", name: "uno-manager", url: "http://127.0.0.1:1/mcp", headers: [] },
      { type: "http", name: "uno-work", url: "http://127.0.0.1:1/w", headers: [] },
    ],
    disabledToolsets: HERMES_DISPATCHER_DISABLED_TOOLSETS,
    mcpToolsInclude: HERMES_DISPATCHER_MCP_TOOLS,
    compression: HERMES_DISPATCHER_COMPRESSION,
  });

  it("no terminal, files, browser or web; only the dispatcher's MCP tools", () => {
    expect(yaml).toContain('disabled_toolsets: ["terminal", "file", "code_execution", "browser", "web"');
    expect(yaml).toMatch(/"uno-manager":\n[\s\S]*?include: \["work_status"[^\]]*"notes_append"[^\]]*"send_file"/);
    expect(yaml).toMatch(/"uno-work":\n[\s\S]*?include: \["chat_create"/);
    expect(yaml).not.toMatch(/include: \[[^\]]*"site_publish"/);
  });

  it("compacts its context early, by the same model", () => {
    expect(yaml).toContain("compression:\n  enabled: true\n  threshold_tokens: 28000");
    expect(yaml).toContain('auxiliary:\n  compression:\n    provider: "main"\n    model: "uno/glm-5.3-flash"');
  });

  it("other sessions get none of it", () => {
    const plain = buildHermesConfigYaml({ model: "m", mcpServers: [] });
    expect(plain).not.toContain("disabled_toolsets");
    expect(plain).not.toContain("compression:");
    expect(plain).not.toContain("include:");
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
      applyHermesLlmRoute(
        { HOME: "/home/u" },
        {
          provider: "xai",
          apiKey: "xai-key",
          baseUrl: "https://api.x.ai/v1",
        },
      ),
    ).toEqual({
      HOME: "/home/u",
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

const slashJoin = (...parts: ReadonlyArray<string>) => parts.join("/");

describe("hermes on the person's own subscription (14.10)", () => {
  const gatewayEnv = {
    HOME: "/home/u",
    HERMES_INFERENCE_PROVIDER: "openai-api",
    OPENAI_API_KEY: "uno-gateway-key",
    OPENAI_BASE_URL: "https://ai.uno/v1",
    STT_OPENAI_BASE_URL: "https://ai.uno/v1",
    ANTHROPIC_BASE_URL: "https://ai.uno",
    ANTHROPIC_AUTH_TOKEN: "uno-gateway-key",
  };

  it("runs Claude on the plugin's provider with no Uno key and nothing pointing Claude elsewhere", () => {
    const env = applyHermesLlmRoute(gatewayEnv, { provider: "claude" });
    expect(env).toEqual({
      HOME: "/home/u",
      HERMES_INFERENCE_PROVIDER: "claude-subscription-directsdk-experimental",
    });
  });

  it("runs ChatGPT on Hermes' openai-codex provider without the gateway key", () => {
    const env = applyHermesLlmRoute(gatewayEnv, { provider: "chatgpt" });
    expect(env.HERMES_INFERENCE_PROVIDER).toBe("openai-codex");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("names Hermes' provider for config.yaml and the ACP auth method", () => {
    expect(hermesProviderIdOf(undefined)).toBe("openai-api");
    expect(hermesProviderIdOf({ provider: "uno", apiKey: "k", baseUrl: "u" })).toBe("openai-api");
    expect(hermesProviderIdOf({ provider: "chatgpt" })).toBe("openai-codex");
    expect(hermesProviderIdOf({ provider: "claude" })).toBe(
      "claude-subscription-directsdk-experimental",
    );
  });

  it("writes the subscription's provider into config.yaml with a long stream timeout", () => {
    const yaml = buildHermesConfigYaml({
      model: "sonnet",
      provider: "claude-subscription-directsdk-experimental",
      mcpServers: [],
      speechToText: false,
    });
    expect(yaml).toContain(
      'model:\n  provider: "claude-subscription-directsdk-experimental"\n  default: "sonnet"',
    );
    expect(yaml).toContain(
      'providers:\n  "claude-subscription-directsdk-experimental":\n    stale_timeout_seconds: 900\n',
    );
    expect(yaml).not.toContain("request_timeout_seconds");
  });

  it("links the shared runtime always, the ChatGPT sign-in and the Claude plugin by provider", () => {
    const base = { threadHome: "/s/h/threads/t1", sharedHome: "/s/h", join: slashJoin };
    expect(hermesThreadHomeLinks({ ...base, provider: "uno" })).toEqual([
      { path: "/s/h/threads/t1/installs", target: "/s/h/installs", directory: true },
    ]);
    expect(
      hermesThreadHomeLinks({ ...base, provider: "chatgpt" }).map((link) => link.path),
    ).toEqual([
      "/s/h/threads/t1/installs",
      "/s/h/threads/t1/auth.json",
      "/s/h/threads/t1/auth.lock",
    ]);
    expect(hermesThreadHomeLinks({ ...base, provider: "claude" })).toContainEqual({
      path: "/s/h/threads/t1/plugins/claude-subscription-directsdk-experimental",
      target: "/s/h/plugins/claude-subscription-directsdk-experimental",
      directory: true,
    });
  });

  it("keeps the gateway's model switch working when Hermes ≥ 0.21 refuses the pivot", async () => {
    const calls: Array<string> = [];
    await Effect.runPromise(
      applyModelSelectionForTest({
        runtime: {
          request: ((_method: string, params: { modelId: string }) => {
            calls.push(params.modelId);
            return params.modelId.startsWith("openrouter:")
              ? Effect.fail(
                  new EffectAcpErrors.AcpRequestError({
                    code: -32603,
                    errorMessage: "no provider",
                  }),
                )
              : Effect.succeed({});
          }) as never,
        },
        sessionId: "s",
        model: "uno/smart",
        mapError: (cause) => cause,
      }),
    );
    expect(calls).toEqual(["openrouter:uno/smart", "openai-api:uno/smart"]);
  });

  it("sets a subscription's model in one call (the openrouter pivot fails there)", async () => {
    const calls: Array<string> = [];
    await Effect.runPromise(
      applyModelSelectionForTest({
        runtime: {
          request: ((_method: string, params: { modelId: string }) => {
            calls.push(params.modelId);
            return Effect.succeed({});
          }) as never,
        },
        sessionId: "s",
        model: "gpt-5.5",
        hermesProvider: "openai-codex",
        mapError: (cause) => cause,
      }),
    );
    expect(calls).toEqual(["openai-codex:gpt-5.5"]);
  });
});
