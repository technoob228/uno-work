import "../../../index.css";

/**
 * "Move my projects here" (13.11): the developer way's three screens and the
 * Project step's "Import from my computer", in a real browser. The cloud
 * computer is a fake (the environment API's test override), the setup's frame and
 * progress are stand-ins; the steps and the Add computer parts are the real ones.
 */
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ComputerWorkStatus,
  type FoundProject,
  type MyComputer,
  type ServerConfig,
  type ServerProvider,
  type UnoSetupProgress,
} from "@t3tools/contracts";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { create } from "zustand";

const ENV = EnvironmentId.make("env-work");

// ── The setup around the steps ─────────────────────────────────────────

const EMPTY: UnoSetupProgress = {
  mode: "ai",
  flow: "dev",
  visited: [],
  skipped: [],
  finished: false,
  dismissed: false,
  project: null,
  answers: {},
};
const progressStore = create<{ progress: UnoSetupProgress }>(() => ({ progress: EMPTY }));
const nav = {
  goToStep: vi.fn(),
  goHome: vi.fn(),
  completeStep: vi.fn(async () => undefined),
  skipStep: vi.fn(async () => undefined),
  skipAll: vi.fn(async () => undefined),
  one: false,
};

vi.mock("../useSetupProgress", () => ({
  useSetupProgress: () => progressStore((state) => state.progress),
  currentSetupProgress: () => progressStore.getState().progress,
  useUpdateSetupProgress: () => async (change: (current: UnoSetupProgress) => UnoSetupProgress) => {
    progressStore.setState({ progress: change(progressStore.getState().progress) });
  },
}));
vi.mock("../useSetupNavigation", () => ({ useSetupNavigation: () => nav }));
vi.mock("../SetupShell", async (importOriginal) => {
  const real = await importOriginal<typeof import("../SetupShell")>();
  return {
    ...real,
    // The frame needs the app's sidebar and router; the step's own button is what matters.
    SetupShell: ({
      primary,
      children,
    }: {
      primary?: {
        label: string;
        onClick: () => void;
        disabled?: boolean;
        pending?: boolean;
      } | null;
      children: ReactNode;
    }) => (
      <div className="p-6">
        {children}
        {primary ? (
          <button
            type="button"
            data-testid="setup-primary"
            disabled={primary.disabled === true || primary.pending === true}
            onClick={primary.onClick}
          >
            {primary.label}
          </button>
        ) : null}
      </div>
    ),
  };
});

// ── This computer: its agents and settings ─────────────────────────────

const provider = (
  driver: string,
  auth: Record<string, unknown>,
  models: ReadonlyArray<string>,
): ServerProvider =>
  ({
    driver,
    instanceId: driver,
    displayName: driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth,
    checkedAt: "2026-11-13T10:00:00.000Z",
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  }) as unknown as ServerProvider;

/** This computer's agents, as the server's provider snapshot says (the real store). */
let providersNow: ReadonlyArray<ServerProvider> = [];
let pushProviders: (providers: ReadonlyArray<ServerProvider>) => void = () => undefined;
const setProviders = (providers: ReadonlyArray<ServerProvider>) => {
  providersNow = providers;
  pushProviders(providers);
};
const signedOut = () => [
  provider("uno", { status: "authenticated" }, ["uno/smart"]),
  // Claude Code on the plan's Uno AI credit: not "their agent signed in".
  provider("claudeAgent", { status: "authenticated", type: "unoAi" }, ["claude-opus-5"]),
  provider("codex", { status: "unauthenticated" }, ["gpt-5.4"]),
];

