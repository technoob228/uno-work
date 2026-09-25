import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { probeMcpServer } from "./mcpProbe.ts";
import { guardedFetch, isForbiddenAddress, NetGuardError } from "./netGuard.ts";

interface Seen {
  method: string;
  path: string;
  session: string | undefined;
  protocol: string | undefined;
  body: { id?: number; method?: string; params?: Record<string, unknown> } | null;
}

const seen: Seen[] = [];
let server: http.Server;
let base = "";

const TOOLS = Array.from({ length: 7 }, (_, index) => ({
  name: `tool_${index + 1}`,
  inputSchema: { type: "object" },
}));

function reply(
  res: http.ServerResponse,
  mode: "json" | "sse",
  message: unknown,
  headers: Record<string, string> = {},
) {
  if (mode === "sse") {
    res.writeHead(200, { "content-type": "text/event-stream", ...headers });
    res.write(": keep-alive\n\n");
    res.write(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`,
    );
    res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    // Leave the stream open a little: the probe must not wait for the end.
    setTimeout(() => res.end(), 2_000);
    return;
  }
  res.writeHead(200, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(message));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw.length > 0 ? (JSON.parse(raw) as Seen["body"]) : null;
      const path = req.url ?? "/";
      seen.push({
        method: req.method ?? "",
        path,
        session: req.headers["mcp-session-id"] as string | undefined,
        protocol: req.headers["mcp-protocol-version"] as string | undefined,
        body,
      });
      if (path === "/auth") {
        res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="x"' });
        res.end();
        return;
      }
      if (path === "/html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>not mcp</html>");
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      const mode = path.startsWith("/sse") ? "sse" : "json";
      if (body?.method === "initialize") {
        const requested = body.params?.["protocolVersion"];
        if (path === "/old" && requested !== "2025-03-26") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32602, message: "Unsupported protocol version" },
            }),
          );
          return;
        }
        reply(
          res,
          mode,
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: requested,
              capabilities: { tools: {} },
              serverInfo: { name: "t", version: "1" },
            },
          },
          { "mcp-session-id": "sess-123" },
        );
        return;
      }
      if (body?.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (body?.method === "tools/list") {
        const cursor = Number(body.params?.["cursor"] ?? 0);
        const page = TOOLS.slice(cursor, cursor + 3);
        const next = cursor + 3 < TOOLS.length ? String(cursor + 3) : undefined;
        reply(res, mode, {
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: page, ...(next ? { nextCursor: next } : {}) },
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("MCP probe", () => {
  it("handshakes over JSON, follows nextCursor and carries the session id", async () => {
    seen.length = 0;
    const result = await probeMcpServer(`${base}/json`);
    expect(result).toEqual({
      ok: true,
      toolCount: 7,
      toolNames: TOOLS.map((tool) => tool.name),
      needsAuth: false,
      error: null,
    });
    const methods = seen.map((entry) => entry.body?.method ?? entry.method);
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/list",
      "tools/list",
      "DELETE",
    ]);
    expect(seen[0]?.body?.params?.["protocolVersion"]).toBe("2025-06-18");
    expect(seen.slice(1).every((entry) => entry.session === "sess-123")).toBe(true);
    expect(seen[2]?.protocol).toBe("2025-06-18");
    expect(seen[3]?.body?.params).toEqual({ cursor: "3" });
  });

  it("reads answers from an event stream without waiting for it to close", async () => {
    const started = Date.now();
    const result = await probeMcpServer(`${base}/sse`);
    expect(result.ok).toBe(true);
    expect(result.toolCount).toBe(7);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("falls back to protocol 2025-03-26", async () => {
    seen.length = 0;
    const result = await probeMcpServer(`${base}/old`);
    expect(result.ok).toBe(true);
    const versions = seen
      .filter((entry) => entry.body?.method === "initialize")
      .map((entry) => entry.body?.params?.["protocolVersion"]);
    expect(versions).toEqual(["2025-06-18", "2025-03-26"]);
  });

  it("reports a server that wants a sign-in as needsAuth", async () => {
    const result = await probeMcpServer(`${base}/auth`);
    expect(result).toMatchObject({ ok: false, needsAuth: true, toolCount: 0 });
  });

  it("explains a server that isn't MCP", async () => {
    const result = await probeMcpServer(`${base}/html`);
    expect(result.ok).toBe(false);
    expect(result.needsAuth).toBe(false);
    expect(result.error).toMatch(/isn't an MCP response/);
  });

  it("refuses non-http URLs and the cloud metadata address", async () => {
    expect((await probeMcpServer("file:///etc/passwd")).error).toMatch(/http/);
    expect((await probeMcpServer("http://169.254.169.254/latest/meta-data")).error).toMatch(
      /internal network/,
    );
    expect((await probeMcpServer("http://[fd00:ec2::254]/")).error).toMatch(/internal network/);
    // A public-looking name that resolves to the metadata address.
    const viaDns = await probeMcpServer("http://metadata.example.test/mcp", {
      lookup: async () => ["169.254.169.254"],
      fetch: (() => {
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
    });
    expect(viaDns.error).toMatch(/internal network/);
  });
});

describe("net guard", () => {
  it("knows link-local and metadata addresses in every spelling", () => {
    for (const address of [
      "169.254.169.254",
      "169.254.0.1",
      "fd00:ec2::254",
      "FD00:EC2:0:0:0:0:0:254",
      "fe80::1",
      "::ffff:169.254.169.254",
    ]) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "8.8.8.8",
      "::1",
      "2606:4700::1111",
      "fd00::1",
    ]) {
      expect(isForbiddenAddress(address), address).toBe(false);
    }
  });

  it("checks every redirect hop", async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest" },
      })) as unknown as typeof fetch;
    await expect(
      guardedFetch(
        "https://example.test/",
        { method: "GET" },
        {
          fetch: fetchImpl,
          lookup: async () => ["93.184.216.34"],
        },
      ),
    ).rejects.toBeInstanceOf(NetGuardError);
  });
});
