import { ProviderDriverKind, type ProviderSetupJobId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  makeHarnessSetupRunner,
  type HarnessSetupRunner,
  type HarnessSetupRunnerDeps,
} from "./HarnessSetupService.ts";
import type { HarnessProcessSpawnInput } from "./harnessProcess.ts";

interface FakeProcess {
  readonly input: HarnessProcessSpawnInput;
  readonly stdin: string[];
  killed: boolean;
}

interface Harness {
  readonly runner: HarnessSetupRunner;
  readonly processes: FakeProcess[];
  readonly refreshed: string[];
  readonly storedKeys: string[];
  readonly latest: () => FakeProcess;
}

function makeHarness(overrides: Partial<HarnessSetupRunnerDeps> = {}): Harness {
  const processes: FakeProcess[] = [];
  const refreshed: string[] = [];
  const storedKeys: string[] = [];
  let counter = 0;

  const runner = makeHarnessSetupRunner({
    spawn: (input) => {
      const fake: FakeProcess = { input, stdin: [], killed: false };
      processes.push(fake);
      return {
        write: (data) => fake.stdin.push(data),
        endInput: () => {},
        kill: () => {
          fake.killed = true;
          input.onExit({ code: null, signal: "SIGTERM" });
        },
      };
    },
    platform: "linux",
    homeDir: "/home/unowork",
    baseEnv: { PATH: "/usr/bin" },
    probeNpmGlobalWritable: async () => false,
    probeUvAvailable: async () => true,
    resolveCliEnvironment: async (driver) => ({
      binaryPath: driver === "codex" ? "codex" : "claude",
      env: { CODEX_HOME: "/home/unowork/.codex" },
    }),
    storeClaudeApiKey: async (apiKey) => {
      storedKeys.push(apiKey);
    },
    refreshProvider: async (driver) => {
      refreshed.push(driver);
    },
    makeJobId: () => `job-${(counter += 1)}`,
    ...overrides,
  });

  return {
    runner,
    processes,
    refreshed,
    storedKeys,
    latest: () => {
      const last = processes.at(-1);
      if (!last) throw new Error("no process was spawned");
      return last;
    },
  };
}

/** Let the runner's queued microtasks (and the fake spawn) run. */
const tick = async (times = 4) => {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
};

const jobId = (value: string) => value as ProviderSetupJobId;