const harness = {
  installJobs: {},
  authJobs: {},
  startInstall: vi.fn(),
  startAuth: vi.fn(async ({ driver }: { driver: string }) => {
    // The CLI's sign-in finished: the next provider snapshot says so.
    setProviders(
      providersNow.map((entry) =>
        entry.instanceId === driver
          ? ({ ...entry, auth: { status: "authenticated", type: "claude.ai" } } as ServerProvider)
          : entry,
      ),
    );
  }),
  cancelAuth: vi.fn(),
  submitAuthCode: vi.fn(),
  clearAuth: vi.fn(),
};
vi.mock("../../harness/useHarnessSetup", () => ({ useHarnessSetup: () => harness }));
vi.mock("../../../hooks/useFolderChats", () => ({
  useHomeFolderPath: () => "/home/uno",
  useFolderChats: () => ({ ensureFolderProject: vi.fn() }),
}));
vi.mock("../../../environments/primary", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usePrimaryEnvironmentId: () => ENV,
}));
const handleNewThread = vi.fn(async () => undefined);
vi.mock("../../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => ({ handleNewThread }),
}));

// ── The cloud computer that holds the person's own computers ───────────

const LAPTOP: MyComputer = {
  id: "41",
  name: "MacBook",
  os: "darwin",
  arch: "arm64",
  online: true,
  connectedAt: null,
  lastSeenAt: null,
  helperVersion: "0.4.0",
};
const FOUND: ReadonlyArray<FoundProject> = [
  {
    name: "landing",
    path: "/Users/m/projects/landing",
    displayPath: "~/projects/landing",
    git: true,
    keys: ["STRIPE_SECRET_KEY"],
    fromChats: true,
    synced: false,
  },
  {
    name: "api",
    path: "/Users/m/code/api",
    displayPath: "~/code/api",
    git: true,
    keys: ["DATABASE_URL", "OPENAI_API_KEY"],
    fromChats: false,
    synced: false,
  },
];

const cloud = {
  computers: [] as Array<MyComputer>,
  /** The helper on the laptop took the code. */
  claimed: false,
  work: null as ComputerWorkStatus | null,
};
const idleWork = (): ComputerWorkStatus => ({
  computerId: "41",
  scan: {
    state: "ready",
    message: null,
    scannedAt: new Date().toISOString(),
    home: "/Users/m",
    projects: [...FOUND],
  },
  bring: { state: "idle", done: 0, total: 0, message: null, results: [] },
});
const api = {
  myComputer: {
    status: vi.fn(async () => ({ enabled: true, computers: cloud.computers })),
    pair: vi.fn(async () => ({
      code: "7KQ2-M9XD",
      url: "https://console.uno.place/pair",
      commands: {
        mac: "curl …/connect.sh | sh",
        linux: "curl …/connect.sh | sh",
        windows: "irm … | iex",
      },
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    })),
    pairStatus: vi.fn(async () =>
      cloud.claimed
        ? { state: "claimed", step: null, message: null, computerId: "41" }
        : { state: "waiting", step: null, message: null, computerId: null },
    ),
    importStatus: vi.fn(async () => ({
      computerId: "41",
      state: "ready",
      declined: false,
      tools: [],
      alsoFound: [],
      skipped: { unreadable: 0, unknownFormat: 0 },
      scanned: { done: 0, total: 0 },
      progress: { done: 0, total: 0 },
      result: null,
      importedChats: 0,
      importedProjects: 0,
      message: null,
    })),
    importScan: vi.fn(async () => api.myComputer.importStatus()),
    importStart: vi.fn(async () => api.myComputer.importStatus()),
  },
  computers: {
    setPurpose: vi.fn(async ({ computerId, purpose }: { computerId: string; purpose: string }) => ({
      lifecycle: true,
      purposes: [{ computerId, purpose }],
    })),
    workScan: vi.fn(async () => (cloud.work ??= idleWork())),
    workStatus: vi.fn(async () => cloud.work ?? idleWork()),
    bringWork: vi.fn(async ({ projects }: { projects: ReadonlyArray<{ path: string }> }) => {
      cloud.work = {
        ...(cloud.work ?? idleWork()),
        bring: { state: "running", done: 0, total: projects.length, message: null, results: [] },
      };
      return cloud.work;
    }),
  },
};
vi.mock("../../../computersLifecycle/useComputers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../computersLifecycle/useComputers")>();
  return {
    ...real,
    useComputersHostId: () => ENV,
    useSetComputerPurpose: () => (computerId: string, purpose: "tool" | "full") =>
      api.computers.setPurpose({ computerId, purpose }),
  };
});

