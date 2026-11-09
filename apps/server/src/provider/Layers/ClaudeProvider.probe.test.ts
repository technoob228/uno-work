/**
 * The capabilities probe (account + slash commands + the CLI's model list)
 * against a Claude Code that crashes or never answers: no list, no error —
 * the status check then falls back to the built-in models
 * (claudeModelCatalog.ts). Real child processes, a fake `claude`.
 */
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

import { probeClaudeCapabilities } from "./ClaudeProvider.ts";

const dir = mkdtempSync(join(tmpdir(), "claude-probe-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeClaude(name: string, body: string): ClaudeSettings {
  const binaryPath = join(dir, name);
  writeFileSync(binaryPath, `#!/bin/sh\n${body}\n`);
  chmodSync(binaryPath, 0o755);
  return Schema.decodeSync(ClaudeSettings)({ binaryPath });
}

describe("probeClaudeCapabilities", () => {
  it.live("answers nothing when Claude Code crashes on start", () =>
    Effect.gen(function* () {
      const probe = yield* probeClaudeCapabilities(fakeClaude("crash", "exit 3"), {
        PATH: process.env.PATH,
      });
      assert.strictEqual(probe, undefined);
    }).pipe(Effect.provide(NodePath.layer)),
  );

  it.effect("gives up after its timeout when Claude Code never answers", () =>
    Effect.gen(function* () {
      const fiber = yield* probeClaudeCapabilities(fakeClaude("hang", "sleep 30"), {
        PATH: process.env.PATH,
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("21 seconds");
      const probe = yield* Fiber.join(fiber);
      assert.strictEqual(probe, undefined);
    }).pipe(Effect.provide(NodePath.layer)),
  );
});
