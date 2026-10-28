import "../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

/**
 * P4 (cap walkthrough 28.10, s2 5:09–5:36): the code was pasted, Submit
 * pressed — and for 25 s nothing on screen moved; a second Submit, then a
 * reload. The sign-in dialog driven end to end through useHarnessSetup with
 * the daemon's sign-in RPCs scripted.
 */

const providerSetupRpc = vi.hoisted(() => ({
  installStart: vi.fn(),
  installStatus: vi.fn(),
  authStart: vi.fn(),
  authStatus: vi.fn(),
  authSubmitCode: vi.fn(),
  authCancel: vi.fn(),
  authSignOut: vi.fn(),
}));

vi.mock("../../environments/runtime", () => {
  const primaryConnection = {
    kind: "primary" as const,
    environmentId: EnvironmentId.make("environment-local"),
    client: {
      server: { getConfig: vi.fn(), updateSettings: vi.fn(), refreshProviders: vi.fn() },
      providerSetup: providerSetupRpc,
    },
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  };
  return {
    getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
    resetSavedEnvironmentRegistryStoreForTests: vi.fn(),
    resetSavedEnvironmentRuntimeStoreForTests: vi.fn(),
    resetEnvironmentServiceForTests: vi.fn(),
    startEnvironmentConnectionService: vi.fn(),
    addSavedEnvironment: vi.fn(),
    disconnectSavedEnvironment: vi.fn(),
    reconnectSavedEnvironment: vi.fn(),
    removeSavedEnvironment: vi.fn(),
    getSavedEnvironmentRecord: () => null,
    getSavedEnvironmentRuntimeState: () => null,
    hasSavedEnvironmentRegistryHydrated: () => true,
    listSavedEnvironmentRecords: () => [],
    resolveEnvironmentHttpUrl: (_environmentId: unknown, path: string) =>
      new URL(path, "http://localhost:3000").toString(),
    waitForSavedEnvironmentRegistryHydration: async () => undefined,
    ensureEnvironmentConnectionBootstrapped: async () => undefined,
    getPrimaryEnvironmentConnection: () => primaryConnection,
    readEnvironmentConnection: () => primaryConnection,
    requireEnvironmentConnection: () => primaryConnection,
    subscribeEnvironmentConnections: () => () => {},
    useSavedEnvironmentRegistryStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
    useSavedEnvironmentRuntimeStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
  };
});

const { HarnessSignInPanel } = await import("./HarnessSignInDialog");
const { useHarnessSetup } = await import("./useHarnessSetup");

const LINK = "https://claude.com/cai/oauth/authorize?code=true&state=xyz";

const waiting = {
  jobId: "job-1",
  driver: "claudeAgent",
  method: "oauth",
  state: "running",
  log: "Paste code here if prompted >",
  verificationUrl: LINK,
  needsCodeInput: true,
};

function SignIn() {
  const setup = useHarnessSetup(null, { adopt: { newChats: false, assistant: false } });
  return (
    <HarnessSignInPanel
      driver="claudeAgent"
      job={setup.authJobs.claudeAgent}
      onStart={({ method, restart }) =>
        void setup.startAuth({ driver: "claudeAgent", method, ...(restart ? { restart } : {}) })
      }
      onCancel={() => void setup.cancelAuth("claudeAgent")}
      onSubmitCode={(code) => void setup.submitAuthCode({ driver: "claudeAgent", code })}
      onReset={() => setup.clearAuth("claudeAgent")}
    />
  );
}

/** A promise the test settles by hand (the daemon answering later). */
function deferred() {
  let settle: ((value: unknown) => void) | undefined;
  const promise = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: unknown) => settle?.(value) };
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <SignIn />
    </QueryClientProvider>,
  );
  await screen.getByTestId("harness-sign-in-account").click();
  await expect.element(screen.getByText("Paste the code from the browser")).toBeVisible();
  return screen;
}

