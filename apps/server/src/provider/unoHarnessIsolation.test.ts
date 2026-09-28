import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  UNO_HARNESS_SHELL_ENV_RESTORE,
  UNO_HARNESS_SHELL_ENV_RESTORE_PLUGIN_SOURCE,
  ensureUnoShellEnvRestorePlugin,
  isUpstreamOpenCodeBinary,
  resolveUnoHarnessBinary,
  unoUpstreamIsolationEnvironment,
} from "./unoHarnessIsolation.ts";

const forkPath = "/home/u/.unowork/uno-code/bin/uno-code";
const upstreamPath = "/home/u/.unowork/opencode/bin/opencode";
const everyPathExists = () => true;

describe("resolveUnoHarnessBinary", () => {
  it("prefers the bundled stock opencode when it is installed", () => {
    expect(
      resolveUnoHarnessBinary({
        configured: undefined,
        forkPath,
        upstreamPath,
        exists: (p) => p === upstreamPath,
      }),
    ).toEqual({ binaryPath: upstreamPath, kind: "upstream" });
  });

  it("falls back to the legacy fork when stock opencode is not installed", () => {
    expect(
      resolveUnoHarnessBinary({ configured: "", forkPath, upstreamPath, exists: () => false }),
    ).toEqual({ binaryPath: forkPath, kind: "fork" });
  });

  it("ignores schema fallback markers and stale absolute paths", () => {
    for (const configured of ["opencode", "uno-code", "/gone/opencode"]) {
      expect(
        resolveUnoHarnessBinary({
          configured,
          forkPath,
          upstreamPath,
          exists: (p) => p === forkPath,
        }),
      ).toEqual({ binaryPath: forkPath, kind: "fork" });
    }
  });

  it("keeps an explicit binary and classifies it by name", () => {
    const exists = everyPathExists;
    expect(
      resolveUnoHarnessBinary({ configured: "/opt/oc/opencode", forkPath, upstreamPath, exists }),
    ).toEqual({ binaryPath: "/opt/oc/opencode", kind: "upstream" });
    expect(
      resolveUnoHarnessBinary({ configured: "/opt/uc/uno-code", forkPath, upstreamPath, exists }),
    ).toEqual({ binaryPath: "/opt/uc/uno-code", kind: "fork" });
  });

  it("recognises opencode binaries on Windows", () => {
    expect(isUpstreamOpenCodeBinary("C:\\oc\\opencode.exe")).toBe(true);
    expect(isUpstreamOpenCodeBinary("C:\\oc\\uno-code.exe")).toBe(false);
  });
});

describe("unoUpstreamIsolationEnvironment", () => {
  it("points XDG into the private home and remembers the user's values", () => {
    const env = unoUpstreamIsolationEnvironment("/h/.unowork/opencode-home", {
      XDG_CONFIG_HOME: "/h/.cfg",
    });
    expect(env).toMatchObject({
      XDG_CONFIG_HOME: "/h/.unowork/opencode-home/config",
      XDG_DATA_HOME: "/h/.unowork/opencode-home/data",
      XDG_CACHE_HOME: "/h/.unowork/opencode-home/cache",
      XDG_STATE_HOME: "/h/.unowork/opencode-home/state",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    });
    expect(JSON.parse(env[UNO_HARNESS_SHELL_ENV_RESTORE]!)).toEqual({
      XDG_CONFIG_HOME: "/h/.cfg",
      XDG_DATA_HOME: "",
      XDG_CACHE_HOME: "",
      XDG_STATE_HOME: "",
    });
  });
});

describe("shell env restore plugin", () => {
  it("writes the plugin once and restores the user's XDG values in agent shells", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uno-restore-"));
    try {
      const url = ensureUnoShellEnvRestorePlugin(dir);
      const file = path.join(dir, "uno-work-shell-env-restore.mjs");
      expect(url).toBe(pathToFileURL(file).href);
      expect(fs.readFileSync(file, "utf8")).toBe(UNO_HARNESS_SHELL_ENV_RESTORE_PLUGIN_SOURCE);
      expect(ensureUnoShellEnvRestorePlugin(dir)).toBe(url);

      const previous = process.env[UNO_HARNESS_SHELL_ENV_RESTORE];
      process.env[UNO_HARNESS_SHELL_ENV_RESTORE] = JSON.stringify({
        XDG_CONFIG_HOME: "/h/.cfg",
        XDG_DATA_HOME: "",
      });
      try {
        const mod = (await import(url)) as {
          UnoWorkShellEnvRestore: () => Promise<{
            "shell.env": (input: unknown, output: { env: Record<string, string> }) => Promise<void>;
          }>;
        };
        const hooks = await mod.UnoWorkShellEnvRestore();
        const output = { env: { XDG_DATA_HOME: "/session/own" } };
        await hooks["shell.env"]({}, output);
        expect(output.env).toEqual({ XDG_CONFIG_HOME: "/h/.cfg", XDG_DATA_HOME: "/session/own" });
      } finally {
        if (previous === undefined) delete process.env[UNO_HARNESS_SHELL_ENV_RESTORE];
        else process.env[UNO_HARNESS_SHELL_ENV_RESTORE] = previous;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
