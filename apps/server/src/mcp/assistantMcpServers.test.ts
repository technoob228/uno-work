import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  addAssistantMcpServer,
  assistantMcpFile,
  normalizeAssistantMcpServers,
  readAssistantMcpServers,
  toAssistantMcpView,
  updateAssistantMcpServers,
} from "./assistantMcpStore.ts";
import {
  CustomMcpServers,
  CustomMcpServersLive,
  mergeSessionCustomServers,
} from "./customMcpServers.ts";

const owners = [
  { name: "docs", url: "https://mcp.docs.dev/mcp", enabled: true },
  { name: "crm", url: "https://owner-crm.dev/mcp/s/OWNERKEY", enabled: true },
];
const ada = [
  { name: "crm", url: "https://ada-crm.dev/mcp/s/ADAKEY", enabled: true },
  { name: "linear", url: "https://mcp.linear.app/sse", enabled: true },
];

describe("assistant MCP: which servers a session gets", () => {
  it("the person's own chat: the owner's servers only", () => {
    expect(mergeSessionCustomServers({ owner: owners, assistant: [], sandboxed: false })).toEqual(
      owners,
    );
  });

  it("an assistant's chat: the owner's + its own; its own win a name clash", () => {
    expect(
      mergeSessionCustomServers({ owner: owners, assistant: ada, sandboxed: false }).map(
        (server) => server.url,
      ),
    ).toEqual(["https://mcp.docs.dev/mcp", ...ada.map((server) => server.url)]);
  });

  it("a sandboxed assistant's chat: its own servers, never the owner's", () => {
    expect(mergeSessionCustomServers({ owner: owners, assistant: ada, sandboxed: true })).toEqual(
      ada,
    );
    expect(mergeSessionCustomServers({ owner: owners, assistant: [], sandboxed: true })).toEqual(
      [],
    );
  });

  it("never lets an assistant's server take the built-in uno-work name", () => {
    const sneaky = [{ name: "uno-work", url: "https://evil.dev/mcp", enabled: true }];
    expect(mergeSessionCustomServers({ owner: [], assistant: sneaky, sandboxed: true })).toEqual(
      [],
    );
  });
});

describe("assistant MCP store", () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "assistant-mcp-"));
  });
  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("adds with a name from the address, refuses duplicates and junk", () => {
    const first = addAssistantMcpServer([], { url: "https://mcp.linear.app/sse" });
    expect(first).toMatchObject({ ok: true, name: "linear" });
    if (!first.ok) throw new Error("unreachable");
    expect(addAssistantMcpServer(first.servers, { url: "https://mcp.linear.app/sse" })).toEqual({
      ok: false,
      code: "duplicate",
    });
    expect(addAssistantMcpServer([], { url: "file:///etc/passwd" })).toEqual({
      ok: false,
      code: "invalid_url",
    });
    expect(addAssistantMcpServer([], { url: "https://x.dev/mcp", name: "uno-work" })).toEqual({
      ok: false,
      code: "invalid_name",
    });
    const second = addAssistantMcpServer(first.servers, { url: "https://linear.app/other" });
    expect(second).toMatchObject({ ok: true, name: "linear-2" });
  });

  it("normalizes what is on disk: junk, duplicates and the built-in name dropped", () => {
    expect(
      normalizeAssistantMcpServers({
        servers: [
          { name: "a", url: "https://a.dev/mcp" },
          { name: "a", url: "https://a2.dev/mcp" },
          { name: "uno-work", url: "https://x.dev" },
          { name: "BAD NAME", url: "https://b.dev" },
          { name: "c", url: "javascript:alert(1)" },
          { name: "d", url: "https://d.dev/mcp", enabled: false },
        ],
      }),
    ).toEqual([
      { name: "a", url: "https://a.dev/mcp", enabled: true },
      { name: "d", url: "https://d.dev/mcp", enabled: false },
    ]);
  });

  it("the API view shows the host only: an address may carry the key", () => {
    expect(toAssistantMcpView(ada[0]!)).toEqual({
      name: "crm",
      host: "ada-crm.dev",
      enabled: true,
    });
    expect(JSON.stringify(toAssistantMcpView(ada[0]!))).not.toContain("ADAKEY");
  });

  it("writes a 0600 file per assistant, outside its folder", async () => {
    await updateAssistantMcpServers(stateDir, "assistant-ada", (current) => {
      const result = addAssistantMcpServer(current, { url: ada[0]!.url });
      return { servers: result.ok ? result.servers : null, result };
    });
    const file = assistantMcpFile(stateDir, "assistant-ada");
    expect(file).toBe(nodePath.join(stateDir, "assistants", "assistant-ada", "mcp.json"));
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    expect(await readAssistantMcpServers(stateDir, "assistant-ada")).toEqual([
      { name: "ada-crm", url: ada[0]!.url, enabled: true },
    ]);
    expect(await readAssistantMcpServers(stateDir, "assistant-mia")).toEqual([]);
  });

  it("the live service: a noted assistant's chat gets its servers, the person's chat doesn't", async () => {
    await updateAssistantMcpServers(stateDir, "assistant-ada", () => ({
      servers: ada,
      result: null,
    }));
    const layer = CustomMcpServersLive.pipe(
      Layer.provide(ServerSettingsService.layerTest({ mcpServers: owners })),
      Layer.provide(Layer.succeed(ServerConfig, { stateDir } as unknown as ServerConfigShape)),
    );
    const names = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CustomMcpServers;
        yield* service.noteSessionAssistant("thread-ada", "assistant-ada");
        yield* service.noteSessionAssistant("thread-mine", null);
        const of = (threadId: string, sandboxed = false) =>
          service.forSession({ threadId, sandboxed }).map((server) => server.url);
        return {
          ada: of("thread-ada"),
          adaSandboxed: of("thread-ada", true),
          mine: of("thread-mine"),
          unknown: of("thread-unknown"),
          noContext: service.forSession().map((server) => server.name),
        };
      }).pipe(Effect.provide(layer), Effect.scoped),
    );
    expect(names.ada).toEqual(["https://mcp.docs.dev/mcp", ...ada.map((server) => server.url)]);
    expect(names.adaSandboxed).toEqual(ada.map((server) => server.url));
    expect(names.mine).toEqual(owners.map((server) => server.url));
    expect(names.unknown).toEqual(owners.map((server) => server.url));
    expect(names.noContext).toEqual(["docs", "crm"]);
  });

  it("a thread noted again as the person's own chat loses the assistant's servers", async () => {
    await updateAssistantMcpServers(stateDir, "assistant-ada", () => ({
      servers: ada,
      result: null,
    }));
    const layer = CustomMcpServersLive.pipe(
      Layer.provide(ServerSettingsService.layerTest({ mcpServers: [] })),
      Layer.provide(Layer.succeed(ServerConfig, { stateDir } as unknown as ServerConfigShape)),
    );
    const after = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CustomMcpServers;
        yield* service.noteSessionAssistant("t1", "assistant-ada");
        yield* service.noteSessionAssistant("t1", null);
        return service.forSession({ threadId: "t1", sandboxed: true });
      }).pipe(Effect.provide(layer), Effect.scoped),
    );
    expect(after).toEqual([]);
  });
});
