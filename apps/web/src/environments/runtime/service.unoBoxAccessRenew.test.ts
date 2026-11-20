import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockSavedRecords: Array<Record<string, unknown>> = [];

const mockResolveRemotePairingTarget = vi.fn();
const mockFetchRemoteEnvironmentDescriptor = vi.fn();
const mockBootstrapRemoteBearerSession = vi.fn();
const mockFetchRemoteSessionState = vi.fn();
const mockIsRemoteEnvironmentAuthHttpError = vi.fn((_: unknown) => false);
const mockResolveRemoteWebSocketConnectionUrl = vi.fn();
const mockBootstrapSshBearerSession = vi.fn();
const mockFetchSshSessionState = vi.fn();
const mockPersistSavedEnvironmentRecord = vi.fn();
const mockWriteSavedEnvironmentBearerToken = vi.fn();
const mockSetSavedEnvironmentRegistry = vi.fn();
const mockGetSavedEnvironmentRecord = vi.fn((environmentId: EnvironmentId) => {
  return mockSavedRecords.find((record) => record.environmentId === environmentId) ?? null;
});
const mockReadSavedEnvironmentBearerToken = vi.fn();
const mockRemoveSavedEnvironmentBearerToken = vi.fn();
const mockPatchRuntime = vi.fn();
const mockClearRuntime = vi.fn();
const mockRegistrySetState = vi.fn((next: { byId: Record<string, Record<string, unknown>> }) => {
  mockSavedRecords = Object.values(next.byId);
});
const mockRemove = vi.fn((environmentId: EnvironmentId) => {
  mockSavedRecords = mockSavedRecords.filter((record) => record.environmentId !== environmentId);
});
const mockMarkConnected = vi.fn((environmentId: EnvironmentId, connectedAt: string) => {
  mockSavedRecords = mockSavedRecords.map((record) =>
    record.environmentId === environmentId ? { ...record, lastConnectedAt: connectedAt } : record,
  );
});
const mockRename = vi.fn((environmentId: EnvironmentId, label: string) => {
  mockSavedRecords = mockSavedRecords.map((record) =>
    record.environmentId === environmentId ? { ...record, label } : record,
  );
});
const mockUpsert = vi.fn((record: Record<string, unknown>) => {
  mockSavedRecords = [
    ...mockSavedRecords.filter((entry) => entry.environmentId !== record.environmentId),
    record,
  ];
});
const mockListSavedEnvironmentRecords = vi.fn(() => mockSavedRecords);
const mockEnsureSshEnvironment = vi.fn();
const mockDisconnectSshEnvironment = vi.fn();
const mockFetchSshEnvironmentDescriptor = vi.fn();
const mockToPersistedSavedEnvironmentRecord = vi.fn((record) => record);
const mockCreateEnvironmentConnection = vi.fn();
const mockConnectBox = vi.fn();
const mockWsTransport = vi.fn();
const mockClientGetConfig = vi.fn(async () => ({
  environment: {
    environmentId: EnvironmentId.make("environment-1"),
    label: "Remote environment",
  },
}));

vi.mock("../remote/target", () => ({
  resolveRemotePairingTarget: mockResolveRemotePairingTarget,
}));

vi.mock("../remote/api", () => ({
  bootstrapRemoteBearerSession: mockBootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor: mockFetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState: mockFetchRemoteSessionState,
  isRemoteEnvironmentAuthHttpError: mockIsRemoteEnvironmentAuthHttpError,
  resolveRemoteWebSocketConnectionUrl: mockResolveRemoteWebSocketConnectionUrl,
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      setSavedEnvironmentRegistry: mockSetSavedEnvironmentRegistry,
    },
  }),
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: mockGetSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated: vi.fn(),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: mockPersistSavedEnvironmentRecord,
  readSavedEnvironmentBearerToken: mockReadSavedEnvironmentBearerToken,
  removeSavedEnvironmentBearerToken: mockRemoveSavedEnvironmentBearerToken,
  toPersistedSavedEnvironmentRecord: mockToPersistedSavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore: {
    getState: () => ({
      upsert: mockUpsert,
      remove: mockRemove,
      markConnected: mockMarkConnected,
      rename: mockRename,
    }),
    setState: mockRegistrySetState,
    subscribe: vi.fn(() => () => {}),
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      ensure: vi.fn(),
      patch: mockPatchRuntime,
      clear: mockClearRuntime,
    }),
  },
  waitForSavedEnvironmentRegistryHydration: vi.fn(),
  writeSavedEnvironmentBearerToken: mockWriteSavedEnvironmentBearerToken,
}));

