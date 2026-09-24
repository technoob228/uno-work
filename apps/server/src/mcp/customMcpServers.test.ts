import { describe, expect, it } from "vitest";

import {
  acpMcpServers,
  claudeMcpServers,
  codexMcpConfigArgs,
  enabledMcpServers,
  withOpenCodeMcpServers,
} from "./customMcpServers.ts";

const docs = { name: "docs", url: " https://mcp.example.com/mcp ", enabled: true };
const off = { name: "off", url: "https://off.example.com/mcp", enabled: false };
const bad = { name: "bad", url: "file:///etc/passwd", enabled: true };

describe("custom MCP servers", () => {
  it("keeps only enabled http(s) servers", () => {
    expect(enabledMcpServers([docs, off, bad]).map((server) => server.name)).toEqual(["docs"]);
    expect(enabledMcpServers(undefined)).toEqual([]);
  });

  it("maps to Claude SDK http servers", () => {
    expect(claudeMcpServers([docs, off])).toEqual({
      docs: { type: "http", url: "https://mcp.example.com/mcp" },
    });
  });

  it("maps to codex -c overrides with a TOML string", () => {
    expect(codexMcpConfigArgs([docs])).toEqual([
      "-c",
      'mcp_servers.docs.url="https://mcp.example.com/mcp"',
    ]);
    expect(
      codexMcpConfigArgs([{ name: "q", url: 'https://x.dev/a"b\\c\n', enabled: true }]),
    ).toEqual(["-c", 'mcp_servers.q.url="https://x.dev/a\\"b\\\\c"']);
    expect(codexMcpConfigArgs([])).toEqual([]);
  });

  it("merges into OPENCODE_CONFIG_CONTENT without dropping what is there", () => {
    const base = JSON.stringify({
      instructions: ["/tmp/i.md"],
      mcp: { "uno-search": { type: "local", command: ["node"] }, docs: { type: "local" } },
    });
    const merged = JSON.parse(withOpenCodeMcpServers(base, [docs])!);
    expect(merged.instructions).toEqual(["/tmp/i.md"]);
    expect(merged.mcp["uno-search"]).toEqual({ type: "local", command: ["node"] });
    // A built-in entry with the same name wins.
    expect(merged.mcp.docs).toEqual({ type: "local" });
  });

  it("creates a config when there is none and leaves input alone when nothing to add", () => {
    const created = JSON.parse(withOpenCodeMcpServers(undefined, [docs])!);
    expect(created.mcp.docs).toEqual({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      enabled: true,
    });
    expect(withOpenCodeMcpServers("{}", [])).toBe("{}");
    expect(withOpenCodeMcpServers("not json", [docs])).toBe("not json");
  });
});

describe("acpMcpServers", () => {
  it("hands enabled servers to ACP harnesses (Hermes) as http entries", () => {
    expect(
      acpMcpServers([
        { name: "notion", url: " https://mcp.notion.com/mcp ", enabled: true },
        { name: "off", url: "https://x.dev/mcp", enabled: false },
      ] as never),
    ).toEqual([{ type: "http", name: "notion", url: "https://mcp.notion.com/mcp", headers: [] }]);
  });
});
