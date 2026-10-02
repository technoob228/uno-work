import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  mergeMcpIntoOpenCodeConfigContent,
  parseMcpJsonToOpenCodeMcp,
  projectMcpConfigOverlay,
} from "./opencodeMcpConfig.ts";

const ASSISTANT_MCP_JSON = JSON.stringify({
  mcpServers: {
    "uno-manager": {
      type: "http",
      url: "http://127.0.0.1:13776/api/manager/mcp",
      headers: { Authorization: "Bearer uwm_test" },
    },
  },
});

describe("parseMcpJsonToOpenCodeMcp", () => {
  it("converts http entries to opencode remote servers (assistant workspace format)", () => {
    expect(parseMcpJsonToOpenCodeMcp(ASSISTANT_MCP_JSON)).toEqual({
      "uno-manager": {
        type: "remote",
        url: "http://127.0.0.1:13776/api/manager/mcp",
        headers: { Authorization: "Bearer uwm_test" },
        enabled: true,
      },
    });
  });

  it("converts sse entries to remote as well and omits empty headers", () => {
    expect(
      parseMcpJsonToOpenCodeMcp(
        JSON.stringify({ mcpServers: { events: { type: "sse", url: "https://x.test/sse" } } }),
      ),
    ).toEqual({ events: { type: "remote", url: "https://x.test/sse", enabled: true } });
  });

  it("converts stdio entries to local servers with command array + environment", () => {
    expect(
      parseMcpJsonToOpenCodeMcp(
        JSON.stringify({
          mcpServers: {
            local: { command: "node", args: ["bridge.mjs", "--flag"], env: { KEY: "v" } },
            bare: { command: "uvx" },
            broken: { nope: true },
          },
        }),
      ),
    ).toEqual({
      local: {
        type: "local",
        command: ["node", "bridge.mjs", "--flag"],
        environment: { KEY: "v" },
        enabled: true,
      },
      bare: { type: "local", command: ["uvx"], enabled: true },
    });
  });

  it("returns empty for invalid or serverless json", () => {
    expect(parseMcpJsonToOpenCodeMcp("{oops")).toEqual({});
    expect(parseMcpJsonToOpenCodeMcp("null")).toEqual({});
    expect(parseMcpJsonToOpenCodeMcp(JSON.stringify({ mcpServers: {} }))).toEqual({});
  });
});

describe("mergeMcpIntoOpenCodeConfigContent", () => {
  const mcp = parseMcpJsonToOpenCodeMcp(ASSISTANT_MCP_JSON);

  it("keeps provider/instructions and existing mcp servers (UnoDriver content)", () => {
    const existing = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: { uno: { name: "Uno Global" } },
      instructions: ["/state/browser.md"],
      mcp: { "uno-search": { type: "local", command: ["node", "search.mjs"], enabled: true } },
    });
    expect(JSON.parse(mergeMcpIntoOpenCodeConfigContent(existing, mcp) ?? "")).toEqual({
      $schema: "https://opencode.ai/config.json",
      provider: { uno: { name: "Uno Global" } },
      instructions: ["/state/browser.md"],
      mcp: {
        "uno-search": { type: "local", command: ["node", "search.mjs"], enabled: true },
        "uno-manager": mcp["uno-manager"],
      },
    });
  });

  it("lets project servers override same-named existing entries", () => {
    const existing = JSON.stringify({
      mcp: { "uno-manager": { type: "remote", url: "http://stale", enabled: true } },
    });
    expect(JSON.parse(mergeMcpIntoOpenCodeConfigContent(existing, mcp) ?? "").mcp).toEqual({
      "uno-manager": mcp["uno-manager"],
    });
  });

  it("creates a fresh config when there is no existing content", () => {
    expect(JSON.parse(mergeMcpIntoOpenCodeConfigContent(undefined, mcp) ?? "")).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp,
    });
  });

  it("leaves content untouched when there is nothing to add or it is not a JSON object", () => {
    expect(mergeMcpIntoOpenCodeConfigContent('{"a":1}', {})).toBe('{"a":1}');
    expect(mergeMcpIntoOpenCodeConfigContent(undefined, {})).toBeUndefined();
    expect(mergeMcpIntoOpenCodeConfigContent("{broken", mcp)).toBe("{broken");
    expect(mergeMcpIntoOpenCodeConfigContent("[1]", mcp)).toBe("[1]");
  });
});

describe("projectMcpConfigOverlay", () => {
  const run = (cwd: string, existingConfigContent: string | undefined) =>
    Effect.runPromise(
      projectMcpConfigOverlay({ cwd, existingConfigContent }).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );

  it("returns a merged OPENCODE_CONFIG_CONTENT when .mcp.json has servers", async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "opencode-mcp-"));
    try {
      nodeFs.writeFileSync(nodePath.join(dir, ".mcp.json"), ASSISTANT_MCP_JSON);
      const overlay = await run(dir, JSON.stringify({ instructions: ["/x.md"] }));
      expect(JSON.parse(overlay.OPENCODE_CONFIG_CONTENT ?? "")).toEqual({
        instructions: ["/x.md"],
        mcp: parseMcpJsonToOpenCodeMcp(ASSISTANT_MCP_JSON),
      });
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty overlay when there is no .mcp.json", async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "opencode-mcp-"));
    try {
      expect(await run(dir, undefined)).toEqual({});
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
