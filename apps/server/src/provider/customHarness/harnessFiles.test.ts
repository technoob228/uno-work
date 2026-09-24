import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { ServerSettings } from "@t3tools/contracts";
import { Schema } from "effect";

import { renderBundle } from "../../../scripts/embed-harness-guide.ts";
import { deriveProviderInstanceConfigMap } from "../Layers/ProviderInstanceRegistryHydration.ts";
import {
  harnessFileInstanceId,
  harnessFileToInstanceConfig,
  scanHarnessFiles,
} from "./harnessFiles.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

async function makeDir(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uno-harness-files-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(dir, name), body);
  }
  return dir;
}

describe("scanHarnessFiles", () => {
  it("loads valid files and reports invalid ones with a reason", async () => {
    const dir = await makeDir({
      "echo.json": JSON.stringify({
        name: "Echo",
        command: "node",
        args: ["/x/echo.mjs"],
        secretEnv: ["ECHO_KEY"],
      }),
      "broken.json": "{",
      "Bad Name.json": JSON.stringify({ command: "x" }),
      "shell.json": JSON.stringify({ command: "bash -c 'x'" }),
      "notes.txt": "ignored",
    });
    await mkdir(path.join(dir, "dir.json"));
    await symlink(path.join(dir, "echo.json"), path.join(dir, "link.json"));

    const scan = await scanHarnessFiles(dir);
    expect(scan.harnesses.map((harness) => harness.instanceId)).toEqual(["harness-echo"]);
    expect(scan.harnesses[0]!.filePath).toBe(path.join(dir, "echo.json"));
    const reasons = Object.fromEntries(scan.invalid.map((entry) => [entry.file, entry.reason]));
    expect(Object.keys(reasons).toSorted()).toEqual([
      "Bad Name.json",
      "broken.json",
      "dir.json",
      "link.json",
      "shell.json",
    ]);
    expect(reasons["link.json"]).toMatch(/symlink/);
  });

  it("treats a missing folder as empty", async () => {
    const scan = await scanHarnessFiles(path.join(os.tmpdir(), "does-not-exist-uno-harnesses"));
    expect(scan).toEqual({ harnesses: [], invalid: [] });
  });
});

describe("harness file → registry envelope", () => {
  it("carries plain env, secret values from the store, and settings win on id clash", async () => {
    const dir = await makeDir({
      "kimi.json": JSON.stringify({
        name: "Kimi",
        command: "kimi",
        args: ["acp"],
        env: { LOG: "warn" },
        secretEnv: ["MOONSHOT_API_KEY", "OTHER"],
      }),
    });
    const [harness] = (await scanHarnessFiles(dir)).harnesses;
    const envelope = harnessFileToInstanceConfig(
      harness!,
      new Map([["MOONSHOT_API_KEY", "sk-secret"]]),
    );
    expect(envelope.driver).toBe("acp");
    expect(envelope.displayName).toBe("Kimi");
    expect(envelope.environment).toEqual([
      { name: "LOG", value: "warn", sensitive: false },
      { name: "MOONSHOT_API_KEY", value: "sk-secret", sensitive: true },
      { name: "OTHER", value: "", sensitive: true },
    ]);

    const settings = Schema.decodeSync(ServerSettings)({});
    const map = deriveProviderInstanceConfigMap(settings, {
      [harnessFileInstanceId("kimi")]: envelope,
    });
    expect(map[harnessFileInstanceId("kimi")]?.displayName).toBe("Kimi");

    const overridden = deriveProviderInstanceConfigMap(
      Schema.decodeSync(ServerSettings)({
        providerInstances: {
          "harness-kimi": { driver: "acp", displayName: "Mine", config: { command: "kimi" } },
        },
      }),
      { [harnessFileInstanceId("kimi")]: envelope },
    );
    expect(overridden[harnessFileInstanceId("kimi")]?.displayName).toBe("Mine");
  });
});

describe("embedded harness guide", () => {
  it("matches docs/custom-harness.md and the echo example (run apps/server/scripts/embed-harness-guide.ts)", () => {
    const expected = renderBundle((file) => readFileSync(path.join(root, file), "utf8"));
    const actual = readFileSync(
      path.join(root, "apps/server/src/provider/customHarness/harnessGuide.generated.ts"),
      "utf8",
    );
    expect(actual).toBe(expected);
  });
});
