import type { RuntimeMode } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { handleMcpMessage } from "../mcp/mcpJsonRpc.ts";
import {
  buildUnoWorkMcpServer,
  connectorToolLevel,
  UNO_WORK_MCP_SERVER,
  type UnoWorkToolDeps,
} from "../unoWork/tools.ts";
import { ConnectorsError, makeConnectorsClient, type MachineCredentials } from "./connectors.ts";

const CONSOLE_LIST = {
  connectors: [
    {
      provider: "google-drive",
      name: "Google Drive",
      description: "Read your files and save new ones.",
      available: true,
      connected: true,
      account: "mikhail@uno4.dev",
      connected_at: "2026-09-25T09:00:00Z",
      tools: [
        {
          name: "gdrive_search",
          description: "Search files.",
          input_schema: { type: "object", properties: { query: { type: "string" } } },
        },
        {
          name: "gdrive_create",
          description: "Create a file.",
          input_schema: { type: "object", properties: { name: { type: "string" } } },
        },
      ],
    },
    {
      provider: "notion",
      name: "Notion",
      description: "Pages and databases.",
      available: true,
      connected: false,
      account: null,
      connected_at: null,
      tools: [{ name: "notion_search", description: "Search.", input_schema: { type: "object" } }],
    },
    { provider: "../evil", name: "x", tools: [] },
  ],
};

interface Call {
  readonly method: string;
  readonly url: string;
  readonly auth: string | null;
  readonly body: unknown;
}

function fakeConsole(
  handler: (call: Call) => { status: number; body?: unknown } = () => ({
    status: 200,
    body: CONSOLE_LIST,
  }),
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = handler(call);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function client(
  options: {
    credentials?: MachineCredentials | null;
    handler?: (call: Call) => { status: number; body?: unknown };
  } = {},
) {
  let clock = 1_000;
  const console = fakeConsole(options.handler);
  const connectors = makeConnectorsClient({
    credentials: async () =>
      options.credentials === undefined
        ? { boxToken: "uno_agt_machine", boxId: 42 }
        : options.credentials,
    baseUrl: () => "https://console.test",
    fetch: console.fetchImpl,
    now: () => clock,
  });
  return {
    connectors,
    calls: console.calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("connectors client", () => {
  it("maps the console list to the Setup shape", async () => {
    const { connectors, calls } = client();
    const list = await connectors.list();
    expect(list).toEqual({
      available: true,
      reason: null,
      connectors: [
        {
          provider: "google-drive",
          name: "Google Drive",
          description: "Read your files and save new ones.",
          available: true,
          connected: true,
          account: "mikhail@uno4.dev",
          connectedAt: "2026-09-25T09:00:00Z",
          toolCount: 2,
        },
        {
          provider: "notion",
          name: "Notion",
          description: "Pages and databases.",
          available: true,
          connected: false,
          account: null,
          connectedAt: null,
          toolCount: 1,
        },
      ],
    });
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "https://console.test/api/v1/boxes/42/work/connectors",
      auth: "Bearer uno_agt_machine",
    });
  });

  it("says not_cloud_computer without a machine token, and start refuses with 409", async () => {
    const { connectors, calls } = client({ credentials: null });
    expect(await connectors.list()).toEqual({
      available: false,
      reason: "not_cloud_computer",
      connectors: [],
    });
    await expect(connectors.start("notion")).rejects.toMatchObject({
      status: 409,
      code: "not_cloud_computer",
    });
    expect(await connectors.tools()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("caches the list for 30 s and drops the cache on start / delete", async () => {
    const { connectors, calls, advance } = client({
      handler: (call) =>
        call.url.endsWith("/start")
          ? { status: 200, body: { authorize_url: "https://accounts.test/o?x=1" } }
          : call.method === "DELETE"
            ? { status: 204 }
            : { status: 200, body: CONSOLE_LIST },
    });
    await connectors.list();
    await connectors.list();
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(1);
    advance(31_000);
    await connectors.list();
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);

    expect(await connectors.start("notion")).toEqual({
      authorizeUrl: "https://accounts.test/o?x=1",
    });
    await connectors.list();
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(3);

    await connectors.remove("notion");
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://console.test/api/v1/boxes/42/work/connectors/notion",
    });
    await connectors.list();
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(4);
  });

  it("reports a connector the console can't offer as 503 connector_not_configured", async () => {
    const { connectors } = client({
      handler: () => ({ status: 503, body: { code: "CONNECTOR_NOT_CONFIGURED" } }),
    });
    const error = await connectors.start("github").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ConnectorsError);
    expect(error).toMatchObject({ status: 503, code: "connector_not_configured" });
  });

  it("reports an unreachable console as available:false", async () => {
    const { connectors } = client({ handler: () => ({ status: 500 }) });
    expect(await connectors.list()).toMatchObject({
      available: false,
      reason: "console_unreachable",
    });
  });

  it("offers only connected providers' tools and forwards calls with the machine token", async () => {
    const { connectors, calls } = client({
      handler: (call) =>
        call.url.endsWith("/call")
          ? {
              status: 200,
              body: { content: [{ type: "text", text: "3 files found" }], is_error: false },
            }
          : { status: 200, body: CONSOLE_LIST },
    });
    const tools = await connectors.tools();
    expect(tools.map((tool) => tool.name)).toEqual(["gdrive_search", "gdrive_create"]);
    expect(tools[0]).toMatchObject({ provider: "google-drive", providerName: "Google Drive" });

    const result = await connectors.call({
      provider: "google-drive",
      tool: "gdrive_search",
      arguments: { query: "brand" },
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "3 files found" }],
      isError: false,
    });
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      url: "https://console.test/api/v1/boxes/42/work/connectors/google-drive/call",
      auth: "Bearer uno_agt_machine",
      body: { tool: "gdrive_search", arguments: { query: "brand" } },
    });
  });

  it("refreshes the tool list at most every 60 s", async () => {
    const { connectors, calls, advance } = client();
    await connectors.tools();
    advance(45_000);
    await connectors.tools();
    expect(calls).toHaveLength(1);
    advance(20_000);
    await connectors.tools();
    expect(calls).toHaveLength(2);
  });
});

