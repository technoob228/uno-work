import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Exit, Fiber } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_DATA_CHUNK_BYTES } from "./channel.ts";
import {
  base64,
  computerRow,
  startFakeConsole,
  waitFor,
  type FakeConsole,
  type Frame,
} from "./fakeConsole.testkit.ts";
import {
  createMyComputerCore,
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_MAX_TIMEOUT_MS,
  MAX_FILE_BYTES,
  parseComputers,
  pickComputer,
  type MyComputerCoreOptions,
} from "./myComputerCore.ts";
import { myComputerShape } from "./MyComputerService.ts";
import { OUTPUT_LIMIT_BYTES } from "./outputCollector.ts";

let fake: FakeConsole;
let stateDir: string;
let cores: Array<{ closeAll: () => void }>;

beforeEach(async () => {
  fake = await startFakeConsole();
  fake.listing = { status: 200, body: { enabled: true, computers: [computerRow()] } };
  stateDir = mkdtempSync(path.join(os.tmpdir(), "my-computer-core-"));
  cores = [];
});
afterEach(async () => {
  for (const core of cores) core.closeAll();
  await fake.close();
  rmSync(stateDir, { recursive: true, force: true });
});

const makeCore = (overrides: Partial<MyComputerCoreOptions> = {}) => {
  const core = createMyComputerCore({
    token: async () => fake.token,
    baseUrl: () => fake.baseUrl,
    stateDir,
    ...overrides,
  });
  cores.push(core);
  return core;
};

const ops = (name: string) => fake.frames().filter((frame) => frame.op === name);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the console's routes", () => {
  it("is off without a machine token: nothing is asked, nothing is logged", async () => {
    const warnings: Array<string> = [];
    const core = makeCore({ token: async () => "", warn: (message) => warnings.push(message) });
    await expect(core.status()).resolves.toEqual({ enabled: false, computers: [] });
    await expect(core.toolsVisible()).resolves.toBe(false);
    await expect(core.pair()).rejects.toThrow(/isn't linked to the Uno console/);
    expect(fake.requests).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("speaks the six routes with the machine token", async () => {
    const core = makeCore();
    await expect(core.status()).resolves.toMatchObject({
      enabled: true,
      computers: [{ id: "c1", name: "Work laptop", online: true, helperVersion: "0.1.0" }],
    });
    await expect(core.pair()).resolves.toMatchObject({
      code: "7KQ2-M9XD",
      commands: { mac: "curl mac", linux: "curl linux", windows: "irm windows" },
      // §4.3: the desktop installs the helper with these.
      api: "https://app.uno4.work",
      download: "https://app.uno4.work/cli/connect",
    });
    await expect(core.pairStatus("7KQ2-M9XD")).resolves.toEqual({
      state: "claimed",
      step: "done",
      message: null,
      computerId: "7",
    });
    await core.disconnect("c1");

    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /api/v1/work/computers",
      // M7: pairing registers this computer's public key first.
      "PUT /api/v1/work/computers/box-key",
      "POST /api/v1/work/computers/pair",
      "GET /api/v1/work/computers/pair/7KQ2-M9XD",
      "DELETE /api/v1/work/computers/c1",
    ]);
    expect(new Set(fake.requests.map((request) => request.authorization))).toEqual(
      new Set([`Bearer ${fake.token}`]),
    );
  });

  it("an older console reads as off, a broken one as an error", async () => {
    const core = makeCore();
    fake.listing = { status: 404, body: { code: "not_found" } };
    await expect(core.status()).resolves.toEqual({ enabled: false, computers: [] });
    fake.listing = { status: 500, body: { message: "database is down" } };
    await expect(core.status()).rejects.toThrow(/database is down/);
  });

  it("a console that is down reads as a short break, not a code", async () => {
    fake.listing = { status: 502, body: {} };
    await expect(makeCore().status()).rejects.toThrow(/restarting or unavailable.*try again/);
  });

  it("tools show only with the feature on and a computer connected, and the answer is cached", async () => {
    const core = makeCore({ timings: { toolsVisibleTtlMs: 60_000 } });
    await expect(core.toolsVisible()).resolves.toBe(true);
    await expect(core.toolsVisible()).resolves.toBe(true);
    expect(fake.requests).toHaveLength(1);

    const empty = makeCore();
    fake.listing = { status: 200, body: { enabled: true, computers: [] } };
    await expect(empty.toolsVisible()).resolves.toBe(false);

    const disabled = makeCore();
    fake.listing = { status: 200, body: { enabled: false, computers: [computerRow()] } };
    await expect(disabled.toolsVisible()).resolves.toBe(false);
  });

  it("connecting a computer shows the tools at once; a console that fails hides them quietly", async () => {
    fake.listing = { status: 200, body: { enabled: true, computers: [] } };
    const core = makeCore();
    await expect(core.toolsVisible()).resolves.toBe(false);
    fake.listing = { status: 200, body: { enabled: true, computers: [computerRow()] } };
    await core.pairStatus("7KQ2-M9XD");
    await expect(core.toolsVisible()).resolves.toBe(true);

    const fresh = makeCore();
    fake.listing = { status: 500, body: {} };
    await expect(fresh.toolsVisible()).resolves.toBe(false);
  });

  it("a slow console doesn't hold up tools/list", async () => {
    const stuck = makeCore({
      fetchImpl: (() => new Promise(() => undefined)) as unknown as typeof fetch,
      timings: { toolsVisibleWaitMs: 20 },
    });
    await expect(stuck.toolsVisible()).resolves.toBe(false);
  });
});

