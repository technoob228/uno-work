import { describe, expect, it } from "vitest";

import {
  findAssistantWorkspace,
  readManagerEndpoint,
  runAssistantTurnCli,
  scheduledTurnUrl,
  type AssistantTurnCliDeps,
} from "./assistantTurnCli.ts";

const mcpJson = (token = "uwm_secret") =>
  JSON.stringify({
    mcpServers: {
      "uno-manager": {
        type: "http",
        url: "http://127.0.0.1:13773/api/manager/mcp",
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  });

function fakeFs(files: Record<string, string>, options: { denied?: ReadonlyArray<string> } = {}) {
  const denied = new Set(options.denied ?? []);
  const deny = (path: string) => {
    if ([...denied].some((prefix) => path.startsWith(prefix))) {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }
  };
  return {
    readFile: async (path: string) => {
      deny(path);
      const value = files[path];
      if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return value;
    },
    listDirs: async (path: string) => {
      deny(path);
      const prefix = `${path}/`;
      const names = new Set(
        Object.keys(files)
          .filter((file) => file.startsWith(prefix))
          .map((file) => file.slice(prefix.length).split("/")[0]!)
          .filter((name) => !name.includes(".")),
      );
      if (names.size === 0) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return [...names];
    },
  };
}

const deps = (
  files: Record<string, string>,
  fetchImpl: AssistantTurnCliDeps["fetchImpl"] = async () => new Response("{}"),
  options: { denied?: ReadonlyArray<string>; env?: NodeJS.ProcessEnv } = {},
): AssistantTurnCliDeps => ({
  ...fakeFs(files, options),
  fetchImpl,
  env: options.env ?? {},
  homes: ["/root", "/home/unowork"],
});

const HOME = "/home/unowork/UnoWork/Assistants/home";

describe("assistant-turn CLI", () => {
  it("reads the uno-manager endpoint from .mcp.json", () => {
    expect(readManagerEndpoint(mcpJson())).toEqual({
      url: "http://127.0.0.1:13773/api/manager/mcp",
      authorization: "Bearer uwm_secret",
    });
    expect(readManagerEndpoint("{}")).toBeNull();
    expect(readManagerEndpoint("not json")).toBeNull();
    expect(scheduledTurnUrl("http://127.0.0.1:13773/api/manager/mcp")).toBe(
      "http://127.0.0.1:13773/api/manager/assistant/scheduled-turn",
    );
  });

  it("finds the one assistant, prefers the default one among several", async () => {
    expect(
      await findAssistantWorkspace(deps({ [`${HOME}/.mcp.json`]: mcpJson() }), undefined),
    ).toBe(HOME);
    const two = deps({
      [`${HOME}/.mcp.json`]: mcpJson(),
      [`${HOME}/.uno-assistant.json`]: JSON.stringify({ projectId: "assistant-home" }),
      "/home/unowork/UnoWork/Assistants/liza/.mcp.json": mcpJson("uwm_other"),
      "/home/unowork/UnoWork/Assistants/liza/.uno-assistant.json": JSON.stringify({
        projectId: "assistant-liza",
      }),
    });
    expect(await findAssistantWorkspace(two, undefined)).toBe(HOME);
    expect(await findAssistantWorkspace(two, "/explicit")).toBe("/explicit");
    await expect(findAssistantWorkspace(deps({}), undefined)).rejects.toThrow(/No assistant/);
  });

  it("asks the daemon with the assistant's token and waits for the answer", async () => {
    const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const outcome = await runAssistantTurnCli(
      { prompt: "  Morning brief  ", name: "Brief", timeoutSec: 600 },
      deps({ [`${HOME}/.mcp.json`]: mcpJson() }, async (url, init) => {
        seen.push({
          url: String(url),
          auth: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({ status: "delivered", threadId: "t1", delivered: 1 }));
      }),
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain("delivered");
    expect(outcome.output).not.toContain("uwm_secret");
    expect(seen).toEqual([
      {
        url: "http://127.0.0.1:13773/api/manager/assistant/scheduled-turn",
        auth: "Bearer uwm_secret",
        body: { prompt: "Morning brief", name: "Brief", timeoutSec: 600 },
      },
    ]);
  });

  it("fails loudly on a timeout, an error answer, a dead daemon, an unreadable folder", async () => {
    const files = { [`${HOME}/.mcp.json`]: mcpJson() };
    const timeout = await runAssistantTurnCli(
      { prompt: "x" },
      deps(files, async () => new Response(JSON.stringify({ status: "timeout" }))),
    );
    expect(timeout.exitCode).toBe(1);
    const refused = await runAssistantTurnCli(
      { prompt: "x" },
      deps(files, async () => new Response(JSON.stringify({ error: "busy" }), { status: 409 })),
    );
    expect(refused).toMatchObject({ exitCode: 1, output: "Assistant turn failed: busy" });
    const dead = await runAssistantTurnCli(
      { prompt: "x" },
      deps(files, async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(dead.output).toContain("isn't running");
    const denied = await runAssistantTurnCli(
      { prompt: "x" },
      deps(files, undefined, { denied: ["/home/unowork"] }),
    );
    expect(denied).toMatchObject({ exitCode: 1, permissionDenied: true });
    expect((await runAssistantTurnCli({ prompt: "  " }, deps(files))).exitCode).toBe(2);
  });
});