const serverState = await import("../../../rpc/serverState");
const { AppAtomRegistryProvider } = await import("../../../rpc/atomRegistry");
const serverConfig = (providers: ReadonlyArray<ServerProvider>): ServerConfig => ({
  environment: {
    environmentId: ENV,
    label: "Work",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-session-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "/home/uno",
  keybindingsConfigPath: "/home/uno/.t3code-keybindings.json",
  keybindings: [],
  issues: [],
  providers: [...providers],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/home/uno/.t3/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
});
pushProviders = (providers) => serverState.applyProvidersUpdated({ providers: [...providers] });

const { __setEnvironmentApiOverrideForTests } = await import("../../../environmentApi");
__setEnvironmentApiOverrideForTests(ENV, api as never);

const { DevSignInStep } = await import("./DevSignInStep");
const { DevImportStep } = await import("./DevImportStep");
const { DevFirstChatStep } = await import("./DevFirstChatStep");
const { ProjectStep } = await import("./ProjectStep");
const { WorkWelcomeStep } = await import("../../onboarding/steps/web/WorkWelcomeStep");
const { useComposerDraftStore } = await import("../../../composerDraftStore");
const { DEV_AGENT_KEY, DEV_COMPUTER_KEY, DEV_PROJECTS_KEY, IMPORTED_PROJECT_KEY } =
  await import("../devSetup");

let client: QueryClient;
const mount = (node: ReactNode) =>
  render(
    <AppAtomRegistryProvider>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </AppAtomRegistryProvider>,
  );
const primary = () => page.getByTestId("setup-primary");

beforeAll(async () => {
  await page.viewport(1100, 900);
});
beforeEach(() => {
  // The test frame may not have focus: without this, polling (the pairing, the
  // copy's progress) pauses and a wait for it runs into the test's timeout.
  focusManager.setFocused(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  progressStore.setState({ progress: EMPTY });
  providersNow = signedOut();
  serverState.setServerConfigSnapshot(serverConfig(providersNow));
  cloud.computers = [];
  cloud.claimed = false;
  cloud.work = null;
  for (const fn of Object.values(nav)) if (typeof fn === "function") fn.mockClear();
  handleNewThread.mockClear();
  api.computers.bringWork.mockClear();
  api.computers.setPurpose.mockClear();
});
afterEach(() => client.clear());

describe("the welcome screen", () => {
  it("offers a third way for developers", async () => {
    const onConfirm = vi.fn();
    const onModeChange = vi.fn();
    mount(
      <WorkWelcomeStep
        mode="dev"
        onModeChange={onModeChange}
        onConfirm={onConfirm}
        onOwnTools={vi.fn()}
      />,
    );
    const dev = page.getByTestId("welcome-dev");
    await expect.element(dev).toHaveTextContent("Move my projects here");
    await expect.element(dev).toHaveTextContent("For developers");
    await expect.element(dev).toHaveAttribute("aria-checked", "true");
    await expect.element(page.getByTestId("welcome-ai")).toHaveTextContent("Recommended");
    await page.getByTestId("welcome-simple").click();
    expect(onModeChange).toHaveBeenCalledWith("simple");
  });
});

describe("step 1 — sign in to your coding agent", () => {
  it("Claude Code on Uno AI's credit isn't signed in; signing in makes it the agent", async () => {
    mount(<DevSignInStep />);
    await expect
      .element(page.getByTestId("setup-dev-agent-claudeAgent"))
      .toHaveAttribute("data-status", "needsSignIn");
    await expect.element(primary()).toHaveTextContent("Sign in first");
    await expect.element(primary()).toBeDisabled();
    await page.getByTestId("setup-dev-agent-claudeAgent").click();
    // The real sign-in panel, inline.
    await expect
      .element(page.getByText("Anthropic API key", { exact: false }).first())
      .toBeVisible();
    await harness.startAuth({ driver: "claudeAgent" });
    await expect.element(primary()).toHaveTextContent("Continue with Claude Code");
    await primary().click();
    await expect.poll(() => nav.completeStep.mock.calls.length).toBe(1);
    expect(nav.completeStep).toHaveBeenCalledWith("sign-in");
    expect(progressStore.getState().progress.answers[DEV_AGENT_KEY]).toBe("claudeAgent");
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("claudeAgent");
  });

  it("no subscription: one line to Uno AI", async () => {
    mount(<DevSignInStep />);
    await page.getByTestId("setup-dev-use-uno").click();
    await expect.poll(() => nav.completeStep.mock.calls.length).toBe(1);
    expect(progressStore.getState().progress.answers[DEV_AGENT_KEY]).toBe("uno");
  });
});

describe("step 2 — import projects from my computer", () => {
  it("connect the laptop → what is it for → pick projects and keys → Bring", async () => {
    mount(<DevImportStep />);
    await expect.element(page.getByTestId("setup-import-connect")).toBeVisible();
    await page.getByTestId("lc-os-linux").click();
    await expect.element(page.getByTestId("lc-command")).toHaveTextContent("connect.sh");
    // No button to press while it waits for the laptop.
    await expect.element(primary()).not.toBeInTheDocument();

    // The helper is in: the laptop is listed online.
    cloud.claimed = true;
    cloud.computers = [LAPTOP];
    await expect
      .element(page.getByTestId("setup-import-purpose"), { timeout: 10_000 })
      .toHaveTextContent("MacBook is connected");
    await page.getByTestId("lc-purpose-full").click();
    expect(api.computers.setPurpose).toHaveBeenCalledWith({ computerId: "41", purpose: "full" });

    await expect.element(page.getByTestId("setup-import-bring")).toBeVisible();
    await expect.element(page.getByTestId("lc-bring-project-api")).toHaveTextContent("~/code/api");
    // The chats part settles first: its "Looking for chats…" moves the rows under the click.
    await expect.element(page.getByText("No chats found.")).toBeVisible();
    // landing ran a chat: ticked; api from ~/code: tick it, leave one key behind.
    await page.getByTestId("lc-bring-project-api").getByRole("checkbox").first().click();
    await page.getByText("OPENAI_API_KEY").click();
    await expect.element(primary()).toHaveTextContent("Bring 2 projects");
    await primary().click();

    await expect.poll(() => nav.completeStep.mock.calls.length).toBe(1);
    expect(nav.completeStep).toHaveBeenCalledWith("import");
    expect(api.computers.bringWork).toHaveBeenCalledWith({
      computerId: "41",
      projects: [
        { path: "/Users/m/projects/landing", keys: ["STRIPE_SECRET_KEY"] },
        { path: "/Users/m/code/api", keys: ["DATABASE_URL"] },
      ],
    });
    const answers = progressStore.getState().progress.answers;
    expect(answers[DEV_COMPUTER_KEY]).toBe("41");
    expect(JSON.parse(answers[DEV_PROJECTS_KEY]!)).toEqual([
      { path: "/Users/m/projects/landing", name: "landing" },
      { path: "/Users/m/code/api", name: "api" },
    ]);
  });

  it("a computer connected before: pick it, straight to the projects", async () => {
    cloud.computers = [LAPTOP];
    mount(<DevImportStep />);
    await page.getByTestId("setup-import-computer-41").click();
    await expect.element(page.getByTestId("setup-import-bring")).toBeVisible();
    expect(api.computers.setPurpose).not.toHaveBeenCalled();
  });
});

describe("step 3 — open a chat in your project", () => {
  const picked = () =>
    progressStore.setState({
      progress: {
        ...EMPTY,
        answers: {
          [DEV_AGENT_KEY]: "codex",
          [DEV_COMPUTER_KEY]: "41",
          [DEV_PROJECTS_KEY]: JSON.stringify([
            { path: "/Users/m/projects/landing", name: "landing" },
            { path: "/Users/m/code/api", name: "api" },
            { path: "/Users/m/Developer/ios-app", name: "ios-app" },
          ]),
        },
      },
    });

  it("copying, ready and failed per project; the chat starts in the selected one", async () => {
    picked();
    setProviders(
      signedOut().map((entry) =>
        entry.instanceId === "codex"
          ? ({ ...entry, auth: { status: "authenticated", type: "chatgpt" } } as ServerProvider)
          : entry,
      ),
    );
    cloud.work = {
      ...idleWork(),
      bring: {
        state: "running",
        done: 2,
        total: 3,
        message: null,
        results: [
          {
            path: "/Users/m/projects/landing",
            name: "landing",
            ok: true,
            keysSaved: 1,
            message: null,
            projectId: ProjectId.make("p-landing"),
            folder: "/home/uno/projects/landing",
          },
          {
            path: "/Users/m/Developer/ios-app",
            name: "ios-app",
            ok: false,
            keysSaved: 0,
            message: "The project is 2380 MB packed; up to 2 GB come over.",
            projectId: null,
            folder: null,
          },
        ],
      },
    };
    mount(<DevFirstChatStep />);
    await expect
      .element(page.getByTestId("setup-brought-landing"))
      .toHaveAttribute("data-state", "ready");
    await expect
      .element(page.getByTestId("setup-brought-landing"))
      .toHaveTextContent("~/projects/landing");
    await expect.element(page.getByTestId("setup-brought-api")).toHaveTextContent("Copying…");
    await expect.element(page.getByTestId("setup-brought-ios-app")).toHaveTextContent("2380 MB");
    await expect.element(page.getByText("It starts on Codex", { exact: false })).toBeVisible();
    // The first one is selected.
    await expect
      .element(page.getByTestId("setup-brought-landing"))
      .toHaveAttribute("aria-checked", "true");

    await page.getByTestId("setup-brought-api").click();
    await expect.element(primary()).toHaveTextContent("Copying api…");
    await expect.element(primary()).toBeDisabled();

    await page.getByTestId("setup-brought-landing").click();
    await expect.element(primary()).toHaveTextContent("Start a chat in landing");
    await primary().click();
    await expect.poll(() => handleNewThread.mock.calls.length).toBe(1);
    expect(handleNewThread).toHaveBeenCalledWith({ environmentId: ENV, projectId: "p-landing" });
    const progress = progressStore.getState().progress;
    expect(progress.project).toEqual({
      id: "p-landing",
      path: "/home/uno/projects/landing",
      name: "landing",
      kind: "other",
    });
    expect(progress.finished).toBe(true);
  });

  it("nothing brought: back to the import", async () => {
    mount(<DevFirstChatStep />);
    await expect.element(page.getByTestId("setup-brought-empty")).toBeVisible();
    await primary().click();
    expect(nav.goToStep).toHaveBeenCalledWith("import");
  });
});

describe("the AI path's Project step — Import from my computer", () => {
  it("the first project brought becomes the setup's project once it's here", async () => {
    const { flow: _dev, ...aiPath } = EMPTY;
    progressStore.setState({ progress: aiPath });
    cloud.computers = [LAPTOP];
    mount(<ProjectStep />);
    await expect.element(page.getByTestId("setup-project-source")).toBeVisible();
    await page.getByTestId("setup-project-source-import").click();
    await page.getByTestId("setup-import-computer-41").click();
    await expect.element(primary()).toHaveTextContent("Bring 1 project");
    await primary().click();
    await expect.element(page.getByTestId("setup-project-copying")).toBeVisible();
    await expect.element(primary()).toHaveTextContent("Copying landing…");
    expect(nav.completeStep).not.toHaveBeenCalled();

    // The copy lands.
    cloud.work = {
      ...cloud.work!,
      bring: {
        state: "done",
        done: 1,
        total: 1,
        message: null,
        results: [
          {
            path: "/Users/m/projects/landing",
            name: "landing",
            ok: true,
            keysSaved: 1,
            message: null,
            projectId: ProjectId.make("p-landing"),
            folder: "/home/uno/projects/landing",
          },
        ],
      },
    };
    await expect.poll(() => nav.completeStep.mock.calls.length, { timeout: 10_000 }).toBe(1);
    expect(nav.completeStep).toHaveBeenCalledWith("project");
    const progress = progressStore.getState().progress;
    expect(progress.project?.path).toBe("/home/uno/projects/landing");
    expect(progress.answers[IMPORTED_PROJECT_KEY]).toBe("p-landing");
  });
});
