import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  isInstallableDriver,
  resolveInstallPlan,
  userLocalNpmPrefix,
} from "./harnessInstallCommands.ts";

const driver = (value: string) => ProviderDriverKind.make(value);

const baseContext = {
  platform: "linux" as NodeJS.Platform,
  homeDir: "/home/unowork",
  npmGlobalWritable: true,
  uvAvailable: true,
};

describe("isInstallableDriver", () => {
  it("covers every harness we ship an installer for", () => {
    for (const value of ["codex", "claudeAgent", "opencode", "hermes", "cursor"]) {
      expect(isInstallableDriver(driver(value))).toBe(true);
    }
    expect(isInstallableDriver(driver("uno"))).toBe(false);
    expect(isInstallableDriver(driver("grok"))).toBe(false);
  });
});

describe("resolveInstallPlan", () => {
  it("installs npm harnesses into the global prefix when it is writable", () => {
    const plan = resolveInstallPlan(driver("codex"), baseContext);
    expect(plan).toEqual({
      kind: "command",
      command: "npm",
      args: ["install", "-g", "@openai/codex"],
      env: {},
      display: "npm install -g @openai/codex",
    });
  });

  it("falls back to a user-writable prefix when the global prefix is read-only", () => {
    const plan = resolveInstallPlan(driver("claudeAgent"), {
      ...baseContext,
      npmGlobalWritable: false,
    });
    if (plan.kind !== "command") throw new Error("expected a command plan");
    expect(plan.env.npm_config_prefix).toBe(userLocalNpmPrefix("/home/unowork"));
    expect(plan.args).toEqual(["install", "-g", "@anthropic-ai/claude-code"]);
    expect(plan.display).toContain("npm_config_prefix=/home/unowork/.local");
  });

  it("maps each npm-backed driver to its package", () => {
    const packageFor = (value: string) => {
      const plan = resolveInstallPlan(driver(value), baseContext);
      return plan.kind === "command" ? plan.args.at(-1) : plan.reason;
    };
    expect(packageFor("codex")).toBe("@openai/codex");
    expect(packageFor("claudeAgent")).toBe("@anthropic-ai/claude-code");
    expect(packageFor("opencode")).toBe("opencode-ai");
  });

  it("installs hermes through uv, passing the extras and mcp pin unquoted", () => {
    const plan = resolveInstallPlan(driver("hermes"), baseContext);
    if (plan.kind !== "command") throw new Error("expected a command plan");
    expect(plan.command).toBe("uv");
    expect(plan.args).toEqual([
      "tool",
      "install",
      "--force",
      "--python",
      "3.12",
      "hermes-agent[acp]",
      "--with",
      "mcp>=1.9,<2",
    ]);
  });

  it("bootstraps uv with astral's user-level installer when uv is missing on unix", () => {
    const plan = resolveInstallPlan(driver("hermes"), { ...baseContext, uvAvailable: false });
    if (plan.kind !== "command") throw new Error("expected a command plan");
    expect(plan.command).toBe("sh");
    expect(plan.args[0]).toBe("-c");
    expect(plan.args[1]).toContain("https://astral.sh/uv/install.sh");
    expect(plan.args[1]).toContain(
      "'/home/unowork/.local/bin/uv' 'tool' 'install' '--force' '--python' '3.12' 'hermes-agent[acp]' '--with' 'mcp>=1.9,<2'",
    );
  });

  it("reports uv as missing on windows instead of guessing another installer", () => {
    const plan = resolveInstallPlan(driver("hermes"), {
      ...baseContext,
      platform: "win32",
      uvAvailable: false,
    });
    expect(plan.kind).toBe("unsupported");
    if (plan.kind === "unsupported") expect(plan.reason).toContain("uv");
  });

  it("runs the cursor installer script through bash on unix", () => {
    const plan = resolveInstallPlan(driver("cursor"), baseContext);
    if (plan.kind !== "command") throw new Error("expected a command plan");
    expect(plan.command).toBe("bash");
    expect(plan.args).toEqual(["-c", "curl https://cursor.com/install -fsS | bash"]);
  });

  it("refuses the cursor script on windows", () => {
    expect(resolveInstallPlan(driver("cursor"), { ...baseContext, platform: "win32" }).kind).toBe(
      "unsupported",
    );
  });

  it("refuses uno (bundled) and unknown drivers", () => {
    const uno = resolveInstallPlan(driver("uno"), baseContext);
    expect(uno.kind).toBe("unsupported");
    if (uno.kind === "unsupported") expect(uno.reason).toContain("ships with Uno Work");
    expect(resolveInstallPlan(driver("grok"), baseContext).kind).toBe("unsupported");
  });
});
