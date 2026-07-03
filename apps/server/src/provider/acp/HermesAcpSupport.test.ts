import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyHermesAcpModelSelection,
  buildHermesAcpSpawnInput,
  buildHermesConfigYaml,
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
        "model:",
        '  provider: "openai-api"',
        '  default: "anthropic/claude-haiku-4.5"',
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
