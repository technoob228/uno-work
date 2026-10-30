import "../../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useComposerStashStore } from "../../../composerStashStore";
import { isMacPlatform } from "../../../lib/utils";

/**
 * Cap walkthrough 28.10, P2 (Misha): "after signing in to our Claude, Home
 * shows a white box with a few buttons, but I can't pick a model or the
 * reasoning. Why can't I pick?" The newcomer's first screen (`minimal`) hid
 * both. It shows them now — and with the person's Claude plan signed in,
 * Claude is what's picked.
 */

const providers = vi.hoisted(() => ({ list: [] as ServerProvider[] }));

vi.mock("../../../environments/runtime", () => {
  const primaryConnection = {
    kind: "primary" as const,
    environmentId: EnvironmentId.make("environment-local"),
    client: { server: { getConfig: vi.fn(), updateSettings: vi.fn() }, providerSetup: {} },
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

vi.mock("../../../environments/settings/serverSettings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEnvironmentProviders: () => providers.list,
}));

// Not someone who came for their own agent: the plain rule applies.
vi.mock("./useOwnAgentStart", () => ({ useOwnAgentStart: () => null }));

const { HomeComposer } = await import("./HomeComposer");

const reasoning = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
  ],
});

function harness(input: {
  readonly id: string;
  readonly name: string;
  readonly auth: ServerProvider["auth"];
  readonly models: ReadonlyArray<{ slug: string; name: string }>;
}): ServerProvider {
  return {
    driver: ProviderDriverKind.make(input.id),
    instanceId: ProviderInstanceId.make(input.id),
    displayName: input.name,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: input.auth,
    checkedAt: new Date().toISOString(),
    slashCommands: [],
    skills: [],
    models: input.models.map((model) => ({
      ...model,
      isCustom: false,
      capabilities: reasoning,
    })),
  };
}

const uno = harness({
  id: "uno",
  name: "Uno",
  auth: { status: "authenticated" },
  models: [{ slug: "uno/smart", name: "Smart" }],
});
const claudeWith = (auth: ServerProvider["auth"]) =>
  harness({
    id: "claudeAgent",
    name: "Claude",
    auth,
    models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5" }],
  });

async function mountFirstScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HomeComposer
        environmentId={EnvironmentId.make("environment-local")}
        starters={[]}
        onStart={vi.fn()}
        minimal
        placeholder="Describe it in your own words…"
      />
    </QueryClientProvider>,
  );
}

async function mountHome(onStart = vi.fn(async () => undefined)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <HomeComposer
        environmentId={EnvironmentId.make("environment-local")}
        starters={[]}
        onStart={onStart}
      />
    </QueryClientProvider>,
  );
  return { screen, onStart, box: screen.getByTestId("home-composer") };
}

const MOD = isMacPlatform(navigator.platform) ? "Meta" : "Control";
const withMod = (key: string) => userEvent.keyboard(`{${MOD}>}${key}{/${MOD}}`);

afterEach(() => {
  document.body.innerHTML = "";
  useComposerStashStore.setState({ entries: [] });
});

describe("Home's first screen after signing in to Claude", () => {
  it("shows the model and its reasoning, Claude picked", async () => {
    providers.list = [
      uno,
      claudeWith({ status: "authenticated", type: "max", label: "Claude Max Subscription" }),
    ];
    const screen = await mountFirstScreen();
    const chips = screen.getByTestId("home-composer-chips");
    await expect.element(chips).toBeVisible();
    await expect.element(chips.getByText("Claude Opus 5.5")).toBeVisible();
    await expect.element(chips.getByText(/High/)).toBeVisible();
    // Still the simple screen: no folder or permissions chips.
    await expect.element(screen.getByTestId("home-folder-chip")).not.toBeInTheDocument();
    await expect.element(screen.getByTestId("home-permissions")).not.toBeInTheDocument();
  });

  it("without a Claude plan: Uno · Smart, and the model can still be changed", async () => {
    providers.list = [uno, claudeWith({ status: "authenticated", type: "unoAi", label: "Uno AI" })];
    const screen = await mountFirstScreen();
    const chips = screen.getByTestId("home-composer-chips");
    await expect.element(chips.getByText("Smart")).toBeVisible();
    await expect.element(chips.getByText("Claude Opus 5.5")).not.toBeInTheDocument();
  });
});

describe("Home's box and the chat box's shortcuts", () => {
  it("Enter opens the chat with the task, as before", async () => {
    providers.list = [uno];
    const { box, onStart } = await mountHome();
    await box.fill("Check the backups");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    const options = onStart.mock.calls[0]?.at(1) as { inBackground?: boolean } | undefined;
    expect(options?.inBackground).toBeUndefined();
  });

  it("⌘Enter starts the task in the background", async () => {
    providers.list = [uno];
    const { box, onStart } = await mountHome();
    await box.fill("Check the backups");
    await withMod("{Enter}");
    await vi.waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    const [prompt, options] = onStart.mock.calls[0] as unknown as [
      string,
      { inBackground?: boolean },
    ];
    expect(prompt).toBe("Check the backups");
    expect(options.inBackground).toBe(true);
  });

  it("⌘S sets the task aside and brings it back on the empty box", async () => {
    providers.list = [uno];
    const { box } = await mountHome();
    await box.fill("Write the changelog");
    await withMod("s");
    await expect.element(box).toHaveValue("");
    expect(useComposerStashStore.getState().entries.map((entry) => entry.text)).toEqual([
      "Write the changelog",
    ]);

    await withMod("s");
    await expect.element(box).toHaveValue("Write the changelog");
    expect(useComposerStashStore.getState().entries).toEqual([]);
  });
});