beforeEach(() => {
  providerSetupRpc.authStart.mockResolvedValue({ jobId: "job-1" });
  providerSetupRpc.authStatus.mockResolvedValue(waiting);
  providerSetupRpc.authCancel.mockResolvedValue({ driver: "claudeAgent", cancelled: true });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("Submitting the Claude code", () => {
  it("shows the code being checked at once, then signed in", async () => {
    const screen = await mount();
    const answer = deferred();
    providerSetupRpc.authSubmitCode.mockReturnValue(answer.promise);
    providerSetupRpc.authStatus.mockResolvedValue({
      ...waiting,
      needsCodeInput: false,
      codeCheck: "checking",
    });

    await screen.getByTestId("harness-sign-in-code").fill("d4CqODuRDu#state");
    await screen.getByTestId("harness-sign-in-submit").click();
    // Before the daemon even answers.
    await expect.element(screen.getByText("Checking the code with Claude…")).toBeVisible();
    expect(providerSetupRpc.authSubmitCode).toHaveBeenCalledWith({
      jobId: "job-1",
      code: "d4CqODuRDu#state",
    });
    answer.resolve({ ...waiting, needsCodeInput: false, codeCheck: "checking" });
    await expect.element(screen.getByTestId("harness-sign-in-code")).not.toBeInTheDocument();

    providerSetupRpc.authStatus.mockResolvedValue({
      ...waiting,
      state: "succeeded",
      needsCodeInput: false,
      codeCheck: "checking",
    });
    await expect.element(screen.getByText("Signed in. The agent is ready to use.")).toBeVisible();
  });

  it("asks again in plain words when Claude didn't take the code", async () => {
    const screen = await mount();
    providerSetupRpc.authSubmitCode.mockResolvedValue({
      ...waiting,
      needsCodeInput: false,
      codeCheck: "checking",
    });
    providerSetupRpc.authStatus.mockResolvedValue({ ...waiting, codeCheck: "rejected" });

    await screen.getByTestId("harness-sign-in-code").fill("stale");
    await screen.getByTestId("harness-sign-in-submit").click();
    await expect.element(screen.getByTestId("harness-sign-in-rejected")).toBeVisible();
    await expect.element(screen.getByTestId("harness-sign-in-code")).toHaveValue("");
  });

  it("keeps the sign-in through a missed status check, so Submit still reaches it", async () => {
    const screen = await mount();
    // The socket reconnects while the person is on claude.ai.
    providerSetupRpc.authStatus.mockRejectedValueOnce(new Error("WebSocket is closed"));
    providerSetupRpc.authStatus.mockResolvedValue(waiting);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    providerSetupRpc.authSubmitCode.mockResolvedValue({
      ...waiting,
      needsCodeInput: false,
      codeCheck: "checking",
    });

    await screen.getByTestId("harness-sign-in-code").fill("code-1");
    await screen.getByTestId("harness-sign-in-submit").click();
    await expect.element(screen.getByText("Checking the code with Claude…")).toBeVisible();
    expect(providerSetupRpc.authSubmitCode).toHaveBeenCalledWith({
      jobId: "job-1",
      code: "code-1",
    });
  });

  it("says so when the computer forgot the sign-in, instead of doing nothing", async () => {
    const screen = await mount();
    providerSetupRpc.authSubmitCode.mockRejectedValue(
      Object.assign(new Error("Unknown sign-in job."), { code: "notFound" }),
    );

    await screen.getByTestId("harness-sign-in-code").fill("code-1");
    await screen.getByTestId("harness-sign-in-submit").click();
    await expect.element(screen.getByText(/This sign-in stopped on the computer/)).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("shows why a Submit was refused", async () => {
    const screen = await mount();
    providerSetupRpc.authSubmitCode.mockRejectedValue(
      Object.assign(new Error("This sign-in is not waiting for a code."), { code: "invalid" }),
    );

    await screen.getByTestId("harness-sign-in-code").fill("code-1");
    await screen.getByTestId("harness-sign-in-submit").click();
    await expect
      .element(screen.getByTestId("harness-sign-in-submit-error"))
      .toHaveTextContent("This sign-in is not waiting for a code.");
  });
});