describe("install jobs", () => {
  it("runs the installer, captures output and refreshes the provider on success", async () => {
    const harness = makeHarness();
    const { jobId: id } = harness.runner.installStart({ driver: ProviderDriverKind.make("codex") });
    await tick();

    const process = harness.latest();
    expect(process.input.command).toBe("npm");
    expect(process.input.args).toEqual(["install", "-g", "@openai/codex"]);
    // Global prefix is not writable in this harness, so the user prefix is used.
    expect(process.input.env.npm_config_prefix).toBe("/home/unowork/.local");
    expect(process.input.env.PATH).toContain("/home/unowork/.local/bin");

    expect(harness.runner.installStatus({ jobId: id }).state).toBe("running");
    process.input.onOutput("added 1 package\n");
    process.input.onExit({ code: 0, signal: null });
    await harness.runner.drain();

    const status = harness.runner.installStatus({ jobId: id });
    expect(status.state).toBe("succeeded");
    expect(status.log).toContain("added 1 package");
    expect(status.command).toContain("npm install -g @openai/codex");
    expect(harness.refreshed).toEqual(["codex"]);
  });

  it("fails with the log tail when the installer exits non-zero", async () => {
    const harness = makeHarness();
    const { jobId: id } = harness.runner.installStart({
      driver: ProviderDriverKind.make("opencode"),
    });
    await tick();
    harness.latest().input.onOutput("npm ERR! EACCES permission denied\n");
    harness.latest().input.onExit({ code: 1, signal: null });
    await harness.runner.drain();

    const status = harness.runner.installStatus({ jobId: id });
    expect(status.state).toBe("failed");
    expect(status.error).toContain("code 1");
    expect(status.error).toContain("npm ERR! EACCES permission denied");
    expect(harness.refreshed).toEqual([]);
  });

  it("reports a missing binary rather than a bare exit code", async () => {
    const harness = makeHarness();
    const { jobId: id } = harness.runner.installStart({ driver: ProviderDriverKind.make("codex") });
    await tick();
    const error = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
    harness.latest().input.onExit({ code: null, signal: null, error });
    await harness.runner.drain();
    expect(harness.runner.installStatus({ jobId: id }).error).toContain("was not found");
  });

  it("rejects a second install for the same driver while one runs", async () => {
    const harness = makeHarness();
    harness.runner.installStart({ driver: ProviderDriverKind.make("codex") });
    await tick();
    expect(() => harness.runner.installStart({ driver: ProviderDriverKind.make("codex") })).toThrow(
      /already running/,
    );
    // A different driver is unaffected.
    expect(() =>
      harness.runner.installStart({ driver: ProviderDriverKind.make("hermes") }),
    ).not.toThrow();
  });

  it("rejects the bundled uno driver up front", () => {
    const harness = makeHarness();
    expect(() => harness.runner.installStart({ driver: ProviderDriverKind.make("uno") })).toThrow(
      /cannot be installed/,
    );
    expect(harness.processes).toHaveLength(0);
  });

  it("installs uv first when it is missing for hermes", async () => {
    const harness = makeHarness({ probeUvAvailable: async () => false });
    harness.runner.installStart({ driver: ProviderDriverKind.make("hermes") });
    await tick();
    expect(harness.processes).toHaveLength(1);
    expect(harness.latest().input.command).toBe("sh");
    expect(harness.latest().input.args.join(" ")).toContain("astral.sh/uv/install.sh");
    harness.latest().input.onExit({ code: 0, signal: null });
    await harness.runner.drain();
  });

  it("kills the child and fails when the install exceeds its timeout", async () => {
    const harness = makeHarness({ installTimeoutMs: 1 });
    const { jobId: id } = harness.runner.installStart({ driver: ProviderDriverKind.make("codex") });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.runner.drain();
    expect(harness.latest().killed).toBe(true);
    expect(harness.runner.installStatus({ jobId: id }).error).toContain("Timed out");
  });

  it("reports unknown job ids", () => {
    const harness = makeHarness();
    expect(() => harness.runner.installStatus({ jobId: jobId("nope") })).toThrow(/Unknown/);
  });
});

