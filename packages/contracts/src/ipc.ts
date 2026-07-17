import type {
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  VcsCreateRefInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsPullInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  VcsStatusInput,
  VcsStatusResult,
  VcsCreateRefResult,
} from "./git.ts";
import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemReadFileInput,
  FilesystemReadFileResult,
  FilesystemWatchFileEvent,
  FilesystemWatchFileInput,
} from "./filesystem.ts";
import type {
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import type { ProviderInstanceId } from "./providerInstance.ts";
import type {
  BrowserBridgeStreamEvent,
  ServerConfig,
  ServerProviderUpdatedPayload,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import type { ServerUpsertKeybindingInput } from "./server.ts";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
} from "./orchestration.ts";
import type { EnvironmentId } from "./baseSchemas.ts";
import type {
  AuthBearerBootstrapResult,
  AuthSessionState,
  AuthWebSocketTokenResult,
} from "./auth.ts";
import type { AdvertisedEndpoint } from "./remoteAccess.ts";
import { EditorId } from "./editor.ts";
import type { ExecutionEnvironmentDescriptor } from "./environment.ts";
import type { ClientSettings, ServerSettings, ServerSettingsPatch } from "./settings.ts";
import type { UnoCreateLlmTopUpActionResult } from "./rpc.ts";
import type {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import type {
  UnoVideoCancelJobInput,
  UnoVideoCancelJobResult,
  UnoVideoCompleteUploadInput,
  UnoVideoCompleteUploadResult,
  UnoVideoCreateJobInput,
  UnoVideoCreateJobResult,
  UnoVideoCreateUploadInput,
  UnoVideoCreateUploadResult,
  UnoVideoGetDigestInput,
  UnoVideoGetJobInput,
  UnoVideoJobResult,
  VideoContextPack,
  VideoContextPackInput,
  VideoDigest,
} from "./video.ts";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  children?: readonly ContextMenuItem<T>[];
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";
export type DesktopUpdateChannel = "latest" | "nightly";
export type DesktopAppStageLabel = "Alpha" | "Dev" | "Nightly";

export interface DesktopAppBranding {
  baseName: string;
  stageLabel: DesktopAppStageLabel;
  displayName: string;
}

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  channel: DesktopUpdateChannel;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}

export interface DesktopEnvironmentBootstrap {
  label: string;
  httpBaseUrl: string | null;
  wsBaseUrl: string | null;
  bootstrapToken?: string;
}

export interface DesktopSshEnvironmentTarget {
  alias: string;
  hostname: string;
  username: string | null;
  port: number | null;
}

export type DesktopSshHostSource = "ssh-config" | "known-hosts";

export interface DesktopDiscoveredSshHost extends DesktopSshEnvironmentTarget {
  source: DesktopSshHostSource;
}

export interface DesktopSshEnvironmentBootstrap {
  target: DesktopSshEnvironmentTarget;
  httpBaseUrl: string;
  wsBaseUrl: string;
  pairingToken: string | null;
  remotePort?: number;
  remoteServerKind?: "external" | "managed";
}

export interface DesktopSshPasswordPromptRequest {
  requestId: string;
  destination: string;
  username: string | null;
  prompt: string;
  expiresAt: string;
}

export type DesktopSshTunnelStateKind =
  /** Tunnel process is running and the forwarded endpoint answered. */
  | "up"
  /** Tunnel died; the desktop supervisor is respawning it with backoff. */
  | "reconnecting"
  /**
   * Supervisor stopped: reconnecting needs credentials the desktop cannot
   * supply non-interactively. A manual reconnect is required.
   */
  | "auth-required"
  /** Tunnel is down and no further automatic attempts are scheduled. */
  | "down";

export interface DesktopSshTunnelState {
  target: DesktopSshEnvironmentTarget;
  state: DesktopSshTunnelStateKind;
  /** Consecutive failed respawn attempts (0 when up). */
  attempt: number;
  localPort: number | null;
  httpBaseUrl: string | null;
  wsBaseUrl: string | null;
  error: string | null;
}

export interface PersistedSavedEnvironmentRecord {
  environmentId: EnvironmentId;
  label: string;
  wsBaseUrl: string;
  httpBaseUrl: string;
  createdAt: string;
  lastConnectedAt: string | null;
  desktopSsh?: DesktopSshEnvironmentTarget;
}

export type DesktopServerExposureMode = "local-only" | "network-accessible";

export interface DesktopServerExposureState {
  mode: DesktopServerExposureMode;
  endpointUrl: string | null;
  advertisedHost: string | null;
  tailscaleServeEnabled: boolean;
  tailscaleServePort: number;
}

export type BrowserCredentialScope = "account" | "project";

/**
 * Site credential metadata for the built-in browser. The password itself is
 * never returned by list calls — it is stored encrypted (Electron safeStorage)
 * and only decrypted on demand via `revealBrowserCredentialPassword`.
 */
export interface BrowserCredentialRecord {
  readonly id: string;
  /** Origin the credential applies to, e.g. "https://github.com". */
  readonly origin: string;
  readonly username: string;
  readonly scope: BrowserCredentialScope;
  /** Logical project key when scope is "project". */
  readonly projectKey?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BrowserCredentialInput {
  readonly id?: string;
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  readonly scope: BrowserCredentialScope;
  readonly projectKey?: string;
}

export interface BrowserClearDataInput {
  readonly partition: string;
  readonly origin?: string;
  readonly cookies?: boolean;
  readonly cache?: boolean;
}

export interface PickFolderOptions {
  initialPath?: string | null;
}

export interface DesktopBridge {
  getAppBranding: () => DesktopAppBranding | null;
  getLocalEnvironmentBootstrap: () => DesktopEnvironmentBootstrap | null;
  getClientSettings: () => Promise<ClientSettings | null>;
  setClientSettings: (settings: ClientSettings) => Promise<void>;
  getSavedEnvironmentRegistry: () => Promise<readonly PersistedSavedEnvironmentRecord[]>;
  setSavedEnvironmentRegistry: (
    records: readonly PersistedSavedEnvironmentRecord[],
  ) => Promise<void>;
  getSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<string | null>;
  setSavedEnvironmentSecret: (environmentId: EnvironmentId, secret: string) => Promise<boolean>;
  removeSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<void>;
  discoverSshHosts: () => Promise<readonly DesktopDiscoveredSshHost[]>;
  ensureSshEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { issuePairingToken?: boolean },
  ) => Promise<DesktopSshEnvironmentBootstrap>;
  disconnectSshEnvironment: (target: DesktopSshEnvironmentTarget) => Promise<void>;
  fetchSshEnvironmentDescriptor: (httpBaseUrl: string) => Promise<ExecutionEnvironmentDescriptor>;
  bootstrapSshBearerSession: (
    httpBaseUrl: string,
    credential: string,
  ) => Promise<AuthBearerBootstrapResult>;
  fetchSshSessionState: (httpBaseUrl: string, bearerToken: string) => Promise<AuthSessionState>;
  issueSshWebSocketToken: (
    httpBaseUrl: string,
    bearerToken: string,
  ) => Promise<AuthWebSocketTokenResult>;
  onSshPasswordPrompt: (listener: (request: DesktopSshPasswordPromptRequest) => void) => () => void;
  resolveSshPasswordPrompt: (requestId: string, password: string | null) => Promise<void>;
  onSshTunnelState: (listener: (state: DesktopSshTunnelState) => void) => () => void;
  getServerExposureState: () => Promise<DesktopServerExposureState>;
  setServerExposureMode: (mode: DesktopServerExposureMode) => Promise<DesktopServerExposureState>;
  setTailscaleServeEnabled: (input: {
    readonly enabled: boolean;
    readonly port?: number;
  }) => Promise<DesktopServerExposureState>;
  getAdvertisedEndpoints: () => Promise<readonly AdvertisedEndpoint[]>;
  pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getWindowFullscreenState: () => boolean;
  onWindowFullscreenChange: (listener: (isFullscreen: boolean) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  setUpdateChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  getUnoCodeInstallState: () => Promise<UnoCodeInstallState>;
  retryUnoCodeInstall: () => Promise<void>;
  onUnoCodeInstallState: (listener: (state: UnoCodeInstallState) => void) => () => void;
  listBrowserCredentials: () => Promise<readonly BrowserCredentialRecord[]>;
  /** Returns null when OS-level encryption is unavailable. */
  saveBrowserCredential: (input: BrowserCredentialInput) => Promise<BrowserCredentialRecord | null>;
  deleteBrowserCredential: (id: string) => Promise<void>;
  /** Returns the decrypted password, or null if missing/undecryptable. */
  revealBrowserCredentialPassword: (id: string) => Promise<string | null>;
  clearBrowserData: (input: BrowserClearDataInput) => Promise<void>;
  /** Fired when a page inside the embedded browser asks to open a new window. */
  onBrowserOpenUrlRequest: (listener: (url: string) => void) => () => void;
}

export type UnoCodeInstallPhase =
  | "fetching-release"
  | "downloading"
  | "extracting"
  | "verifying"
  | "done";

export type UnoCodeInstallState =
  | { readonly status: "idle" }
  | {
      readonly status: "installing";
      readonly phase: UnoCodeInstallPhase;
      readonly percent?: number;
      readonly message?: string;
    }
  | { readonly status: "installed"; readonly binaryPath: string; readonly version: string }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly code?: string;
      /** True when the desktop shell will retry the install automatically (transient error). */
      readonly willRetry?: boolean;
      /** Epoch ms of the next scheduled automatic retry, when {@link willRetry} is set. */
      readonly nextRetryAt?: number;
    };

/**
 * APIs bound to the local app shell, not to any particular backend environment.
 *
 * These capabilities describe the desktop/browser host that the user is
 * currently running: dialogs, editor/external-link opening, context menus, and
 * app-level settings/config access. They must not be used as a proxy for
 * "whatever environment the user is targeting", because in a multi-environment
 * world the local shell and a selected backend environment are distinct
 * concepts.
 */
export interface LocalApi {
  dialogs: {
    pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  persistence: {
    getClientSettings: () => Promise<ClientSettings | null>;
    setClientSettings: (settings: ClientSettings) => Promise<void>;
    getSavedEnvironmentRegistry: () => Promise<readonly PersistedSavedEnvironmentRecord[]>;
    setSavedEnvironmentRegistry: (
      records: readonly PersistedSavedEnvironmentRecord[],
    ) => Promise<void>;
    getSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<string | null>;
    setSavedEnvironmentSecret: (environmentId: EnvironmentId, secret: string) => Promise<boolean>;
    removeSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<void>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    /**
     * Refresh provider snapshots. When `input.instanceId` is supplied only that
     * configured instance is probed; otherwise every configured instance is
     * refreshed (legacy untargeted refresh).
     */
    refreshProviders: (input?: {
      readonly instanceId?: ProviderInstanceId;
    }) => Promise<ServerProviderUpdatedPayload>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    getSettings: () => Promise<ServerSettings>;
    updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
    discoverSourceControl: () => Promise<SourceControlDiscoveryResult>;
    createUnoLlmTopUpAction: (input?: {
      readonly amount?: number;
    }) => Promise<UnoCreateLlmTopUpActionResult>;
    createUnoVideoUpload: (input: UnoVideoCreateUploadInput) => Promise<UnoVideoCreateUploadResult>;
    completeUnoVideoUpload: (
      input: UnoVideoCompleteUploadInput,
    ) => Promise<UnoVideoCompleteUploadResult>;
    createUnoVideoJob: (input: UnoVideoCreateJobInput) => Promise<UnoVideoCreateJobResult>;
    getUnoVideoJob: (input: UnoVideoGetJobInput) => Promise<UnoVideoJobResult>;
    cancelUnoVideoJob: (input: UnoVideoCancelJobInput) => Promise<UnoVideoCancelJobResult>;
    getUnoVideoDigest: (input: UnoVideoGetDigestInput) => Promise<VideoDigest>;
    packUnoVideoDigest: (input: VideoContextPackInput) => Promise<VideoContextPack>;
  };
}

/**
 * APIs bound to a specific backend environment connection.
 *
 * These operations must always be routed with explicit environment context.
 * They represent remote stateful capabilities such as orchestration, terminal,
 * project, VCS, and provider operations. In multi-environment mode, each environment gets
 * its own instance of this surface, and callers should resolve it by
 * `environmentId` rather than reaching through the local desktop bridge.
 */
export interface EnvironmentApi {
  terminal: {
    open: (input: typeof TerminalOpenInput.Encoded) => Promise<TerminalSessionSnapshot>;
    write: (input: typeof TerminalWriteInput.Encoded) => Promise<void>;
    resize: (input: typeof TerminalResizeInput.Encoded) => Promise<void>;
    clear: (input: typeof TerminalClearInput.Encoded) => Promise<void>;
    restart: (input: typeof TerminalRestartInput.Encoded) => Promise<TerminalSessionSnapshot>;
    close: (input: typeof TerminalCloseInput.Encoded) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  filesystem: {
    browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
    readFile: (input: FilesystemReadFileInput) => Promise<FilesystemReadFileResult>;
    watchFile: (
      input: FilesystemWatchFileInput,
      callback: (event: FilesystemWatchFileEvent) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  sourceControl: {
    lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Promise<SourceControlRepositoryInfo>;
    cloneRepository: (
      input: SourceControlCloneRepositoryInput,
    ) => Promise<SourceControlCloneRepositoryResult>;
    publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Promise<SourceControlPublishRepositoryResult>;
  };
  vcs: {
    listRefs: (input: VcsListRefsInput) => Promise<VcsListRefsResult>;
    createWorktree: (input: VcsCreateWorktreeInput) => Promise<VcsCreateWorktreeResult>;
    removeWorktree: (input: VcsRemoveWorktreeInput) => Promise<void>;
    createRef: (input: VcsCreateRefInput) => Promise<VcsCreateRefResult>;
    switchRef: (input: VcsSwitchRefInput) => Promise<VcsSwitchRefResult>;
    init: (input: VcsInitInput) => Promise<void>;
    pull: (input: VcsPullInput) => Promise<VcsPullResult>;
    refreshStatus: (input: VcsStatusInput) => Promise<VcsStatusResult>;
    onStatus: (
      input: VcsStatusInput,
      callback: (status: VcsStatusResult) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  git: {
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
  };
  orchestration: {
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    subscribeShell: (
      callback: (event: OrchestrationShellStreamItem) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
    subscribeThread: (
      input: OrchestrationSubscribeThreadInput,
      callback: (event: OrchestrationThreadStreamItem) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  browser: {
    /** Live "open this URL in the built-in browser pane" pushes from harnesses. */
    subscribeBridge: (callback: (event: BrowserBridgeStreamEvent) => void) => () => void;
  };
}