describe("picking a computer", () => {
  const status = (...rows: Array<Frame>) => parseComputers({ enabled: true, computers: rows });
  const laptop = computerRow();
  const desktop = computerRow({ id: "c2", name: "Desktop" });

  it("takes the only one without being told", () => {
    expect(pickComputer(status(laptop), undefined).id).toBe("c1");
  });

  it("with several: names them, and finds one by name or id", () => {
    expect(() => pickComputer(status(laptop, desktop), undefined)).toThrow(
      /several computers.*Work laptop \(id c1, online\).*Desktop \(id c2, online\)/,
    );
    expect(pickComputer(status(laptop, desktop), "desktop").id).toBe("c2");
    expect(pickComputer(status(laptop, desktop), "c1").id).toBe("c1");
  });

  it("an unknown name lists what there is; a shared name asks for the id", () => {
    expect(() => pickComputer(status(laptop, desktop), "Phone")).toThrow(
      /No connected computer is called “Phone”.*Work laptop.*Desktop/,
    );
    const twin = computerRow({ id: "c3" });
    expect(() => pickComputer(status(laptop, twin), "Work laptop")).toThrow(/by its id.*c1.*c3/);
  });

  it("an offline one: ask the person to open it", () => {
    const asleep = computerRow({ online: false });
    expect(() => pickComputer(status(asleep), undefined)).toThrow(
      "“Work laptop” is asleep or offline. Ask the person to open it, then try again.",
    );
  });

  it("nothing connected, or the feature off: says how to connect", () => {
    expect(() => pickComputer(status(), undefined)).toThrow(/No computer of the person/);
    expect(() =>
      pickComputer(
        { enabled: false, computers: [parseComputers({ computers: [laptop] }).computers[0]!] },
        undefined,
      ),
    ).toThrow(/No computer of the person/);
  });
});