describe("auth jobs", () => {
  it("pipes the codex api key on stdin and never puts it in the log", async () => {
    const harness = makeHarness();
    const { jobId: id } = harness.runner.authStart({
      driver: "codex",
      method: "apiKey",
      apiKey: "sk-secret-value",
    });
    await tick();

    const process = harness.latest();
    expect(process.input.command).toBe("codex");
    expect(process.input.args).toEqual(["login", "--with-api-key"]);
    expect(process.stdin).toEqual(["sk-secret-value\n"]);
    process.input.onOutput("saved key sk-secret-value\n");
    process.input.onExit({ code: 0, signal: null });
    await harness.runner.drain();

    const status = harness.runner.authStatus({ jobId: id });
    expect(status.state).toBe("succeeded");
    expect(status.log).not.toContain("sk-secret-value");
    expect(status.log).toContain("[redacted]");
    expect(harness.refreshed).toEqual(["codex"]);
  });

  it("exposes the codex device URL and one-time code as they are printed", async () => {
    const harness = makeHarness();
    const { jobId: id } = harness.runner.authStart({ driver: "codex", method: "oauth" });
    await tick();
    expect(harness.latest().input.args).toEqual(["login", "--device-auth"]);

    harness
      .latest()
      .input.onOutput(
        "1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n",
      );
    harness.latest().input.onOutput("2. Enter this one-time code\n   41IV-83JI8\n");

    const waiting = harness.runner.authStatus({ jobId: id });
    expect(waiting.state).toBe("running");
    expect(waiting.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(waiting.userCode).toBe("41IV-83JI8");

    harness.latest().input.onExit({ code: 0, signal: null });
    await harness.runner.drain();
    expect(harness.runner.authStatus({ jobId: id }).state).toBe("succeeded");
  });

  it("stores the anthropic key in the instance environment without running a command", async () => {
    const harness = makeHarness();
    const { jobId: id } = harness.runner.authStart({
      driver: "claudeAgent",
      method: "apiKey",
      apiKey: "sk-ant-secret",
    });
    await harness.runner.drain();

    expect(harness.processes).toHaveLength(0);
    expect(harness.storedKeys).toEqual(["sk-ant-secret"]);
    const status = harness.runner.authStatus({ jobId: id });
    expect(status.state).toBe("succeeded");
    expect(status.log).toContain("ANTHROPIC_API_KEY");
    expect(status.log).not.toContain("sk-ant-secret");
    expect(harness.refreshed).toEqual(["claudeAgent"]);
  });

  it("surfaces the claude paste-code prompt and forwards the submitted code", async () => {
    const harness = makeHarness();
    const { jobId: id } = harness.runner.authStart({ driver: "claudeAgent", method: "oauth" });
    await tick();
    expect(harness.latest().input.command).toBe("claude");
    expect(harness.latest().input.args).toEqual(["auth", "login"]);

    harness
      .latest()
      .input.onOutput(
        "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\nPaste code here if prompted > ",
      );
    const waiting = harness.runner.authStatus({ jobId: id });
    expect(waiting.needsCodeInput).toBe(true);
    expect(waiting.verificationUrl).toContain("claude.com/cai/oauth/authorize");

    const afterSubmit = harness.runner.authSubmitCode({ jobId: id, code: " code-123 " });
    expect(afterSubmit.needsCodeInput).toBe(false);
    expect(harness.latest().stdin).toEqual(["code-123\n"]);

    harness.latest().input.onExit({ code: 0, signal: null });
    await harness.runner.drain();
    expect(harness.runner.authStatus({ jobId: id }).state).toBe("succeeded");
  });

  it("rejects an empty api key before starting a job", () => {
    const harness = makeHarness();
    expect(() =>
      harness.runner.authStart({ driver: "codex", method: "apiKey", apiKey: "   " }),
    ).toThrow(/API key/);
  });

  it("rejects a code submitted to a settled job", async () => {
    const harness = makeHarness();
    const { jobId: id } = harness.runner.authStart({ driver: "codex", method: "oauth" });
    await tick();
    harness.latest().input.onExit({ code: 1, signal: null });
    await harness.runner.drain();
    expect(() => harness.runner.authSubmitCode({ jobId: id, code: "x" })).toThrow(/not waiting/);
  });

  it("rejects an empty code", async () => {
    const harness = makeHarness();
    const { jobId: id } = harness.runner.authStart({ driver: "codex", method: "oauth" });
    await tick();
    expect(() => harness.runner.authSubmitCode({ jobId: id, code: "  " })).toThrow(
      /Paste the code/,
    );
  });

  it("rejects a concurrent sign-in for the same driver", async () => {
    const harness = makeHarness();
    harness.runner.authStart({ driver: "codex", method: "oauth" });
    await tick();
    expect(() => harness.runner.authStart({ driver: "codex", method: "oauth" })).toThrow(
      /already in progress/,
    );
    expect(() =>
      harness.runner.authStart({ driver: "claudeAgent", method: "oauth" }),
    ).not.toThrow();
  });

  it("kills a stalled oauth login after the timeout", async () => {
    const harness = makeHarness({ authTimeoutMs: 1 });
    const { jobId: id } = harness.runner.authStart({ driver: "codex", method: "oauth" });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.runner.drain();
    const status = harness.runner.authStatus({ jobId: id });
    expect(status.state).toBe("failed");
    expect(status.needsCodeInput).toBe(false);
    expect(status.error).toContain("Timed out");
  });

  it("shutdown kills every running child", async () => {
    const harness = makeHarness();
    harness.runner.installStart({ driver: ProviderDriverKind.make("codex") });
    harness.runner.authStart({ driver: "claudeAgent", method: "oauth" });
    await tick();
    harness.runner.shutdown();
    await harness.runner.drain();
    expect(harness.processes.every((process) => process.killed)).toBe(true);
  });
});