vi.mock("./connection", () => ({
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

vi.mock("../../rpc/wsRpcClient", () => ({
  createWsRpcClient: vi.fn(() => ({
    server: {
      getConfig: mockClientGetConfig,
    },
    orchestration: {
      subscribeThread: vi.fn(() => () => {}),
    },
    unoCloud: {
      connectBox: mockConnectBox,
    },
  })),
}));

vi.mock("../../rpc/wsTransport", () => ({
  WsTransport: mockWsTransport,
}));

vi.mock("../primary", () => ({
  getPrimaryKnownEnvironment: () => ({
    id: "primary",
    label: "This computer",
    source: "window-origin",
    environmentId: EnvironmentId.make("environment-primary"),
    target: { httpBaseUrl: "http://127.0.0.1:3773/", wsBaseUrl: "ws://127.0.0.1:3773/" },
  }),
}));

const BOX_ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const AUTH_ERROR = { status: 401, message: "Session token expired." };

function cloudComputerRecord(overrides?: Record<string, unknown>) {
  return {
    environmentId: BOX_ENVIRONMENT_ID,
    label: "uno-product",
    httpBaseUrl: "https://remote.example.com/",
    wsBaseUrl: "wss://remote.example.com/",
    createdAt: "2026-10-08T20:24:54.624Z",
    lastConnectedAt: "2026-11-07T19:51:19.514Z",
    unoBoxId: 2507,
    ...overrides,
  };
}

/** The url resolver the service handed to the saved environment's transport. */
function savedEnvironmentUrlResolver(): () => Promise<string> {
  const call = mockWsTransport.mock.calls.findLast((args) => typeof args[0] === "function");
  if (!call) throw new Error("No saved environment transport was created.");
  return call[0] as () => Promise<string>;
}

describe("renewing a cloud computer's expired access", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockSavedRecords = [cloudComputerRecord()];
    vi.stubGlobal("window", {});
    mockResolveRemotePairingTarget.mockReturnValue({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      credential: "one-time-link-token",
    });
    mockFetchRemoteEnvironmentDescriptor.mockResolvedValue({
      environmentId: BOX_ENVIRONMENT_ID,
      label: "uno-product",
    });
    mockBootstrapRemoteBearerSession.mockReset();
    mockBootstrapRemoteBearerSession.mockResolvedValue({
      sessionToken: "fresh-token",
      role: "owner",
    });
    mockFetchRemoteSessionState.mockReset();
    mockFetchRemoteSessionState.mockResolvedValue({ authenticated: true, role: "owner" });
    mockIsRemoteEnvironmentAuthHttpError.mockImplementation(
      (error: unknown) => error === AUTH_ERROR,
    );
    mockResolveRemoteWebSocketConnectionUrl.mockReset();
    mockResolveRemoteWebSocketConnectionUrl.mockResolvedValue(
      "wss://remote.example.com/?wsToken=remote-token",
    );
    mockPersistSavedEnvironmentRecord.mockResolvedValue(undefined);
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
    mockSetSavedEnvironmentRegistry.mockResolvedValue(undefined);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("expired-token");
    mockRemoveSavedEnvironmentBearerToken.mockResolvedValue(undefined);
    mockConnectBox.mockReset();
    mockConnectBox.mockResolvedValue({
      boxId: 2507,
      url: "https://remote.example.com/pair#token=one-time-link-token",
    });
    mockCreateEnvironmentConnection.mockImplementation(
      (input: { knownEnvironment: { environmentId: EnvironmentId }; client: unknown }) => ({
        kind: "saved",
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: input.client,
        ensureBootstrapped: async () => undefined,
        reconnect: async () => undefined,
        dispose: async () => undefined,
      }),
    );
    mockClientGetConfig.mockResolvedValue({
      environment: { environmentId: BOX_ENVIRONMENT_ID, label: "uno-product" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pairs the computer again through the Uno account when its session is refused", async () => {
    mockFetchRemoteSessionState.mockRejectedValueOnce(AUTH_ERROR);

    const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    await expect(reconnectSavedEnvironment(BOX_ENVIRONMENT_ID)).resolves.toBeUndefined();

    expect(mockConnectBox).toHaveBeenCalledTimes(1);
    expect(mockConnectBox).toHaveBeenCalledWith({ boxId: 2507 });
    expect(mockResolveRemotePairingTarget).toHaveBeenCalledWith({
      pairingUrl: "https://remote.example.com/pair#token=one-time-link-token",
    });
    expect(mockWriteSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      BOX_ENVIRONMENT_ID,
      "fresh-token",
    );
    // The record keeps its identity: same environment, same box, same age.
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: BOX_ENVIRONMENT_ID,
        unoBoxId: 2507,
        createdAt: "2026-10-08T20:24:54.624Z",
      }),
    );

    await resetEnvironmentServiceForTests();
  });

  it("renews in the background when a live connection is refused a ws token", async () => {
    const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");
    const { healSavedEnvironment } = await import("./selfHeal");

    // Connected with a session that is still good…
    await reconnectSavedEnvironment(BOX_ENVIRONMENT_ID);
    expect(mockConnectBox).not.toHaveBeenCalled();

    // …which the daemon then refuses on the next socket (the 30 days are up).
    mockResolveRemoteWebSocketConnectionUrl.mockRejectedValueOnce(AUTH_ERROR);
    await expect(savedEnvironmentUrlResolver()()).rejects.toBe(AUTH_ERROR);
    await healSavedEnvironment(BOX_ENVIRONMENT_ID, "join the run the refusal started");

    expect(mockConnectBox).toHaveBeenCalledTimes(1);
    expect(mockWriteSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      BOX_ENVIRONMENT_ID,
      "fresh-token",
    );

    await resetEnvironmentServiceForTests();
  });

  it("does not use the account for a computer that was paired by hand", async () => {
    mockSavedRecords = [cloudComputerRecord({ unoBoxId: undefined })];
    mockFetchRemoteSessionState.mockRejectedValueOnce(AUTH_ERROR);

    const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    await expect(reconnectSavedEnvironment(BOX_ENVIRONMENT_ID)).rejects.toThrow(
      "Saved environment credential expired. Pair it again.",
    );
    expect(mockConnectBox).not.toHaveBeenCalled();

    await resetEnvironmentServiceForTests();
  });

  it("tells the person why a manual reconnect could not renew the access", async () => {
    mockFetchRemoteSessionState.mockRejectedValueOnce(AUTH_ERROR);
    mockConnectBox.mockRejectedValue(new Error("Uno account is not linked."));

    const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");

    await expect(reconnectSavedEnvironment(BOX_ENVIRONMENT_ID)).rejects.toThrow(
      "Uno Work could not renew its access to uno-product: Uno account is not linked.",
    );

    await resetEnvironmentServiceForTests();
  });

  it("stops renewing automatically after repeated failures, until a manual reconnect", async () => {
    mockFetchRemoteSessionState.mockRejectedValueOnce(AUTH_ERROR);
    mockConnectBox.mockRejectedValue(new Error("control plane is down"));

    const { reconnectSavedEnvironment, resetEnvironmentServiceForTests } =
      await import("./service");
    const { getSelfHealNeedsAttention, healSavedEnvironment } = await import("./selfHeal");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await healSavedEnvironment(BOX_ENVIRONMENT_ID, "test", { immediate: true });
    }
    expect(mockConnectBox).toHaveBeenCalledTimes(5);
    expect(getSelfHealNeedsAttention(BOX_ENVIRONMENT_ID)?.kind).toBe("access-expired");

    // Blocked: further automatic runs neither retry the session nor the account.
    await healSavedEnvironment(BOX_ENVIRONMENT_ID, "test", { immediate: true });
    expect(mockConnectBox).toHaveBeenCalledTimes(5);

    // The person presses Reconnect once the account works again.
    mockConnectBox.mockResolvedValue({
      boxId: 2507,
      url: "https://remote.example.com/pair#token=one-time-link-token",
    });
    await expect(reconnectSavedEnvironment(BOX_ENVIRONMENT_ID)).resolves.toBeUndefined();
    expect(getSelfHealNeedsAttention(BOX_ENVIRONMENT_ID)).toBeNull();
    expect(mockWriteSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      BOX_ENVIRONMENT_ID,
      "fresh-token",
    );

    await resetEnvironmentServiceForTests();
  });
});
