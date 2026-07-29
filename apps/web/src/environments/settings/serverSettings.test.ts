import type { EnvironmentId, ServerConfig, ServerSettingsPatch } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PRIMARY_ID = "primary-env" as EnvironmentId;
const SAVED_ID = "saved-env" as EnvironmentId;
const OTHER_SAVED_ID = "other-saved-env" as EnvironmentId;

const isPrimaryEnvironmentId = vi.fn<(id: EnvironmentId) => boolean>();
const primaryUpdateSettings = vi.fn<(patch: ServerSettingsPatch) => Promise<unknown>>();
const primaryRefreshProviders = vi.fn<(input: unknown) => Promise<unknown>>();
const applySettingsUpdated = vi.fn<(settings: unknown) => void>();
const savedUpdateSettings = vi.fn<(patch: ServerSettingsPatch) => Promise<unknown>>();
const savedRefreshProviders = vi.fn<(input: unknown) => Promise<unknown>>();

let primaryConfig: ServerConfig;
let savedConfigs: Record<string, ServerConfig | null>;
let connectedEnvironmentIds: Set<string>;

const makeConfig = (values: Record<string, unknown>): ServerConfig =>
  ({ settings: values, providers: [] }) as unknown as ServerConfig;

const runtimePatch = vi.fn(
  (environmentId: EnvironmentId, patch: { serverConfig?: ServerConfig }) => {
    if (patch.serverConfig !== undefined) savedConfigs[environmentId] = patch.serverConfig;
  },
);

vi.mock("../http/target", () => ({
  isPrimaryEnvironmentId: (id: EnvironmentId) => isPrimaryEnvironmentId(id),
  EnvironmentUnavailableError: class EnvironmentUnavailableError extends Error {
    constructor(
      readonly environmentId: EnvironmentId,
      message: string,
    ) {
      super(message);
      this.name = "EnvironmentUnavailableError";
    }
  },
}));

vi.mock("../runtime", () => ({
  readEnvironmentConnection: (environmentId: EnvironmentId) =>
    connectedEnvironmentIds.has(environmentId)
      ? {
          client: {
            server: {
              updateSettings: (patch: ServerSettingsPatch) => savedUpdateSettings(patch),
              refreshProviders: (input: unknown) => savedRefreshProviders(input),
            },
          },
        }
      : null,
  useSavedEnvironmentRuntimeStore: Object.assign(() => null, {
    getState: () => ({
      byId: Object.fromEntries(
        Object.entries(savedConfigs).map(([id, serverConfig]) => [id, { serverConfig }]),
      ),
      patch: runtimePatch,
    }),
  }),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    server: {
      updateSettings: (patch: ServerSettingsPatch) => primaryUpdateSettings(patch),
      refreshProviders: (input: unknown) => primaryRefreshProviders(input),
    },
  }),
}));

vi.mock("~/rpc/serverState", () => ({
  applySettingsUpdated: (settings: unknown) => applySettingsUpdated(settings),
  getServerConfig: () => primaryConfig,
  useServerConfig: () => primaryConfig,
  whenServerConfigReady: () => Promise.resolve(primaryConfig),
}));

vi.mock("@t3tools/shared/serverSettings", () => ({
  applyServerSettingsPatch: (
    settings: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) => ({
    ...settings,
    ...patch,
  }),
}));

const { refreshEnvironmentProviders, updateEnvironmentSettings } =
  await import("./serverSettings.ts");

describe("updateEnvironmentSettings", () => {
  beforeEach(() => {
    primaryConfig = makeConfig({ theme: "light" });
    savedConfigs = {
      [SAVED_ID]: makeConfig({ theme: "dark" }),
      [OTHER_SAVED_ID]: makeConfig({ theme: "system" }),
    };
    connectedEnvironmentIds = new Set([SAVED_ID, OTHER_SAVED_ID]);
    isPrimaryEnvironmentId.mockImplementation((id) => id === PRIMARY_ID);
    primaryUpdateSettings.mockResolvedValue(undefined);
    savedUpdateSettings.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("writes primary settings through the local daemon", async () => {
    await updateEnvironmentSettings(PRIMARY_ID, { theme: "dark" } as ServerSettingsPatch);

    expect(primaryUpdateSettings).toHaveBeenCalledWith({ theme: "dark" });
    expect(savedUpdateSettings).not.toHaveBeenCalled();
  });

  it("writes a saved environment through its own connection, never the local one", async () => {
    await updateEnvironmentSettings(SAVED_ID, { theme: "light" } as ServerSettingsPatch);

    expect(savedUpdateSettings).toHaveBeenCalledWith({ theme: "light" });
    expect(primaryUpdateSettings).not.toHaveBeenCalled();
  });

  it("leaves primary server state untouched when a remote save succeeds", async () => {
    await updateEnvironmentSettings(SAVED_ID, { theme: "light" } as ServerSettingsPatch);

    // The global atom belongs to the primary daemon; a remote edit that moved
    // it would show one machine's settings as another's.
    expect(applySettingsUpdated).not.toHaveBeenCalled();
    expect(savedConfigs[SAVED_ID]?.settings).toEqual({ theme: "light" });
  });

  it("keeps optimistic state per environment", async () => {
    await updateEnvironmentSettings(SAVED_ID, { theme: "light" } as ServerSettingsPatch);

    expect(savedConfigs[OTHER_SAVED_ID]?.settings).toEqual({ theme: "system" });
  });

  it("rolls back only the failing environment when its daemon rejects the write", async () => {
    savedUpdateSettings.mockRejectedValueOnce(new Error("nope"));

    await expect(
      updateEnvironmentSettings(SAVED_ID, { theme: "light" } as ServerSettingsPatch),
    ).rejects.toThrow("nope");

    expect(savedConfigs[SAVED_ID]?.settings).toEqual({ theme: "dark" });
    expect(applySettingsUpdated).not.toHaveBeenCalled();
  });

  it("restores primary settings when the local daemon rejects the write", async () => {
    primaryUpdateSettings.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      updateEnvironmentSettings(PRIMARY_ID, { theme: "dark" } as ServerSettingsPatch),
    ).rejects.toThrow("disk full");

    expect(applySettingsUpdated).toHaveBeenLastCalledWith({ theme: "light" });
  });

  it("refuses to write to an environment with no live connection instead of falling back", async () => {
    connectedEnvironmentIds.delete(SAVED_ID);

    await expect(
      updateEnvironmentSettings(SAVED_ID, { theme: "light" } as ServerSettingsPatch),
    ).rejects.toThrow(/Reconnect this environment/);
    expect(primaryUpdateSettings).not.toHaveBeenCalled();
  });
});

describe("refreshEnvironmentProviders", () => {
  beforeEach(() => {
    savedConfigs = { [SAVED_ID]: makeConfig({}) };
    connectedEnvironmentIds = new Set([SAVED_ID]);
    isPrimaryEnvironmentId.mockImplementation((id) => id === PRIMARY_ID);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes providers on the environment that was asked, not the local daemon", async () => {
    await refreshEnvironmentProviders(SAVED_ID, "codex-1" as never);

    expect(savedRefreshProviders).toHaveBeenCalledWith({ instanceId: "codex-1" });
    expect(primaryRefreshProviders).not.toHaveBeenCalled();
  });

  it("refuses when the environment is not connected", async () => {
    connectedEnvironmentIds.clear();

    await expect(refreshEnvironmentProviders(SAVED_ID)).rejects.toThrow(/Reconnect/);
    expect(primaryRefreshProviders).not.toHaveBeenCalled();
  });
});
