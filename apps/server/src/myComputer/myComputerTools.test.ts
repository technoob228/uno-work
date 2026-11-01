import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RuntimeMode, ServerSettings } from "@t3tools/contracts";
import { Effect, Fiber } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleMcpMessage } from "../mcp/mcpJsonRpc.ts";
import {
  buildUnoWorkMcpServer,
  isWorkerTool,
  runUnoWorkTool,
  UNO_WORK_TOOLS,
  UnoWorkToolError,
  type UnoWorkToolDeps,
} from "../unoWork/tools.ts";
import { makeCancellableCalls } from "./cancelCalls.ts";
import {
  base64,
  computerRow,
  startFakeConsole,
  waitFor,
  type FakeConsole,
} from "./fakeConsole.testkit.ts";
import { createMyComputerCore, MAX_FILE_BYTES } from "./myComputerCore.ts";
import { myComputerShape } from "./MyComputerService.ts";
import { MY_COMPUTER_TOOL_NAMES } from "./myComputerTools.ts";

let fake: FakeConsole;
let home: string;
let closers: Array<() => void>;

beforeEach(async () => {
  fake = await startFakeConsole();
  fake.listing = { status: 200, body: { enabled: true, computers: [computerRow()] } };
  fake.helper = (frame, reply) => {
    switch (frame.op) {
      case "exec":
        reply({ type: "out", stream: 1, data: base64("done") });
        reply({ type: "exit", code: 0 });
        break;
      case "read":
        reply({ type: "result", data: base64("hello"), eof: true });
        break;
      case "stat":
        reply({ type: "result", size: 5 });
        break;
      case "list":
        reply({ type: "result", entries: [{ name: "a.txt", size: 1 }] });
        break;
      case "info":
        reply({ type: "result", home: "/Users/me", shell: "/bin/zsh" });
        break;
      default:
        reply({ type: "result" });
    }
  };
  home = mkdtempSync(path.join(os.tmpdir(), "my-computer-tools-"));
  closers = [];
});
afterEach(async () => {
  for (const close of closers) close();
  await fake.close();
  rmSync(home, { recursive: true, force: true });
});

const service = () => {
  const core = createMyComputerCore({
    token: async () => fake.token,
    baseUrl: () => fake.baseUrl,
    stateDir: path.join(home, "state"),
    timings: { killGraceMs: 5_000 },
  });
  closers.push(core.closeAll);
  return myComputerShape(core);
};

interface Options {
  readonly runtimeMode?: RuntimeMode;
  readonly approval?: "approved" | "denied";
  readonly agentAccess?: "off" | "read" | "manage";
}

function makeDeps(options: Options = {}) {
  const approvals: Array<{ tool: string; level: string; title: string; detail?: string }> = [];
  const deps = {
    caller: {
      threadId: "thread-1",
      threadTitle: "Chat",
      runtimeMode: options.runtimeMode ?? "full-access",
      cwd: path.join(home, "projects", "notes"),
    },
    home,
    settings: Effect.succeed({
      uno: { agentAccess: options.agentAccess ?? "read" },
    } as unknown as ServerSettings),
    requestApproval: (input: { tool: string; level: string; title: string; detail?: string }) =>
      Effect.sync(() => {
        approvals.push({
          tool: input.tool,
          level: input.level,
          title: input.title,
          ...(input.detail ? { detail: input.detail } : {}),
        });
        return options.approval ?? "approved";
      }),
    myComputer: service(),
  } as unknown as UnoWorkToolDeps;
  return { deps, approvals };
}

