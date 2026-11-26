/**
 * The real probe against a fake `codex app-server`: a model list our schema
 * cannot read must not hide a working sign-in (20.11, codex 0.167.2 sent
 * `inputModalities: [..., "audio"]` and Work showed "Sign in needed"), and a
 * probe that times out must not leave its process behind (26.11, 78 of them
 * filled a 4 GB machine in 20 hours).
 */
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { afterAll } from "vitest";

import { checkCodexProviderStatus } from "./CodexProvider.ts";

const FAKE_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      return send({ id: message.id, result: { userAgent: "codex/9.9.9", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
    case "account/read":
      return send({ id: message.id, result: { account: { type: "chatgpt", email: "person@example.com", planType: "pro" }, requiresOpenaiAuth: true } });
    case "model/list":
      return send({ id: message.id, result: { data: "a shape this Work does not know" } });
    case "skills/list":
      return send({ id: message.id, result: { data: [] } });
    default:
      return send({ id: message.id, error: { code: -32601, message: "unknown method" } });
  }
});
`;

// Starts, says who it is in the pid file, and never answers a request.
const SILENT_CODEX = `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.FAKE_CODEX_PID_FILE, process.pid + "\\n");
process.stdin.resume();
setInterval(() => {}, 1000);
`;

function writeFakeCodex(source: string = FAKE_CODEX): string {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "fake-codex-"));
  const binaryPath = NodePath.join(dir, "codex");
  NodeFs.writeFileSync(binaryPath, source, { mode: 0o755 });
  return binaryPath;
}

const readPids = (pidFile: string): ReadonlyArray<number> =>
  NodeFs.existsSync(pidFile)
    ? NodeFs.readFileSync(pidFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map(Number)
    : [];

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Real time, not the test clock: the child needs it to start.
const waitForPids = (pidFile: string, count: number) =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 400 && readPids(pidFile).length < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return readPids(pidFile);
  });

const startedPids: number[] = [];
afterAll(() => {
  for (const pid of startedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone, which is the point of the test
    }
  }
});

it.layer(NodeServices.layer)("codex probe", (it) => {
  describe("checkCodexProviderStatus with a real app-server process", () => {
    it.effect("keeps a signed-in account when model/list cannot be decoded", () =>
      Effect.gen(function* () {
        const settings = Schema.decodeSync(CodexSettings)({
          binaryPath: writeFakeCodex(),
          customModels: ["my-model"],
        });
        const status = yield* checkCodexProviderStatus(settings, undefined, process.env);

        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.email, "person@example.com");
        assert.strictEqual(status.status, "ready");
        assert.deepStrictEqual(
          status.models.map((model) => model.slug),
          ["my-model"],
        );
      }),
    );

    it.effect("leaves no app-server behind when the probe times out twice", () =>
      Effect.gen(function* () {
        const binaryPath = writeFakeCodex(SILENT_CODEX);
        const pidFile = NodePath.join(NodePath.dirname(binaryPath), "pids");
        const settings = Schema.decodeSync(CodexSettings)({ binaryPath });
        const fiber = yield* checkCodexProviderStatus(settings, undefined, {
          ...process.env,
          FAKE_CODEX_PID_FILE: pidFile,
        }).pipe(Effect.forkChild);

        const first = yield* waitForPids(pidFile, 1);
        startedPids.push(...first);
        assert.strictEqual(first.length, 1);
        yield* TestClock.adjust("8 seconds");
        // The one retry on a missed window.
        const both = yield* waitForPids(pidFile, 2);
        startedPids.push(...both);
        assert.strictEqual(both.length, 2);
        yield* TestClock.adjust("8 seconds");
        const status = yield* Fiber.join(fiber);

        assert.strictEqual(
          status.message,
          "Timed out while checking Codex app-server provider status.",
        );
        assert.deepStrictEqual(both.filter(isAlive), []);
      }),
    );
  });
});
