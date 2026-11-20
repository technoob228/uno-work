/**
 * The real probe against a fake `codex app-server`: a model list our schema
 * cannot read must not hide a working sign-in (20.11, codex 0.167.2 sent
 * `inputModalities: [..., "audio"]` and Work showed "Sign in needed").
 */
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import { Effect, Schema } from "effect";

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

function writeFakeCodex(): string {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "fake-codex-"));
  const binaryPath = NodePath.join(dir, "codex");
  NodeFs.writeFileSync(binaryPath, FAKE_CODEX, { mode: 0o755 });
  return binaryPath;
}

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
  });
});
