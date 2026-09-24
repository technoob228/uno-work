import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  autoApprovedPermissionOption,
  discoverSessionModels,
  resolveHarnessCwd,
  resolveHarnessExecutable,
  selectPermissionOptionForDecision,
} from "./CustomAcpSupport.ts";

const request = (
  kind: EffectAcpSchema.ToolKind | undefined,
  options: EffectAcpSchema.RequestPermissionRequest["options"],
): EffectAcpSchema.RequestPermissionRequest => ({
  sessionId: "s",
  toolCall: { toolCallId: "t", ...(kind ? { kind } : {}) },
  options,
});

const FULL_OPTIONS = [
  { optionId: "ok-once", name: "Allow", kind: "allow_once" },
  { optionId: "ok-always", name: "Always", kind: "allow_always" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
  { optionId: "never", name: "Never", kind: "reject_always" },
] as const;

describe("permission mapping by kind", () => {
  it("maps each decision to the agent's own option id", () => {
    const req = request("edit", [...FULL_OPTIONS]);
    expect(selectPermissionOptionForDecision(req, "accept")).toBe("ok-once");
    expect(selectPermissionOptionForDecision(req, "acceptForSession")).toBe("ok-always");
    expect(selectPermissionOptionForDecision(req, "decline")).toBe("no");
    expect(selectPermissionOptionForDecision(req, "cancel")).toBeUndefined();
  });

  it("falls back to the closest kind, or cancels when none matches", () => {
    const onlyAlways = request("edit", [
      { optionId: "a", name: "Always", kind: "allow_always" },
      { optionId: "r", name: "Never", kind: "reject_always" },
    ]);
    expect(selectPermissionOptionForDecision(onlyAlways, "accept")).toBe("a");
    expect(selectPermissionOptionForDecision(onlyAlways, "decline")).toBe("r");
    const onlyAllow = request("edit", [{ optionId: "a", name: "Allow", kind: "allow_once" }]);
    expect(selectPermissionOptionForDecision(onlyAllow, "decline")).toBeUndefined();
  });

  it("auto-approves by access mode", () => {
    expect(autoApprovedPermissionOption(request("execute", [...FULL_OPTIONS]), "full-access")).toBe(
      "ok-once",
    );
    expect(
      autoApprovedPermissionOption(request("edit", [...FULL_OPTIONS]), "auto-accept-edits"),
    ).toBe("ok-once");
    expect(
      autoApprovedPermissionOption(request("execute", [...FULL_OPTIONS]), "auto-accept-edits"),
    ).toBeUndefined();
    expect(
      autoApprovedPermissionOption(request("edit", [...FULL_OPTIONS]), "approval-required"),
    ).toBeUndefined();
  });
});

describe("discoverSessionModels", () => {
  it("prefers a model config option", () => {
    const discovered = discoverSessionModels({
      sessionId: "s",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "fast",
          options: [
            { value: "fast", name: "Fast" },
            { value: "smart", name: "Smart" },
          ],
        },
      ],
      models: { currentModelId: "x", availableModels: [{ modelId: "x", name: "X" }] },
    });
    expect(discovered).toEqual({
      source: "configOption",
      configId: "model",
      current: "fast",
      models: [
        { id: "fast", name: "Fast" },
        { id: "smart", name: "Smart" },
      ],
    });
  });

  it("falls back to the unstable models state, then to none", () => {
    expect(
      discoverSessionModels({
        sessionId: "s",
        models: { currentModelId: "k2", availableModels: [{ modelId: "k2", name: "Kimi K2" }] },
      }),
    ).toEqual({ source: "sessionModels", current: "k2", models: [{ id: "k2", name: "Kimi K2" }] });
    expect(discoverSessionModels({ sessionId: "s" })).toEqual({ source: "none", models: [] });
  });
});

describe("resolveHarnessCwd / resolveHarnessExecutable", () => {
  it("resolves the working folder", () => {
    const base = { customDirectory: "" };
    expect(resolveHarnessCwd({ ...base, workingDirectory: "project" }, "/p", "/h")).toBe("/p");
    expect(resolveHarnessCwd({ ...base, workingDirectory: "home" }, "/p", "/h")).toBe("/h");
    expect(
      resolveHarnessCwd({ workingDirectory: "custom", customDirectory: "~/agents" }, "/p", "/h"),
    ).toBe("/h/agents");
  });

  it("finds executables on PATH, in ~/.local/bin and by absolute path", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "uno-harness-home-"));
    const bin = path.join(home, "bin");
    const localBin = path.join(home, ".local", "bin");
    await import("node:fs/promises").then(async (fs) => {
      await fs.mkdir(bin, { recursive: true });
      await fs.mkdir(localBin, { recursive: true });
    });
    const onPath = path.join(bin, "my-agent");
    const inLocal = path.join(localBin, "local-agent");
    const notExec = path.join(bin, "plain-file");
    for (const file of [onPath, inLocal, notExec]) await writeFile(file, "#!/bin/sh\n");
    await chmod(onPath, 0o755);
    await chmod(inLocal, 0o755);

    const env = { PATH: bin };
    expect(await resolveHarnessExecutable("my-agent", env, home)).toEqual({
      ok: true,
      path: onPath,
    });
    expect(await resolveHarnessExecutable("local-agent", env, home)).toEqual({
      ok: true,
      path: inLocal,
    });
    expect((await resolveHarnessExecutable("plain-file", env, home)).ok).toBe(false);
    expect(await resolveHarnessExecutable("~/bin/my-agent", env, home)).toEqual({
      ok: true,
      path: onPath,
    });
    expect((await resolveHarnessExecutable("missing-agent", env, home)).ok).toBe(false);
  });
});
