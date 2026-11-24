import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { AntigravityAuthState } from "../acp/AntigravityAcpSupport.ts";
import { makeHarnessSetupRunner } from "./HarnessSetupService.ts";
import type { HarnessProcessSpawnInput } from "./harnessProcess.ts";

const LOGIN_URL =
  "https://accounts.google.com/o/oauth2/auth?access_type=offline&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=login-state";

/** `agy acp --login` 1.5.16 as it printed on a cloud computer (24.11.2026). */
const LOGIN_OUTPUT = `Open this link in a browser to log in with Google:\n\n  ${LOGIN_URL}\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n`;

interface FakeProcess {
  readonly input: HarnessProcessSpawnInput;
  readonly stdin: string[];
}

function makeAntigravity(
  initial: { auth?: AntigravityAuthState; storedKey?: string; file?: boolean } = {},
) {
  const state = {
    auth: initial.auth ?? ({ status: "unauthenticated" } as AntigravityAuthState),
    storedKey: initial.storedKey,
    file: initial.file ?? false,
    installs: 0,
  };
  const processes: FakeProcess[] = [];
  const refreshed: string[] = [];
  let counter = 0;
  const runner = makeHarnessSetupRunner({
    spawn: (input) => {
      const fake: FakeProcess = { input, stdin: [] };
      processes.push(fake);
      return {
        write: (data) => fake.stdin.push(data),
        endInput: () => {},
        kill: () => input.onExit({ code: null, signal: "SIGTERM" }),
      };
    },
    platform: "linux",
    homeDir: "/home/unowork",
    baseEnv: { PATH: "/usr/bin" },
    probeNpmGlobalWritable: async () => false,
    probeUvAvailable: async () => true,
    resolveCliEnvironment: async () => ({
      binaryPath: "/home/unowork/.local/share/uno-work/antigravity/versions/1.5.16/antigravity",
      env: { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0", AGY_ACP_FORCE_FILE_STORAGE: "1" },
    }),
    storeClaudeApiKey: async () => {},
    removeClaudeApiKey: async () => false,
    refreshProvider: async (driver) => {
      refreshed.push(driver);
    },
    makeJobId: () => `job-${(counter += 1)}`,
    antigravity: {
      install: async (log) => {
        state.installs += 1;
        log("Checksum verified.");
        return { version: "1.5.16" };
      },
      auth: async () => state.auth,
      storeApiKey: async (apiKey) => {
        state.storedKey = apiKey;
      },
      removeApiKey: async () => {
        const had = state.storedKey !== undefined;
        state.storedKey = undefined;
        return had;
      },
      clearFileSignIn: async () => {
        const had = state.file;
        state.file = false;
        if (state.auth.type === "google-file") state.auth = { status: "unauthenticated" };
        return had;
      },
    },
  });
  const latest = () => {
    const last = processes.at(-1);
    if (!last) throw new Error("no process was spawned");
    return last;
  };
  return { runner, state, processes, refreshed, latest };
}

const tick = async (times = 8) => {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
};

describe("Antigravity setup", () => {
  it("installs Google's CLI without npm or a shell", async () => {
    const h = makeAntigravity();
    const { jobId } = h.runner.installStart({ driver: ProviderDriverKind.make("antigravity") });
    await h.runner.drain();
    const status = h.runner.installStatus({ jobId });
    expect(status.state).toBe("succeeded");
    expect(status.log).toContain("Checksum verified.");
    expect(h.processes).toHaveLength(0);
    expect(h.state.installs).toBe(1);
    expect(h.refreshed).toEqual(["antigravity"]);
  });

  it("stores a Gemini API key without running anything, and never logs it", async () => {
    const h = makeAntigravity();
    const { jobId } = h.runner.authStart({
      driver: "antigravity",
      method: "apiKey",
      apiKey: "AIza-TEST-KEY-123",
    });
    await h.runner.drain();
    const status = h.runner.authStatus({ jobId });
    expect(status.state).toBe("succeeded");
    expect(status.log).toContain("ANTIGRAVITY_GEMINI_API_KEY");
    expect(status.log).not.toContain("AIza-TEST-KEY-123");
    expect(h.state.storedKey).toBe("AIza-TEST-KEY-123");
    expect(h.processes).toHaveLength(0);
  });

  it("runs `agy acp --login`: the Google link shows, then the pasted code goes in", async () => {
    const h = makeAntigravity();
    const { jobId } = h.runner.authStart({ driver: "antigravity", method: "oauth" });
    await tick();
    const child = h.latest();
    expect(child.input.args).toEqual(["acp", "--login"]);
    expect(child.input.env.SSH_CONNECTION).toBe("127.0.0.1 0 127.0.0.1 0");
    child.input.onOutput(LOGIN_OUTPUT);
    const waiting = h.runner.authStatus({ jobId });
    expect(waiting.verificationUrl).toBe(LOGIN_URL);
    expect(waiting.needsCodeInput).toBe(true);

    expect(() => h.runner.authSubmitCode({ jobId, code: "https://evil.example/?code=x" })).toThrow(
      /not the code/,
    );
    expect(child.stdin).toEqual([]);
    h.runner.authSubmitCode({ jobId, code: "4/0Ab-code_1" });
    expect(child.stdin).toEqual(["4/0Ab-code_1\n"]);

    child.input.onExit({ code: 0, signal: null });
    await h.runner.drain();
    expect(h.runner.authStatus({ jobId }).state).toBe("succeeded");
    expect(h.refreshed).toEqual(["antigravity"]);
  });

  it("is done at once when this computer's Antigravity is already signed in", async () => {
    const h = makeAntigravity({
      auth: { status: "authenticated", type: "google-keyring", label: "Google account" },
    });
    const { jobId } = h.runner.authStart({ driver: "antigravity", method: "oauth" });
    await h.runner.drain();
    const status = h.runner.authStatus({ jobId });
    expect(status.state).toBe("succeeded");
    expect(status.log).toContain("already signed in");
    expect(h.processes).toHaveLength(0);
  });

  it("starts no login when the sign-in is cancelled before it began", async () => {
    const h = makeAntigravity();
    const { jobId } = h.runner.authStart({ driver: "antigravity", method: "oauth" });
    h.runner.authCancel({ driver: "antigravity" });
    await h.runner.drain();
    expect(h.runner.authStatus({ jobId }).state).toBe("failed");
    expect(h.processes).toHaveLength(0);
  });

  it("has no second account", () => {
    const h = makeAntigravity();
    expect(() =>
      h.runner.authStart({
        driver: "antigravity",
        method: "oauth",
        instanceId: "antigravity_account_1" as ProviderInstanceId,
      }),
    ).toThrow(/one account per computer/);
  });

  it("signs out of Uno Work's own sign-in and key", async () => {
    const h = makeAntigravity({
      auth: { status: "authenticated", type: "google-file" },
      file: true,
      storedKey: "AIza-TEST",
    });
    await expect(h.runner.authSignOut({ driver: "antigravity" })).resolves.toEqual({
      driver: "antigravity",
      signedOut: true,
    });
    expect(h.state.file).toBe(false);
    expect(h.state.storedKey).toBeUndefined();
    expect(h.processes).toHaveLength(0);
  });

  it("leaves the Antigravity app's own sign-in to the app", async () => {
    const h = makeAntigravity({ auth: { status: "authenticated", type: "google-keyring" } });
    const result = await h.runner.authSignOut({ driver: "antigravity" });
    expect(result.signedOut).toBe(false);
    expect(result.error).toMatch(/Antigravity app/);
  });
});