describe("running a command", () => {
  const exec = (cmd = "ls", extra: { timeoutMs?: number } = {}) => ({
    computerId: "c1",
    cmd,
    ...extra,
  });

  it("collects the output and the exit, with the default timeout", async () => {
    fake.helper = (frame, reply) => {
      reply({ type: "started", pid: 42 });
      reply({ type: "out", stream: 1, data: base64("hello ") });
      reply({ type: "out", stream: 2, data: base64("world") });
      reply({ type: "exit", code: 3, signal: null });
      expect(frame.timeoutMs).toBe(EXEC_DEFAULT_TIMEOUT_MS);
    };
    const result = await makeCore().exec({ ...exec(), cwd: "~/projects" });
    expect(result).toMatchObject({
      exitCode: 3,
      signal: null,
      timedOut: false,
      text: "hello world",
      cutBytes: 0,
    });
    expect(ops("exec")[0]).toMatchObject({ cmd: "ls", cwd: "~/projects", v: 1 });
  });

  it("cuts the output at the caller's limit", async () => {
    fake.helper = (_frame, reply) => {
      reply({ type: "out", data: base64("x".repeat(1_000)) });
      reply({ type: "exit", code: 0 });
    };
    const result = await makeCore().exec({ ...exec(), maxOutputBytes: 100 });
    expect(result.cutBytes).toBe(900);
  });

  it("two commands run side by side on one socket", async () => {
    const waiting: Array<() => void> = [];
    fake.helper = (frame, reply) => {
      waiting.push(() => {
        reply({ type: "out", data: base64(String(frame.cmd)) });
        reply({ type: "exit", code: 0 });
      });
    };
    const core = makeCore();
    const first = core.exec(exec("first"));
    const second = core.exec(exec("second"));
    await waitFor(() => waiting.length === 2, "both commands");
    waiting[1]!();
    await expect(second).resolves.toMatchObject({ text: "second" });
    waiting[0]!();
    await expect(first).resolves.toMatchObject({ text: "first" });
    expect(fake.channels).toHaveLength(1);
  });

  it("keeps the start and the end of a long output, and says what was cut", async () => {
    fake.helper = (_frame, reply) => {
      reply({ type: "out", data: base64("START") });
      reply({ type: "out", data: base64("x".repeat(150_000)) });
      reply({ type: "out", data: base64("y".repeat(150_000)) });
      reply({ type: "out", data: base64("END") });
      reply({ type: "exit", code: 0 });
    };
    const result = await makeCore().exec(exec());
    expect(result.text.startsWith("START")).toBe(true);
    expect(result.text.endsWith("END")).toBe(true);
    expect(result.cutBytes).toBeGreaterThan(200_000);
    expect(result.text).toContain(`${result.cutBytes} bytes of output cut from the middle`);
    expect(Buffer.byteLength(result.text)).toBeLessThan(OUTPUT_LIMIT_BYTES + 100);
  });

  it("the longest timeout is 30 minutes", async () => {
    fake.helper = (_frame, reply) => reply({ type: "exit", code: 0 });
    await makeCore().exec(exec("ls", { timeoutMs: 24 * 3_600_000 }));
    expect(ops("exec")[0]!.timeoutMs).toBe(EXEC_MAX_TIMEOUT_MS);
  });

  it("the helper's own timeout comes back as timedOut", async () => {
    fake.helper = (_frame, reply) => reply({ type: "exit", code: null, timedOut: true });
    await expect(makeCore().exec(exec("sleep 9", { timeoutMs: 50 }))).resolves.toMatchObject({
      timedOut: true,
      exitCode: null,
    });
  });

  it("a helper that goes silent past the timeout gets `kill`, then a hard kill, and the call ends", async () => {
    fake.helper = (_frame, reply) => reply({ type: "started", pid: 1 });
    const core = makeCore({ timings: { execBackstopMs: 10, killGraceMs: 30 } });
    const result = await core.exec(exec("sleep 9", { timeoutMs: 20 }));
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    await waitFor(() => ops("kill").length === 2, "the hard kill");
    expect(ops("kill").map((frame) => frame.signal)).toEqual([undefined, "SIGKILL"]);
    expect(ops("kill")[0]!.id).toBe(ops("exec")[0]!.id);
  });

  it("a computer that never started the command says so, not that it timed out", async () => {
    const core = makeCore({ timings: { execBackstopMs: 1, execStartTimeoutMs: 40 } });
    await expect(core.exec(exec("rm -rf old", { timeoutMs: 1 }))).rejects.toMatchObject({
      kind: "remote",
      message: expect.stringContaining("didn't start"),
    });
    await waitFor(() => ops("kill").length === 1, "the kill");
  });

  it("an aborted call sends `kill` and answers at once", async () => {
    const core = makeCore({ timings: { killGraceMs: 20 } });
    const controller = new AbortController();
    const running = core.exec(exec("sleep 9"), controller.signal);
    await waitFor(() => ops("exec").length === 1, "the command");
    controller.abort();
    await expect(running).rejects.toMatchObject({ kind: "cancelled" });
    await waitFor(() => ops("kill").length === 1, "the kill");
    expect(ops("kill")[0]!.id).toBe(ops("exec")[0]!.id);
    await waitFor(() => ops("kill").length === 2, "the hard kill");
    expect(ops("kill")[1]!.signal).toBe("SIGKILL");
  });

  it("no hard kill for a process that stopped on `kill`", async () => {
    fake.helper = (frame, reply) => {
      if (frame.op === "kill") reply({ type: "exit", code: null, signal: "SIGTERM" });
    };
    const core = makeCore({ timings: { killGraceMs: 30 } });
    const controller = new AbortController();
    const running = core.exec(exec("sleep 9"), controller.signal);
    await waitFor(() => ops("exec").length === 1, "the command");
    controller.abort();
    await expect(running).rejects.toMatchObject({ kind: "cancelled" });
    await sleep(70);
    expect(ops("kill")).toHaveLength(1);
  });

  it("interrupting the agent's call (the turn stopped) stops the process", async () => {
    const service = myComputerShape(makeCore({ timings: { killGraceMs: 5_000 } }));
    const fiber = Effect.runFork(service.exec(exec("sleep 9")));
    await waitFor(() => ops("exec").length === 1, "the command");
    const exit = await Effect.runPromise(
      Fiber.interrupt(fiber).pipe(Effect.as(fiber.pollUnsafe())),
    );
    expect(exit === undefined || Exit.hasInterrupts(exit)).toBe(true);
    await waitFor(() => ops("kill").length === 1, "the kill");
    expect(ops("kill")[0]!.id).toBe(ops("exec")[0]!.id);
  });

  it("a channel that closes mid-command ends the call with the reason", async () => {
    fake.helper = (frame, _reply, channel) => {
      if (frame.op === "exec") channel.close(4000, "tunnel replaced");
    };
    await expect(makeCore().exec(exec("sleep 9"))).rejects.toThrow(/tunnel replaced/);
  });

  it("the helper's refusal comes through as a sentence", async () => {
    fake.helper = (_frame, reply) =>
      reply({ type: "error", code: "bad_cwd", message: "no such folder: ~/nope" });
    await expect(makeCore().exec(exec())).rejects.toThrow(
      "The computer answered: no such folder: ~/nope",
    );
  });

  it("a computer that can't be reached: the same plain sentence", async () => {
    fake.refuseUpgrade = 503;
    await expect(makeCore().exec(exec())).rejects.toThrow(/asleep or offline/);
  });

  it("a new channel opens after the old one closed", async () => {
    fake.helper = (_frame, reply) => reply({ type: "exit", code: 0 });
    // Not 10 ms: the idle clock starts when the channel opens, and the journal
    // line written before the command (a disk write) can take longer than that
    // on a slow box — the channel then closed before its first command (seen on
    // the work-build box, 14.11). Production waits 60 s.
    const core = makeCore({ timings: { idleCloseMs: 250 } });
    await core.exec(exec());
    await waitFor(() => fake.channels[0]!.closed(), "the idle close");
    await core.exec(exec());
    expect(fake.channels).toHaveLength(2);
  });

  it("disconnecting a computer ends what runs there", async () => {
    const core = makeCore();
    const running = core.exec(exec("sleep 9"));
    await waitFor(() => ops("exec").length === 1, "the command");
    await core.disconnect("c1");
    await expect(running).rejects.toMatchObject({ kind: "revoked" });
  });
});

