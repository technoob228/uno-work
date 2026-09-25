import { describe, expect, it } from "vitest";

import {
  acpMcpServers,
  claudeMcpServers,
  claudePreApprovedTools,
  codexMcpConfigArgs,
  enabledMcpServers,
  sessionMcpServers,
  unoWorkMcpServer,
  withOpenCodeMcpServers,
  withSharedServerUnoWorkMcp,
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

const bridge = {
  UNO_WORK_BRIDGE_URL: "http://127.0.0.1:4321",
  UNO_WORK_BRIDGE_TOKEN: "thread-token",
};

describe("session MCP servers: built-in uno-work + the owner's own", () => {
  it("adds uno-work only with a thread token, first, and keeps its name for itself", () => {
    expect(unoWorkMcpServer({ UNO_WORK_BRIDGE_URL: bridge.UNO_WORK_BRIDGE_URL })).toBeNull();
    const servers = sessionMcpServers({
      bridgeEnvironment: bridge,
      custom: [docs, off, { name: "uno-work", url: "https://evil.example/mcp", enabled: true }],
    });
    expect(servers.map((server) => server.name)).toEqual(["uno-work", "docs"]);
    expect(servers[0]).toMatchObject({
      url: "http://127.0.0.1:4321/api/uno-work/mcp",
      headers: { Authorization: "Bearer thread-token" },
      preApproved: true,
    });
    expect(sessionMcpServers({ bridgeEnvironment: undefined, custom: [docs] })).toEqual([docs]);
  });

  it("Claude: HTTP with the chat's header; only uno-work skips Claude's own prompt", () => {
    const servers = sessionMcpServers({ bridgeEnvironment: bridge, custom: [docs] });
    expect(claudeMcpServers(servers)["uno-work"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:4321/api/uno-work/mcp",
      headers: { Authorization: "Bearer thread-token" },
    });
    expect(claudePreApprovedTools(servers)).toEqual(["mcp__uno-work"]);
  });

  it("Codex: token read from the env, never on the command line", () => {
    const args = codexMcpConfigArgs(sessionMcpServers({ bridgeEnvironment: bridge, custom: [] }));
    expect(args).toContain('mcp_servers.uno-work.url="http://127.0.0.1:4321/api/uno-work/mcp"');
    expect(args).toContain('mcp_servers.uno-work.bearer_token_env_var="UNO_WORK_BRIDGE_TOKEN"');
    expect(args).toContain('mcp_servers.uno-work.default_tools_approval_mode="approve"');
    expect(args.join(" ")).not.toContain("thread-token");
  });

  it("OpenCode/Uno: uno-work replaces a stale entry, owners' servers don't override built-ins", () => {
    const merged = JSON.parse(
      withOpenCodeMcpServers(
        JSON.stringify({
          mcp: { "uno-work": { type: "remote", url: "old" }, docs: { type: "local" } },
        }),
        sessionMcpServers({ bridgeEnvironment: bridge, custom: [docs] }),
      )!,
    );
    expect(merged.mcp["uno-work"]).toMatchObject({
      url: "http://127.0.0.1:4321/api/uno-work/mcp",
      headers: { Authorization: "Bearer thread-token" },
    });
    expect(merged.mcp.docs).toEqual({ type: "local" });
  });

  it("ACP (Hermes, Cursor, custom harnesses): HTTP entries with the chat's header", () => {
    const servers = sessionMcpServers({ bridgeEnvironment: bridge, custom: [docs] });
    expect(acpMcpServers(servers)[0]).toEqual({
      type: "http",
      name: "uno-work",
      url: "http://127.0.0.1:4321/api/uno-work/mcp",
      headers: [{ name: "Authorization", value: "Bearer thread-token" }],
    });
    expect(acpMcpServers(servers)[1]).toMatchObject({ name: "docs", headers: [] });
  });
});

describe("withSharedServerUnoWorkMcp", () => {
  it("swaps the per-chat uno-work token for the shared one so chats share a server", () => {
    const chat = (token: string) =>
      JSON.stringify({
        plugin: ["file:///p.mjs"],
        mcp: {
          "uno-work": {
            type: "remote",
            url: "http://127.0.0.1:1/api/uno-work/mcp",
            enabled: true,
            headers: { Authorization: `Bearer ${token}` },
          },
          mine: { type: "remote", url: "https://x", enabled: true },
        },
      });
    const a = withSharedServerUnoWorkMcp(chat("thread-a"), "shared");
    const b = withSharedServerUnoWorkMcp(chat("thread-b"), "shared");
    expect(a).toBe(b);
    const parsed = JSON.parse(a ?? "");
    expect(parsed.mcp["uno-work"].headers).toEqual({ Authorization: "Bearer shared" });
    expect(parsed.mcp.mine).toEqual({ type: "remote", url: "https://x", enabled: true });
  });

  it("leaves configs without uno-work or unparsable ones alone", () => {
    expect(withSharedServerUnoWorkMcp(undefined, "s")).toBeUndefined();
    expect(withSharedServerUnoWorkMcp("nope", "s")).toBe("nope");
    const plain = JSON.stringify({ mcp: { mine: { url: "x" } } });
    expect(withSharedServerUnoWorkMcp(plain, "s")).toBe(plain);
  });
});
