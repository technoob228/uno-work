import { describe, expect, it } from "vitest";

import {
  formatCommandLine,
  harnessIdFromName,
  parseHarnessFile,
  splitCommandLine,
  validateHarnessConfig,
  validateHarnessExecutable,
} from "./customHarness.ts";

const file = (value: unknown) => JSON.stringify(value);

describe("splitCommandLine", () => {
  it("splits plain words and honours quotes and escapes", () => {
    expect(splitCommandLine(`gemini --acp`)).toEqual({ ok: true, value: ["gemini", "--acp"] });
    expect(splitCommandLine(`node "/My Agents/a.mjs" 'it''s' a\\ b ""`)).toEqual({
      ok: true,
      value: ["node", "/My Agents/a.mjs", "its", "a b", ""],
    });
  });

  it("rejects shell operators instead of passing them through", () => {
    for (const line of ["a | b", "a; rm -rf ~", "a && b", "a > out", "echo `id`", "echo $(id)"]) {
      const result = splitCommandLine(line);
      expect(result.ok, line).toBe(false);
    }
    expect(splitCommandLine(`"unterminated`).ok).toBe(false);
  });

  it("keeps operators that are inside quotes as literal text", () => {
    expect(splitCommandLine(`agent --prompt "a|b; c"`)).toEqual({
      ok: true,
      value: ["agent", "--prompt", "a|b; c"],
    });
  });

  it("round-trips through formatCommandLine", () => {
    const argv = ["node", "/My Agents/a.mjs", "it's", "--flag=x"];
    const formatted = formatCommandLine(argv);
    expect(splitCommandLine(formatted)).toEqual({ ok: true, value: argv });
  });
});

describe("validateHarnessExecutable", () => {
  it("accepts absolute paths, ~/ paths and bare names", () => {
    for (const command of ["/usr/local/bin/kimi", "~/bin/agent", "gemini", "claude-code-acp"]) {
      expect(validateHarnessExecutable(command).ok, command).toBe(true);
    }
  });

  it("rejects relative paths, traversal, shell lines and control characters", () => {
    for (const command of [
      "./agent",
      "bin/agent",
      "/opt/../etc/x",
      "gemini --acp",
      "a\u0007",
      "",
    ]) {
      expect(validateHarnessExecutable(command).ok, JSON.stringify(command)).toBe(false);
    }
  });
});

describe("parseHarnessFile", () => {
  it("normalizes a full file", () => {
    const result = parseHarnessFile(
      "gemini",
      file({
        name: "Gemini‮ CLI",
        icon: "✨",
        command: "gemini",
        args: ["--acp"],
        env: { LOG: "warn" },
        secretEnv: ["GEMINI_API_KEY"],
        workingDirectory: "~/agents",
        install: "npm install -g @google/gemini-cli",
        detect: ["gemini", "--version"],
        models: ["gemini-2.5-pro", { id: "flash", name: "Flash" }],
        authMethod: "gemini-api-key",
        shareUnoGateway: true,
        unknownFutureKey: 1,
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        id: "gemini",
        name: "Gemini CLI",
        env: [{ name: "LOG", value: "warn" }],
        secretEnv: ["GEMINI_API_KEY"],
        config: {
          enabled: true,
          command: "gemini",
          args: ["--acp"],
          workingDirectory: "custom",
          customDirectory: "~/agents",
          installCommand: ["npm", "install", "-g", "@google/gemini-cli"],
          detectCommand: ["gemini", "--version"],
          models: [{ id: "gemini-2.5-pro" }, { id: "flash", name: "Flash" }],
          authMethodId: "gemini-api-key",
          icon: "✨",
          description: "",
          shareUnoGateway: true,
          shareUnoAccount: false,
        },
      },
    });
  });

  it("defaults the name to the id and the folder to the project", () => {
    const result = parseHarnessFile("echo", file({ command: "node", args: ["/x/echo.mjs"] }));
    expect(result.ok && result.value.name).toBe("echo");
    expect(result.ok && result.value.config.workingDirectory).toBe("project");
  });

  it("rejects bad ids, JSON, commands and secrets in env", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["Bad Id", file({ command: "x" }), /file name/],
      ["ok", "{not json", /Not valid JSON/],
      ["ok", "[]", /JSON object/],
      ["ok", file({}), /command/],
      ["ok", file({ command: "sh -c 'curl x | sh'" }), /absolute path/],
      ["ok", file({ command: "x", args: "--acp" }), /list of strings/],
      ["ok", file({ command: "x", env: { KEY: { secret: true } } }), /secretEnv/],
      ["ok", file({ command: "x", env: { "BAD-NAME": "1" } }), /environment variable/],
      ["ok", file({ command: "x", secretEnv: ["A"], env: { A: "1" } }), /both/],
      ["ok", file({ command: "x", install: "curl https://x | sh" }), /shell/],
      ["ok", file({ command: "x", workingDirectory: "relative/dir" }), /workingDirectory/],
      ["ok", file({ command: "x", models: [{}] }), /id/],
    ];
    for (const [id, raw, reason] of cases) {
      const result = parseHarnessFile(id, raw);
      expect(result.ok, raw).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(reason);
    }
  });

  it("rejects oversized files", () => {
    const result = parseHarnessFile("big", file({ command: "x", description: "a".repeat(40_000) }));
    expect(result.ok).toBe(false);
  });

  it("drops unsafe icons", () => {
    const result = parseHarnessFile("x", file({ command: "x", icon: "<svg>" }));
    expect(result.ok && result.value.config.icon).toBe("");
  });
});

describe("validateHarnessConfig", () => {
  const base = {
    command: "gemini",
    args: ["--acp"],
    workingDirectory: "project" as const,
    customDirectory: "",
    installCommand: [],
    detectCommand: [],
  };
  it("accepts a valid config and rejects a relative command or folder", () => {
    expect(validateHarnessConfig(base).ok).toBe(true);
    expect(validateHarnessConfig({ ...base, command: "./gemini" }).ok).toBe(false);
    expect(
      validateHarnessConfig({ ...base, workingDirectory: "custom", customDirectory: "x" }).ok,
    ).toBe(false);
    expect(validateHarnessConfig({ ...base, detectCommand: ["../x"] }).ok).toBe(false);
  });
});

describe("harnessIdFromName", () => {
  it("makes slugs that start with a letter", () => {
    expect(harnessIdFromName("Kimi Code")).toBe("kimi-code");
    expect(harnessIdFromName("42 agent")).toBe("agent-42-agent");
    expect(harnessIdFromName("!!!")).toBe("agent-custom");
  });
});