describe("files", () => {
  it("reads a big file in chunks and puts it back together", async () => {
    const file = Buffer.alloc(MAX_DATA_CHUNK_BYTES * 2 + 1234);
    for (let index = 0; index < file.length; index += 1) file[index] = index % 251;
    fake.helper = (frame, reply) => {
      const offset = frame.offset as number;
      const chunk = file.subarray(offset, offset + (frame.length as number));
      reply({ type: "result", data: base64(chunk), eof: offset + chunk.length >= file.length });
    };
    const result = await makeCore().read({
      computerId: "c1",
      path: "~/big.bin",
      maxBytes: MAX_FILE_BYTES,
    });
    expect(result.eof).toBe(true);
    expect(result.data.equals(file)).toBe(true);
    expect(ops("read").map((frame) => frame.offset)).toEqual([
      0,
      MAX_DATA_CHUNK_BYTES,
      MAX_DATA_CHUNK_BYTES * 2,
    ]);
    for (const frame of ops("read")) {
      expect(frame.length as number).toBeLessThanOrEqual(MAX_DATA_CHUNK_BYTES);
    }
  });

  it("stops at maxBytes, from an offset, and says the file goes on", async () => {
    fake.helper = (frame, reply) =>
      reply({ type: "result", data: base64(Buffer.alloc(frame.length as number, 7)) });
    const result = await makeCore().read({
      computerId: "c1",
      path: "a",
      offset: 100,
      maxBytes: 10,
    });
    expect(result).toMatchObject({ offset: 100, eof: false });
    expect(result.data.length).toBe(10);
    expect(ops("read")).toHaveLength(1);
    expect(ops("read")[0]).toMatchObject({ offset: 100, length: 10 });
  });

  it("an empty answer is the end, for a helper that doesn't send eof", async () => {
    fake.helper = (frame, reply) =>
      reply({ type: "result", data: frame.offset === 0 ? base64("short") : "" });
    const result = await makeCore().read({ computerId: "c1", path: "a", maxBytes: 1_000_000 });
    expect(result).toMatchObject({ eof: true });
    expect(result.data.toString()).toBe("short");
  });

  it("writes a big file in chunks: the first replaces, the rest append", async () => {
    const written: Array<Buffer> = [];
    fake.helper = (frame, reply) => {
      written.push(Buffer.from(frame.data as string, "base64"));
      reply({ type: "result" });
    };
    const file = Buffer.alloc(MAX_DATA_CHUNK_BYTES * 2 + 5, 9);
    await expect(
      makeCore().write({ computerId: "c1", path: "~/a/b.bin", data: file, mkdirs: true }),
    ).resolves.toEqual({ bytes: file.length });

    const frames = ops("write");
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({ path: "~/a/b.bin", mkdirs: true });
    expect(frames[0]!.append).toBeUndefined();
    expect(frames[1]).toMatchObject({ append: true });
    expect(frames[1]!.mkdirs).toBeUndefined();
    expect(frames[2]).toMatchObject({ append: true });
    expect(Buffer.concat(written).equals(file)).toBe(true);
  });

  it("an empty file is still written, and `append` holds from the first chunk", async () => {
    fake.helper = (_frame, reply) => reply({ type: "result" });
    const core = makeCore();
    await core.write({ computerId: "c1", path: "empty", data: Buffer.alloc(0) });
    await core.write({ computerId: "c1", path: "log", data: Buffer.from("x"), append: true });
    expect(ops("write")[0]).toMatchObject({ path: "empty", data: "" });
    expect(ops("write")[1]).toMatchObject({ path: "log", append: true });
  });

  it("over the limit: refused before anything moves, and the agent reads the limit", async () => {
    await expect(
      makeCore().write({
        computerId: "c1",
        path: "a",
        data: Buffer.alloc(MAX_FILE_BYTES + 1),
      }),
    ).rejects.toThrow(/up to 52428800 bytes \(50 MiB\)/);
    expect(fake.channels).toEqual([]);
  });

  it("a write that fails halfway says the file is incomplete", async () => {
    let count = 0;
    fake.helper = (_frame, reply) => {
      count += 1;
      if (count === 1) reply({ type: "result" });
      else reply({ type: "error", code: "disk_full", message: "no space left" });
    };
    await expect(
      makeCore().write({
        computerId: "c1",
        path: "a",
        data: Buffer.alloc(MAX_DATA_CHUNK_BYTES + 1),
      }),
    ).rejects.toThrow(
      new RegExp(
        `no space left Only ${MAX_DATA_CHUNK_BYTES} of .* the file on the computer is incomplete`,
      ),
    );
  });

  it("list, stat and info pass the helper's answer on", async () => {
    fake.helper = (frame, reply) => reply({ type: "result", echoed: frame.op, entries: [] });
    const core = makeCore();
    await expect(core.list({ computerId: "c1", path: "~" })).resolves.toMatchObject({
      echoed: "list",
    });
    await expect(core.stat({ computerId: "c1", path: "~" })).resolves.toMatchObject({
      echoed: "stat",
    });
    await expect(core.info("c1")).resolves.toMatchObject({ echoed: "info" });
  });

  it("info tells about the computer, not about the frame it came in", async () => {
    fake.helper = (_frame, reply) => reply({ type: "result", ch: 1, v: 1, home: "/home/me" });
    await expect(makeCore().info("c1")).resolves.toEqual({ home: "/home/me" });
  });

  it("a silent helper fails the file call, with a hint", async () => {
    await expect(
      makeCore({ timings: { fileOpTimeoutMs: 20 } }).list({ computerId: "c1", path: "~" }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("an aborted read stops asking", async () => {
    const controller = new AbortController();
    const reading = makeCore().read(
      { computerId: "c1", path: "a", maxBytes: 10 },
      controller.signal,
    );
    await waitFor(() => ops("read").length === 1, "the read");
    controller.abort();
    await expect(reading).rejects.toMatchObject({ kind: "cancelled" });
  });
});

describe("the journal", () => {
  it("keeps what ran, masked and clipped, with the chat; never the output or a file", async () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
    fake.helper = (frame, reply) => {
      if (frame.op === "exec") {
        reply({ type: "out", data: base64("OUTPUT-IS-PRIVATE") });
        reply({ type: "exit", code: 0 });
      } else if (frame.op === "read") {
        reply({ type: "result", data: base64("FILE-IS-PRIVATE"), eof: true });
      } else {
        reply({ type: "result", entries: [] });
      }
    };
    const core = makeCore();
    await core.exec({
      computerId: "c1",
      cmd: `API_KEY=${secret} curl -H "Authorization: Bearer abc.def" https://x.test ${"y ".repeat(200)}`,
      threadId: "thread-1",
    });
    await core.read({ computerId: "c1", path: "~/a.txt", maxBytes: 100, threadId: "thread-1" });
    await core.write({
      computerId: "c1",
      path: "~/b.txt",
      data: Buffer.from("CONTENT-IS-PRIVATE"),
      threadId: "thread-2",
    });
    await core.list({ computerId: "c1", path: "~/docs" });

    const entries = await core.activity("c1");
    expect(entries.map((entry) => entry.kind)).toEqual(["list", "write", "read", "run"]);
    expect(entries[0]!.threadId).toBeUndefined();
    expect(entries[1]).toMatchObject({ summary: "~/b.txt (18 bytes)", threadId: "thread-2" });
    expect(entries[2]).toMatchObject({ summary: "~/a.txt" });
    const ran = entries[3]!.summary;
    expect(ran).toContain("API_KEY=[redacted]");
    expect(ran).toContain("Bearer [redacted]");
    expect(ran).not.toContain(secret);
    expect(ran.length).toBeLessThanOrEqual(200);
    expect(Date.parse(entries[3]!.at)).not.toBeNaN();

    const [file] = readdirSync(path.join(stateDir, "my-computer"));
    const disk = path.join(stateDir, "my-computer", file!);
    const raw = readFileSync(disk, "utf8");
    expect(raw).not.toContain("PRIVATE");
    expect(raw).not.toContain(secret);
    expect(statSync(disk).mode & 0o777).toBe(0o600);
  });

  it("a batch writes one line of its own, not one per call", async () => {
    fake.helper = (frame, reply) => {
      if (frame.op === "exec") {
        reply({ type: "exit", code: 0 });
      } else if (frame.op === "read") {
        reply({ type: "result", data: base64("x"), eof: true });
      } else {
        reply({ type: "result", entries: [] });
      }
    };
    const core = makeCore();
    await core.exec({ computerId: "c1", cmd: "ls", quiet: true });
    await core.read({ computerId: "c1", path: "~/a.txt", maxBytes: 10, quiet: true });
    await core.list({ computerId: "c1", path: "~/docs", quiet: true });
    await core.note("c1", "read", "Looked for chats");

    const entries = await core.activity("c1");
    expect(entries.map((entry) => entry.summary)).toEqual(["Looked for chats"]);
  });

  it("the line is there before the command leaves", async () => {
    let linesAtExec = -1;
    const core = makeCore();
    fake.helper = (_frame, reply) => {
      linesAtExec = readdirSync(path.join(stateDir, "my-computer")).length;
      reply({ type: "exit", code: 0 });
    };
    await core.exec({ computerId: "c1", cmd: "ls" });
    expect(linesAtExec).toBe(1);
  });

  it("a journal that can't be written warns and doesn't stop the work", async () => {
    const warnings: Array<string> = [];
    fake.helper = (_frame, reply) => reply({ type: "exit", code: 0 });
    const blocked = path.join(stateDir, "not-a-folder");
    writeFileSync(blocked, "");
    const core = makeCore({ stateDir: blocked, warn: (message) => warnings.push(message) });
    await expect(core.exec({ computerId: "c1", cmd: "ls" })).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("ls");
  });

  it("no journal of another computer", async () => {
    await expect(makeCore().activity("never-seen")).resolves.toEqual([]);
  });
});