describe("connector tools in the uno-work MCP server", () => {
  function mcpDeps(
    connectors: ReturnType<typeof client>["connectors"],
    runtimeMode: RuntimeMode,
    approval: "approved" | "denied" = "approved",
  ) {
    const approvals: string[] = [];
    const deps = {
      caller: { threadId: "t-1", threadTitle: "Chat", runtimeMode, cwd: undefined },
      requestApproval: (input: { title: string }) =>
        Effect.sync(() => {
          approvals.push(input.title);
          return approval;
        }),
      connectors: {
        call: (input: Parameters<typeof connectors.call>[0]) =>
          Effect.promise(() => connectors.call(input)),
      },
    } as unknown as UnoWorkToolDeps;
    return { deps, approvals };
  }

  const setup = async () => {
    const context = client({
      handler: (call) =>
        call.url.endsWith("/call")
          ? {
              status: 200,
              body:
                (call.body as { tool: string }).tool === "gdrive_create"
                  ? { content: [{ type: "text", text: "Created brief.md" }], is_error: false }
                  : { content: [{ type: "text", text: "quota exceeded" }], is_error: true },
            }
          : { status: 200, body: CONSOLE_LIST },
    });
    const server = buildUnoWorkMcpServer(await context.connectors.tools());
    return { ...context, server };
  };

  it("lists connected tools next to the built-in ones, with the console's schema", async () => {
    const { server } = await setup();
    const outcome = await Effect.runPromise(
      handleMcpMessage(server, undefined as unknown as UnoWorkToolDeps, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    );
    const tools = (outcome as { body: { result: { tools: Array<Record<string, unknown>> } } }).body
      .result.tools;
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("computer_status");
    expect(names).toContain("gdrive_search");
    expect(names).not.toContain("notion_search");
    expect(tools.find((tool) => tool.name === "gdrive_search")).toMatchObject({
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      annotations: { readOnlyHint: true },
    });
    expect(buildUnoWorkMcpServer([])).toBe(UNO_WORK_MCP_SERVER);
  });

  it("asks before a write tool in Ask mode, forwards it, and returns the console's content", async () => {
    const { server, connectors, calls } = await setup();
    const { deps, approvals } = mcpDeps(connectors, "approval-required");
    const outcome = await Effect.runPromise(
      handleMcpMessage(server, deps, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "gdrive_create", arguments: { name: "brief.md" } },
      }),
    );
    expect(approvals).toEqual(["Google Drive: gdrive_create"]);
    expect((outcome as { body: { result: unknown } }).body.result).toEqual({
      content: [{ type: "text", text: "Created brief.md" }],
      isError: false,
    });
    expect(calls.at(-1)?.body).toEqual({ tool: "gdrive_create", arguments: { name: "brief.md" } });
  });

  it("runs reads without asking and passes the console's is_error through", async () => {
    const { server, connectors } = await setup();
    const { deps, approvals } = mcpDeps(connectors, "approval-required");
    const outcome = await Effect.runPromise(
      handleMcpMessage(server, deps, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "gdrive_search", arguments: { query: "x" } },
      }),
    );
    expect(approvals).toEqual([]);
    expect((outcome as { body: { result: unknown } }).body.result).toEqual({
      content: [{ type: "text", text: "quota exceeded" }],
      isError: true,
    });
  });

  it("doesn't call the console when the person declines", async () => {
    const { server, connectors, calls } = await setup();
    const { deps } = mcpDeps(connectors, "approval-required", "denied");
    const before = calls.length;
    const outcome = await Effect.runPromise(
      handleMcpMessage(server, deps, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "gdrive_create", arguments: { name: "x" } },
      }),
    );
    expect((outcome as { body: { result: { isError: boolean } } }).body.result.isError).toBe(true);
    expect(calls.length).toBe(before);
  });

  it("classifies write tools as changes", () => {
    for (const name of [
      "gdrive_create",
      "gmail_create_draft",
      "notion_append",
      "notion_create_page",
      "github_create_issue",
      "calendar_create_event",
    ]) {
      expect(connectorToolLevel(name), name).toBe("change");
    }
    for (const name of ["gdrive_search", "gdrive_read", "gmail_search", "calendar_list_events"]) {
      expect(connectorToolLevel(name), name).toBe("safe");
    }
  });
});