const tool = (name: string) => {
  const found = UNO_WORK_TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No tool ${name}`);
  return found;
};

const run = (name: string, deps: UnoWorkToolDeps, args: unknown = {}) =>
  Effect.runPromise(Effect.result(runUnoWorkTool(tool(name), deps, args)));

const ok = async (name: string, deps: UnoWorkToolDeps, args: unknown = {}) => {
  const result = await run(name, deps, args);
  if (result._tag === "Failure") throw new Error(result.failure.message);
  return result.success as Record<string, unknown>;
};

const refusal = async (name: string, deps: UnoWorkToolDeps, args: unknown = {}) => {
  const result = await run(name, deps, args);
  if (result._tag === "Success") throw new Error(`${name} went through`);
  return result.failure.message;
};

const ops = (name: string) => fake.frames().filter((frame) => frame.op === name);
const cautious = (deps: UnoWorkToolDeps) => ({
  ...deps,
  asksFirst: Effect.succeed({ name: "Scout" }),
});

describe("the gate", () => {
  const RUN = { command: "ls" };
  const WRITE = { path: "~/a.txt", content: "hi" };

  it("Autonomous: commands and writes go at once", async () => {
    const { deps, approvals } = makeDeps({ runtimeMode: "full-access" });
    await ok("my_computer_run", deps, RUN);
    await ok("my_computer_write_file", deps, WRITE);
    expect(approvals).toEqual([]);
    expect(ops("exec")).toHaveLength(1);
    expect(ops("write")).toHaveLength(1);
  });

  it("Cautious: commands and writes ask, whatever the mode; the card says why", async () => {
    const { deps, approvals } = makeDeps({ runtimeMode: "full-access" });
    await ok("my_computer_run", cautious(deps), RUN);
    await ok("my_computer_write_file", cautious(deps), WRITE);
    expect(approvals.map((approval) => approval.tool)).toEqual([
      "my_computer_run",
      "my_computer_write_file",
    ]);
    expect(approvals[0]!.title).toBe("Run on your computer: ls");
    expect(approvals[0]!.detail).toContain("Scout is Cautious");
    expect(approvals[1]!.title).toBe("Write ~/a.txt on your computer");
  });

  it("Cautious doesn't ask to read or list", async () => {
    const { deps, approvals } = makeDeps({ runtimeMode: "full-access" });
    await ok("my_computers_list", cautious(deps));
    await ok("my_computer_list_files", cautious(deps), { path: "~" });
    await ok("my_computer_read_file", cautious(deps), { path: "~/a.txt" });
    expect(approvals).toEqual([]);
  });

  it("a declined card: nothing reaches the computer", async () => {
    const { deps } = makeDeps({ approval: "denied" });
    const message = await refusal("my_computer_run", cautious(deps), {
      command: "rm -rf ~/work",
    });
    expect(message).toContain("declined");
    expect(ops("exec")).toEqual([]);
  });

  it("the chat's mode: commands ask unless it has full access, writes only in Ask mode", async () => {
    const edits = makeDeps({ runtimeMode: "auto-accept-edits" });
    await ok("my_computer_run", edits.deps, RUN);
    await ok("my_computer_write_file", edits.deps, WRITE);
    expect(edits.approvals.map((approval) => approval.tool)).toEqual(["my_computer_run"]);

    const ask = makeDeps({ runtimeMode: "approval-required" });
    await ok("my_computer_run", ask.deps, RUN);
    await ok("my_computer_write_file", ask.deps, WRITE);
    await ok("my_computer_read_file", ask.deps, { path: "~/a.txt" });
    expect(ask.approvals.map((approval) => approval.tool)).toEqual([
      "my_computer_run",
      "my_computer_write_file",
    ]);
  });

  it("an Observer reads but neither runs nor writes", async () => {
    const { deps } = makeDeps();
    const observer = { ...deps, presetRefusal: Effect.succeed("Scout only reads.") };
    expect(await refusal("my_computer_run", observer, RUN)).toBe("Scout only reads.");
    expect(await refusal("my_computer_write_file", observer, WRITE)).toBe("Scout only reads.");
    expect(await refusal("my_computer_read_file", observer, { path: "a", saveTo: "b" })).toBe(
      "Scout only reads.",
    );
    await ok("my_computer_read_file", observer, { path: "a" });
  });

  it("an assistant held to selected projects doesn't reach the laptop at all", async () => {
    const { deps, approvals } = makeDeps();
    const held = {
      ...deps,
      caller: { ...deps.caller, boundary: { roots: [home], name: "Ada" } },
    };
    for (const [name, args] of [
      ["my_computers_list", {}],
      ["my_computer_run", RUN],
      ["my_computer_read_file", { path: "a" }],
      ["my_computer_write_file", WRITE],
      ["my_computer_list_files", {}],
    ] as const) {
      expect(await refusal(name, held, args)).toContain("Ada is held to selected projects");
    }
    expect(approvals).toEqual([]);
    expect(fake.channels).toEqual([]);
  });

  it("Agent access: off stops them too", async () => {
    const { deps } = makeDeps({ agentAccess: "off" });
    expect(await refusal("my_computers_list", deps)).toContain("agent access");
    expect(await refusal("my_computer_run", deps, RUN)).toContain("agent access");
    expect(fake.requests).toEqual([]);
  });

  it("a Helper can't run or write in the person's name past the orchestrator rule", () => {
    expect(isWorkerTool("my_computer_run", {})).toBe(true);
    expect(isWorkerTool("my_computer_write_file", {})).toBe(true);
    expect(isWorkerTool("my_computer_read_file", {})).toBe(false);
  });
});

describe("the approval card", () => {
  it("masks a secret in the command and clips a long one", async () => {
    const { deps, approvals } = makeDeps({ runtimeMode: "approval-required" });
    await ok("my_computer_run", deps, {
      command: `API_TOKEN=abc123 ./deploy.sh ${"--flag ".repeat(40)}`,
      cwd: "~/projects/site",
      computer: "Work laptop",
    });
    const card = approvals[0]!;
    expect(card.title.startsWith("Run on “Work laptop”: API_TOKEN=[redacted] ./deploy.sh")).toBe(
      true,
    );
    expect(card.title).not.toContain("abc123");
    expect(card.title.endsWith("…")).toBe(true);
    expect(card.detail).toContain("In ~/projects/site");
    // The command that left is the real one.
    expect(ops("exec")[0]!.cmd).toContain("API_TOKEN=abc123");
  });

  it("no card for a call that can't work", async () => {
    const { deps, approvals } = makeDeps({ runtimeMode: "approval-required" });
    fake.listing = {
      status: 200,
      body: { enabled: true, computers: [computerRow({ online: false })] },
    };
    expect(await refusal("my_computer_run", deps, { command: "ls" })).toContain(
      "asleep or offline",
    );
    expect(approvals).toEqual([]);
    expect(fake.channels).toEqual([]);
  });

  it("copying a file here is a change: it asks in Ask mode", async () => {
    const { deps, approvals } = makeDeps({ runtimeMode: "approval-required" });
    await ok("my_computer_read_file", deps, { path: "~/a.txt", saveTo: "~/copy.txt" });
    expect(approvals[0]!.title).toBe("Copy ~/a.txt from your computer to this one");
  });
});

describe("what the agent reads back", () => {
  it("my_computers_list: the computers, `details` asks the online ones", async () => {
    const { deps } = makeDeps();
    fake.listing = {
      status: 200,
      body: {
        enabled: true,
        computers: [computerRow(), computerRow({ id: "c2", name: "Desktop", online: false })],
      },
    };
    const plain = await ok("my_computers_list", deps);
    expect(plain.computers).toHaveLength(2);
    expect(fake.channels).toEqual([]);

    const detailed = await ok("my_computers_list", deps, { details: true });
    const computers = detailed.computers as Array<Record<string, unknown>>;
    expect(computers[0]!.info).toMatchObject({ home: "/Users/me" });
    expect(computers[1]!.info).toBeUndefined();
    expect(ops("info")).toHaveLength(1);
  });

  it("my_computers_list: nothing connected or the feature off is a note, not an error", async () => {
    const { deps } = makeDeps();
    fake.listing = { status: 200, body: { enabled: false, computers: [] } };
    expect(await ok("my_computers_list", deps)).toMatchObject({
      enabled: false,
      computers: [],
      note: expect.stringContaining("No computer is connected"),
    });
  });

  it("without a console the tools say so instead of crashing the turn", async () => {
    const { deps } = makeDeps();
    const { myComputer: _, ...rest } = deps;
    const message = await refusal("my_computer_run", rest as UnoWorkToolDeps, { command: "ls" });
    expect(message).toContain("can't reach the person's own computers");
  });

  it("several computers and no `computer`: the list, as an error the turn survives", async () => {
    const { deps } = makeDeps();
    fake.listing = {
      status: 200,
      body: {
        enabled: true,
        computers: [computerRow(), computerRow({ id: "c2", name: "Desktop" })],
      },
    };
    expect(await refusal("my_computer_run", deps, { command: "ls" })).toMatch(
      /several computers.*Work laptop.*Desktop/,
    );
    await ok("my_computer_run", deps, { command: "ls", computer: "Desktop" });
    expect(fake.channels[0]!.path).toBe("/api/v1/work/computers/c2/channel");
  });

  it("my_computer_run: exit code, output and how long", async () => {
    const { deps } = makeDeps();
    expect(await ok("my_computer_run", deps, { command: "ls", timeoutSeconds: 5 })).toMatchObject({
      computer: "Work laptop",
      exitCode: 0,
      timedOut: false,
      output: "done",
    });
    expect(ops("exec")[0]).toMatchObject({ cmd: "ls", timeoutMs: 5_000 });
    const over = await refusal("my_computer_run", deps, { command: "ls", timeoutSeconds: 1801 });
    expect(over).toContain("Invalid arguments");
  });

  it("my_computer_run: a timeout gets advice", async () => {
    const { deps } = makeDeps();
    fake.helper = (_frame, reply) => reply({ type: "exit", code: null, timedOut: true });
    expect(await ok("my_computer_run", deps, { command: "sleep 9" })).toMatchObject({
      timedOut: true,
      note: expect.stringContaining("longer timeoutSeconds"),
    });
  });

  it("my_computer_read_file: text, with the way to read on", async () => {
    const { deps } = makeDeps();
    fake.helper = (frame, reply) =>
      reply({ type: "result", data: base64("x".repeat(frame.length as number)) });
    const part = await ok("my_computer_read_file", deps, { path: "~/long.log", maxBytes: 4 });
    expect(part).toMatchObject({
      text: "xxxx",
      complete: false,
      note: expect.stringContaining("offset 4"),
    });
  });

  it("my_computer_read_file: a binary file doesn't flood the chat", async () => {
    const { deps } = makeDeps();
    fake.helper = (_frame, reply) =>
      reply({ type: "result", data: base64(Buffer.from([1, 0, 2])), eof: true });
    const answer = await ok("my_computer_read_file", deps, { path: "~/a.png" });
    expect(answer).toMatchObject({ binary: true, note: expect.stringContaining("saveTo") });
    expect(answer.text).toBeUndefined();
  });

  it("saveTo copies the file to this computer", async () => {
    const { deps } = makeDeps();
    const answer = await ok("my_computer_read_file", deps, {
      path: "~/a.txt",
      saveTo: "~/copied/a.txt",
    });
    expect(answer).toMatchObject({ savedTo: "~/copied/a.txt", bytes: 5 });
    expect(readFileSync(path.join(home, "copied", "a.txt"), "utf8")).toBe("hello");
  });

  it("saveTo: a file over the limit is refused, with the limit, before it moves", async () => {
    const { deps } = makeDeps();
    fake.helper = (frame, reply) => {
      if (frame.op === "stat") reply({ type: "result", size: MAX_FILE_BYTES + 1 });
    };
    const message = await refusal("my_computer_read_file", deps, {
      path: "~/movie.mp4",
      saveTo: "~/movie.mp4",
    });
    expect(message).toContain("50 MiB");
    expect(ops("read")).toEqual([]);
  });

  it("my_computer_write_file: text, or a file from here", async () => {
    const { deps } = makeDeps();
    await ok("my_computer_write_file", deps, { path: "~/a.txt", content: "héllo" });
    expect(Buffer.from(ops("write")[0]!.data as string, "base64").toString()).toBe("héllo");
    expect(ops("write")[0]).toMatchObject({ mkdirs: true });

    mkdirSync(path.join(home, "out"));
    writeFileSync(path.join(home, "out", "report.pdf"), Buffer.from([1, 2, 3]));
    await expect(
      ok("my_computer_write_file", deps, { path: "~/r.pdf", fromFile: "~/out/report.pdf" }),
    ).resolves.toMatchObject({ bytes: 3 });

    expect(await refusal("my_computer_write_file", deps, { path: "a" })).toContain("either");
    expect(
      await refusal("my_computer_write_file", deps, { path: "a", content: "x", fromFile: "b" }),
    ).toContain("either");
  });

  it("my_computer_list_files: capped, and from the home folder by default", async () => {
    const { deps } = makeDeps();
    fake.helper = (_frame, reply) =>
      reply({
        type: "result",
        entries: Array.from({ length: 700 }, (_, index) => ({ name: `f${index}` })),
      });
    const answer = await ok("my_computer_list_files", deps);
    expect(answer.path).toBe("~");
    expect(answer.entries).toHaveLength(500);
    expect(answer.note).toContain("500 of 700");
  });
});

describe("showing the tools", () => {
  const listed = async (hidden: ReadonlySet<string>) => {
    const outcome = await Effect.runPromise(
      handleMcpMessage(buildUnoWorkMcpServer([], hidden), undefined as unknown as UnoWorkToolDeps, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    );
    if (outcome.kind !== "response") throw new Error("no answer");
    const body = outcome.body as { result: { tools: Array<{ name: string }> } };
    return new Set(body.result.tools.map((entry) => entry.name));
  };

  it("hidden tools leave tools/list and nothing else does", async () => {
    const all = await listed(new Set());
    for (const name of MY_COMPUTER_TOOL_NAMES) expect(all.has(name)).toBe(true);
    const without = await listed(MY_COMPUTER_TOOL_NAMES);
    for (const name of MY_COMPUTER_TOOL_NAMES) expect(without.has(name)).toBe(false);
    expect(all.size - without.size).toBe(MY_COMPUTER_TOOL_NAMES.size);
  });

  it("a hidden tool still answers a chat that knew it, with its own error", async () => {
    const { deps } = makeDeps();
    fake.listing = { status: 200, body: { enabled: true, computers: [] } };
    const outcome = await Effect.runPromise(
      handleMcpMessage(buildUnoWorkMcpServer([], MY_COMPUTER_TOOL_NAMES), deps, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "my_computer_run", arguments: { command: "ls" } },
      }),
    );
    expect(JSON.stringify(outcome)).toContain("No computer of the person");
  });
});

describe("stopping a call", () => {
  it("notifications/cancelled stops the process on the computer", async () => {
    const calls = makeCancellableCalls();
    const { deps } = makeDeps();
    const running = Effect.runPromise(
      calls.run("client:7", runUnoWorkTool(tool("my_computer_run"), deps, { command: "x" }), {
        cancelled: true,
      }),
    );
    fake.helper = () => undefined;
    await waitFor(() => ops("exec").length === 1, "the command");
    calls.cancel("client:other");
    calls.cancel("client:7");
    await expect(running).resolves.toEqual({ cancelled: true });
    await waitFor(() => ops("kill").length === 1, "the kill");
    expect(ops("kill")[0]!.id).toBe(ops("exec")[0]!.id);
  });

  it("a stop in the middle of the Allow card: nothing leaves", async () => {
    const calls = makeCancellableCalls();
    const { deps } = makeDeps({ runtimeMode: "approval-required" });
    const waiting = {
      ...deps,
      requestApproval: () => Effect.never,
    } as unknown as UnoWorkToolDeps;
    const running = Effect.runPromise(
      calls.run("client:8", runUnoWorkTool(tool("my_computer_run"), waiting, { command: "x" }), {
        cancelled: true,
      }),
    );
    await waitFor(() => fake.requests.length === 1, "the check before the card");
    await new Promise((resolve) => setTimeout(resolve, 20));
    calls.cancel("client:8");
    await expect(running).resolves.toEqual({ cancelled: true });
    expect(ops("exec")).toEqual([]);
  });

  it("a finished call is forgotten, and a stale cancel is harmless", async () => {
    const calls = makeCancellableCalls();
    await expect(Effect.runPromise(calls.run("k", Effect.succeed(1), 0))).resolves.toBe(1);
    expect(() => calls.cancel("k")).not.toThrow();
    await expect(Effect.runPromise(calls.run("k", Effect.succeed(2), 0))).resolves.toBe(2);
  });

  it("a failing call fails as usual", async () => {
    const calls = makeCancellableCalls();
    const fiber = Effect.runFork(
      Effect.result(
        calls.run("k", Effect.fail(new UnoWorkToolError({ message: "no" })), "cancelled"),
      ),
    );
    const result = await Effect.runPromise(Fiber.join(fiber));
    expect(result._tag).toBe("Failure");
  });
});
