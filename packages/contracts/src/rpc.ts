import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { EnvironmentId } from "./baseSchemas.ts";
import {
  UnoBoxConnection,
  UnoBoxCreateJobStatus,
  UnoCloudState,
  WorkspaceInstructions,
  WorkspaceMachineKind,
  WorkspaceMachineScope,
  WorkspaceState,
} from "./workspace.ts";
import { OpenError, OpenInEditorInput } from "./editor.ts";
import {
  UnoComputerActivity,
  UnoComputerActivityInput,
  UnoComputerApps,
  UnoComputerInstallAppInput,
  UnoComputerInstallAppResult,
  UnoComputerInstallStatus,
  UnoComputerInstallStatusInput,
  UnoComputerMetrics,
  UnoComputerLocalMetrics,
  UnoComputerPowerInput,
  UnoComputerResizeInput,
  UnoComputerResizeOptions,
  UnoComputerResizeResult,
  UnoComputerState,
  UnoComputerTargetInput,
  UnoMachineAppActionInput,
  UnoMachineApps,
} from "./unoComputer.ts";
import {
  FilesCreateFolderInput,
  FilesDeleteInput,
  FilesDeleteResult,
  FilesEntry,
  FilesError,
  FilesListInput,
  FilesListResult,
  FilesMoveInput,
  FilesMoveResult,
  FilesPublishSiteInput,
  FilesPublishSiteResult,
  FilesRenameInput,
  FilesSearchInput,
  FilesSearchResult,
  FilesShare,
  FilesShareCreateInput,
  FilesShareListInput,
  FilesShareListResult,
  FilesShareRevokeInput,
  FilesStatInput,
  FilesCloudState,
  FilesCloudListInput,
  FilesCloudListResult,
  FilesCloudBucket,
  FilesCloudCreateBucketInput,
  FilesCloudObjectInput,
  FilesCloudDeleteResult,
  FilesCloudDownloadUrl,
  FilesCloudCopyToCloudInput,
  FilesCloudCopyToComputerInput,
  FilesCloudTransferResult,
} from "./files.ts";
import { AuthAccessStreamEvent, AuthLinkRequestStreamEvent } from "./auth.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
  FilesystemReadFileInput,
  FilesystemReadFileResult,
  FilesystemReadFileError,
  FilesystemWatchFileInput,
  FilesystemWatchFileEvent,
  FilesystemWatchFileError,
} from "./filesystem.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  ThreadContinueCleanupInput,
  ThreadContinueCleanupResult,
  ThreadContinueCompleteInput,
  ThreadContinueCompleteResult,
  ThreadContinueDiscardInput,
  ThreadContinueDiscardResult,
  ThreadContinueError,
  ThreadContinueInspectInput,
  ThreadContinueInspectResult,
  ThreadContinueLandInput,
  ThreadContinueLandResult,
  ThreadContinuePrepareInput,
  ThreadContinuePrepareResult,
  ThreadContinueReadChunkInput,
  ThreadContinueReadChunkResult,
  ThreadContinueReceiveInput,
  ThreadContinueReceiveResult,
  ThreadContinueSnapshotInput,
  ThreadContinueSnapshotResult,
  ThreadContinueWriteChunkInput,
  ThreadContinueWriteChunkResult,
} from "./threadContinue.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
} from "./orchestration.ts";
import {
  PluginResolvePanelThreadInput,
  PluginResolvePanelThreadResult,
  PluginSendToThreadInput,
  PluginSendToThreadResult,
  PluginsError,
  PluginsSnapshot,
  SetPluginEnabledInput,
} from "./plugins.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ProviderAuthJobStatus,
  ProviderAuthStartInput,
  ProviderAuthStartResult,
  ProviderAuthStatusInput,
  ProviderAuthSubmitCodeInput,
  ProviderInstallJobStatus,
  ProviderInstallStartInput,
  ProviderInstallStartResult,
  ProviderInstallStatusInput,
  ProviderSetupRpcError,
} from "./providerSetup.ts";
import {
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  BrowserBridgeStreamEvent,
  ServerConfigStreamEvent,
  ServerConfig,
  ServerLifecycleStreamEvent,
  ServerProviderUpdatedPayload,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  CredentialDeletePayload,
  CredentialFillPayload,
  CredentialFillResult,
  CredentialSyncPayload,
  CredentialSyncResult,
  CredentialImportPayload,
  CredentialImportResult,
  CredentialListResult,
  CredentialMetadata,
  CredentialUpsertPayload,
  CredentialsVaultError,
} from "./credentialsVault.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";
import {
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
  UnoVideoRpcError,
  VideoContextPack,
  VideoContextPackInput,
  VideoDigest,
} from "./video.ts";
import {
  UnoTranscribeAudioInput,
  UnoTranscribeAudioResult,
  UnoTranscriptionError,
} from "./transcription.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  filesystemReadFile: "filesystem.readFile",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Continue a chat on another machine, files sent through the client
  // (source: snapshot/readChunk/complete, target: inspect/writeChunk/land)
  threadContinueInspect: "thread.continue.inspect",
  threadContinueSnapshot: "thread.continue.snapshot",
  threadContinueReadChunk: "thread.continue.readChunk",
  threadContinueWriteChunk: "thread.continue.writeChunk",
  threadContinueLand: "thread.continue.land",
  threadContinueDiscard: "thread.continue.discard",
  threadContinueComplete: "thread.continue.complete",
  // 0.0.53–0.0.56 protocol (pushed through origin); answered with an update error
  threadContinuePrepare: "thread.continue.prepare",
  threadContinueReceive: "thread.continue.receive",
  threadContinueCleanup: "thread.continue.cleanup",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverListPlugins: "server.listPlugins",
  serverSetPluginEnabled: "server.setPluginEnabled",
  pluginsSendToThread: "plugins.sendToThread",
  pluginsResolvePanelThread: "plugins.resolvePanelThread",

  // Credentials vault methods (Settings panel, both shells)
  vaultList: "vault.list",
  vaultUpsert: "vault.upsert",
  vaultDelete: "vault.delete",
  vaultImport: "vault.import",
  vaultFill: "vault.fill",
  vaultSync: "vault.sync",

  // Uno account / billing methods
  unoCreateLlmTopUpAction: "uno.createLlmTopUpAction",
  unoVideoCreateUpload: "uno.video.createUpload",
  unoVideoCompleteUpload: "uno.video.completeUpload",
  unoVideoCreateJob: "uno.video.createJob",
  unoVideoGetJob: "uno.video.getJob",
  unoVideoCancelJob: "uno.video.cancelJob",
  unoVideoGetDigest: "uno.video.getDigest",
  unoVideoPackDigest: "uno.video.packDigest",
  unoTranscribeAudio: "uno.transcribeAudio",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",

  // Workspace registry: machines, rules, claims, cross-environment requests
  workspaceGetState: "workspace.getState",
  workspaceRename: "workspace.rename",
  workspaceSyncMachines: "workspace.syncMachines",
  workspaceUpdateMachine: "workspace.updateMachine",
  workspaceRemoveMachine: "workspace.removeMachine",
  workspaceGetInstructions: "workspace.getInstructions",
  workspaceSetInstructions: "workspace.setInstructions",
  workspaceApplyInstructions: "workspace.applyInstructions",

  // Uno cloud: the account behind the workspace and its boxes
  unoCloudGetState: "uno.cloud.getState",
  unoCloudBoxPower: "uno.cloud.boxPower",
  unoCloudConnectBox: "uno.cloud.connectBox",
  unoCloudCreateBox: "uno.cloud.createBox",
  unoCloudCreateBoxStatus: "uno.cloud.createBoxStatus",

  // "This computer": the desktop view of the machine the daemon runs on
  unoComputerGetState: "uno.computer.getState",
  unoComputerMetrics: "uno.computer.metrics",
  unoComputerActivity: "uno.computer.activity",
  unoComputerApps: "uno.computer.apps",
  unoComputerInstallApp: "uno.computer.installApp",
  unoComputerInstallStatus: "uno.computer.installStatus",
  unoComputerPower: "uno.computer.power",
  unoComputerMachineApps: "uno.computer.machineApps",
  unoComputerAppAction: "uno.computer.appAction",
  unoComputerLocalMetrics: "uno.computer.localMetrics",
  unoComputerResizeOptions: "uno.computer.resizeOptions",
  unoComputerResize: "uno.computer.resize",

  // Files — the computer's file manager (/files) and its public share links
  filesList: "files.list",
  filesStat: "files.stat",
  filesCreateFolder: "files.createFolder",
  filesRename: "files.rename",
  filesMove: "files.move",
  filesDelete: "files.delete",
  filesSearch: "files.search",
  filesShareCreate: "files.share.create",
  filesShareList: "files.share.list",
  filesShareRevoke: "files.share.revoke",
  filesPublishSite: "files.publishSite",
  filesCloudState: "files.cloud.state",
  filesCloudList: "files.cloud.list",
  filesCloudCreateBucket: "files.cloud.createBucket",
  filesCloudDelete: "files.cloud.delete",
  filesCloudDownloadUrl: "files.cloud.downloadUrl",
  filesCloudCopyToCloud: "files.cloud.copyToCloud",
  filesCloudCopyToComputer: "files.cloud.copyToComputer",

  // Provider setup: install a harness CLI / sign it in on this machine
  providerInstallStart: "provider.install.start",
  providerInstallStatus: "provider.install.status",
  providerAuthStart: "provider.auth.start",
  providerAuthStatus: "provider.auth.status",
  providerAuthSubmitCode: "provider.auth.submitCode",

  // Streaming subscriptions
  subscribeFileChanges: "subscribeFileChanges",
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeAuthLinkRequests: "subscribeAuthLinkRequests",
  subscribeBrowserBridge: "subscribeBrowserBridge",
  subscribePlugins: "subscribePlugins",

  // Mobile-compat: методы, которые зовёт апстримный T3-клиент (мобилка).
  // Имена должны буквально совпадать с upstream WS_METHODS.
  serverProbe: "server.probe",
  serverReportClientActivity: "server.reportClientActivity",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: KeybindingsConfigError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
});

/**
 * Mobile-compat: liveness-проба апстримного клиента. Пустой запрос/ответ —
 * важен сам факт успешного round-trip. Payload намеренно Struct({}) — лишние
 * поля апстримных версий игнорируются decode'ом.
 */
export const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
});

/**
 * Mobile-compat: телеметрия активности апстримного клиента. Мы её не храним —
 * заглушка нужна, чтобы вызов не ронял WS-сессию defect-кадром
 * "Unknown request tag" (он у effect/rpc не привязан к requestId и валит
 * все in-flight запросы клиента разом).
 */
export const WsServerReportClientActivityRpc = Rpc.make(WS_METHODS.serverReportClientActivity, {
  payload: Schema.Struct({}),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
  }),
  success: ServerProviderUpdatedPayload,
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
});

export const WsVaultListRpc = Rpc.make(WS_METHODS.vaultList, {
  payload: Schema.Struct({}),
  success: CredentialListResult,
  error: CredentialsVaultError,
});

export const WsVaultUpsertRpc = Rpc.make(WS_METHODS.vaultUpsert, {
  payload: CredentialUpsertPayload,
  success: CredentialMetadata,
  error: CredentialsVaultError,
});

export const WsVaultDeleteRpc = Rpc.make(WS_METHODS.vaultDelete, {
  payload: CredentialDeletePayload,
  error: CredentialsVaultError,
});

export const WsVaultImportRpc = Rpc.make(WS_METHODS.vaultImport, {
  payload: CredentialImportPayload,
  success: CredentialImportResult,
  error: CredentialsVaultError,
});

export const WsVaultFillRpc = Rpc.make(WS_METHODS.vaultFill, {
  payload: CredentialFillPayload,
  success: CredentialFillResult,
  error: CredentialsVaultError,
});

export const WsVaultSyncRpc = Rpc.make(WS_METHODS.vaultSync, {
  payload: CredentialSyncPayload,
  success: CredentialSyncResult,
  error: CredentialsVaultError,
});

export const WsServerListPluginsRpc = Rpc.make(WS_METHODS.serverListPlugins, {
  payload: Schema.Struct({}),
  success: PluginsSnapshot,
  error: PluginsError,
});

export const WsServerSetPluginEnabledRpc = Rpc.make(WS_METHODS.serverSetPluginEnabled, {
  payload: SetPluginEnabledInput,
  success: PluginsSnapshot,
  error: PluginsError,
});

export const WsPluginsSendToThreadRpc = Rpc.make(WS_METHODS.pluginsSendToThread, {
  payload: PluginSendToThreadInput,
  success: PluginSendToThreadResult,
  error: PluginsError,
});

export const WsPluginsResolvePanelThreadRpc = Rpc.make(WS_METHODS.pluginsResolvePanelThread, {
  payload: PluginResolvePanelThreadInput,
  success: PluginResolvePanelThreadResult,
  error: PluginsError,
});

export const WsSubscribePluginsRpc = Rpc.make(WS_METHODS.subscribePlugins, {
  payload: Schema.Struct({}),
  success: PluginsSnapshot,
  error: PluginsError,
  stream: true,
});

export const UnoCreateLlmTopUpActionInput = Schema.Struct({
  amount: Schema.optional(Schema.Number),
});
export type UnoCreateLlmTopUpActionInput = typeof UnoCreateLlmTopUpActionInput.Type;

export const UnoCreateLlmTopUpActionResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("credits_bought"),
    llmBalance: Schema.Number,
    chargedFromBalance: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("payment_link"),
    paymentUrl: Schema.String,
    amount: Schema.Number,
  }),
]);
export type UnoCreateLlmTopUpActionResult = typeof UnoCreateLlmTopUpActionResult.Type;

export class UnoBillingRpcError extends Schema.TaggedErrorClass<UnoBillingRpcError>()(
  "UnoBillingRpcError",
  {
    message: Schema.String,
  },
) {}

export const WsUnoCreateLlmTopUpActionRpc = Rpc.make(WS_METHODS.unoCreateLlmTopUpAction, {
  payload: UnoCreateLlmTopUpActionInput,
  success: UnoCreateLlmTopUpActionResult,
  error: UnoBillingRpcError,
});

export const WsUnoVideoCreateUploadRpc = Rpc.make(WS_METHODS.unoVideoCreateUpload, {
  payload: UnoVideoCreateUploadInput,
  success: UnoVideoCreateUploadResult,
  error: UnoVideoRpcError,
});

export const WsUnoVideoCompleteUploadRpc = Rpc.make(WS_METHODS.unoVideoCompleteUpload, {
  payload: UnoVideoCompleteUploadInput,
  success: UnoVideoCompleteUploadResult,
  error: UnoVideoRpcError,
});

export const WsUnoVideoCreateJobRpc = Rpc.make(WS_METHODS.unoVideoCreateJob, {
  payload: UnoVideoCreateJobInput,
  success: UnoVideoCreateJobResult,
  error: UnoVideoRpcError,
});

export const WsUnoVideoGetJobRpc = Rpc.make(WS_METHODS.unoVideoGetJob, {
  payload: UnoVideoGetJobInput,
  success: UnoVideoJobResult,
  error: UnoVideoRpcError,
});

export const WsUnoVideoCancelJobRpc = Rpc.make(WS_METHODS.unoVideoCancelJob, {
  payload: UnoVideoCancelJobInput,
  success: UnoVideoCancelJobResult,
  error: UnoVideoRpcError,
});

export const WsUnoVideoGetDigestRpc = Rpc.make(WS_METHODS.unoVideoGetDigest, {
  payload: UnoVideoGetDigestInput,
  success: VideoDigest,
  error: UnoVideoRpcError,
});

export const WsUnoVideoPackDigestRpc = Rpc.make(WS_METHODS.unoVideoPackDigest, {
  payload: VideoContextPackInput,
  success: VideoContextPack,
  error: UnoVideoRpcError,
});

export const WsUnoTranscribeAudioRpc = Rpc.make(WS_METHODS.unoTranscribeAudio, {
  payload: UnoTranscribeAudioInput,
  success: UnoTranscribeAudioResult,
  error: UnoTranscriptionError,
});

export const WsSourceControlLookupRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlLookupRepository,
  {
    payload: SourceControlRepositoryLookupInput,
    success: SourceControlRepositoryInfo,
    error: SourceControlRepositoryError,
  },
);

export const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: SourceControlRepositoryError,
});

export const WsSourceControlPublishRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlPublishRepository,
  {
    payload: SourceControlPublishRepositoryInput,
    success: SourceControlPublishRepositoryResult,
    error: SourceControlRepositoryError,
  },
);

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: ProjectSearchEntriesError,
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: ProjectWriteFileError,
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: OpenInEditorInput,
  error: OpenError,
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: FilesystemBrowseError,
});

export const WsFilesystemReadFileRpc = Rpc.make(WS_METHODS.filesystemReadFile, {
  payload: FilesystemReadFileInput,
  success: FilesystemReadFileResult,
  error: FilesystemReadFileError,
});

export const WsSubscribeFileChangesRpc = Rpc.make(WS_METHODS.subscribeFileChanges, {
  payload: FilesystemWatchFileInput,
  success: FilesystemWatchFileEvent,
  error: FilesystemWatchFileError,
  stream: true,
});

export const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: GitCommandError,
});

export const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: GitManagerServiceError,
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: GitManagerServiceError,
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: GitManagerServiceError,
});

export const WsThreadContinueInspectRpc = Rpc.make(WS_METHODS.threadContinueInspect, {
  payload: ThreadContinueInspectInput,
  success: ThreadContinueInspectResult,
  error: ThreadContinueError,
});

export const WsThreadContinueSnapshotRpc = Rpc.make(WS_METHODS.threadContinueSnapshot, {
  payload: ThreadContinueSnapshotInput,
  success: ThreadContinueSnapshotResult,
  error: ThreadContinueError,
});

export const WsThreadContinueReadChunkRpc = Rpc.make(WS_METHODS.threadContinueReadChunk, {
  payload: ThreadContinueReadChunkInput,
  success: ThreadContinueReadChunkResult,
  error: ThreadContinueError,
});

export const WsThreadContinueWriteChunkRpc = Rpc.make(WS_METHODS.threadContinueWriteChunk, {
  payload: ThreadContinueWriteChunkInput,
  success: ThreadContinueWriteChunkResult,
  error: ThreadContinueError,
});

export const WsThreadContinueLandRpc = Rpc.make(WS_METHODS.threadContinueLand, {
  payload: ThreadContinueLandInput,
  success: ThreadContinueLandResult,
  error: ThreadContinueError,
});

export const WsThreadContinueDiscardRpc = Rpc.make(WS_METHODS.threadContinueDiscard, {
  payload: ThreadContinueDiscardInput,
  success: ThreadContinueDiscardResult,
  error: ThreadContinueError,
});

/** @deprecated 0.0.53–0.0.56 protocol; answers with an update error. */
export const WsThreadContinuePrepareRpc = Rpc.make(WS_METHODS.threadContinuePrepare, {
  payload: ThreadContinuePrepareInput,
  success: ThreadContinuePrepareResult,
  error: ThreadContinueError,
});

/** @deprecated 0.0.53–0.0.56 protocol; answers with an update error. */
export const WsThreadContinueReceiveRpc = Rpc.make(WS_METHODS.threadContinueReceive, {
  payload: ThreadContinueReceiveInput,
  success: ThreadContinueReceiveResult,
  error: ThreadContinueError,
});

/** @deprecated 0.0.53–0.0.56 protocol; answers with an update error. */
export const WsThreadContinueCleanupRpc = Rpc.make(WS_METHODS.threadContinueCleanup, {
  payload: ThreadContinueCleanupInput,
  success: ThreadContinueCleanupResult,
  error: ThreadContinueError,
});

export const WsThreadContinueCompleteRpc = Rpc.make(WS_METHODS.threadContinueComplete, {
  payload: ThreadContinueCompleteInput,
  success: ThreadContinueCompleteResult,
  error: ThreadContinueError,
});

export const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: GitCommandError,
});

export const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: GitCommandError,
});

export const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: GitCommandError,
});

export const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: GitCommandError,
});

export const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: GitCommandError,
});

export const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: VcsError,
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: TerminalError,
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: TerminalError,
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: TerminalError,
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: TerminalError,
});

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: OrchestrationDispatchCommandError,
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: OrchestrationGetTurnDiffError,
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: OrchestrationGetFullThreadDiffError,
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: OrchestrationReplayEventsError,
});

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: OrchestrationGetSnapshotError,
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: OrchestrationGetSnapshotError,
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  stream: true,
});

export const WsSubscribeBrowserBridgeRpc = Rpc.make(WS_METHODS.subscribeBrowserBridge, {
  payload: Schema.Struct({}),
  success: BrowserBridgeStreamEvent,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  stream: true,
});

/** Pending "use this computer" approvals, for the desktop prompt. Owner sessions only. */
export const WsSubscribeAuthLinkRequestsRpc = Rpc.make(WS_METHODS.subscribeAuthLinkRequests, {
  payload: Schema.Struct({}),
  success: AuthLinkRequestStreamEvent,
  stream: true,
});

/* ------------------------------------------------------------------ *
 * Workspace registry
 *
 * Every mutating call answers with the whole `WorkspaceState`. The registry is
 * small (machines, grants, claims, pending requests) and read by one panel, so
 * returning the snapshot removes an entire class of bug where a client applies
 * a local delta and drifts from the epoch it is displaying.
 * ------------------------------------------------------------------ */

export class WorkspaceRpcError extends Schema.TaggedErrorClass<WorkspaceRpcError>()(
  "WorkspaceRpcError",
  {
    message: Schema.String,
    /** Machine-readable reason so the UI can pick wording without parsing prose. */
    reason: Schema.optional(
      Schema.Literals([
        "policy_denied",
        "claim_taken",
        "budget_exhausted",
        "hop_limit",
        "not_found",
        "invalid_request",
      ]),
    ),
  },
) {}

export const WorkspaceGetStateInput = Schema.Struct({});
export type WorkspaceGetStateInput = typeof WorkspaceGetStateInput.Type;

/**
 * The client is the only party that knows which environments are actually
 * connected right now, so it pushes that list and the daemon reconciles the
 * registry against it. Machines already known but missing from the list are
 * kept: absence from one client's session is not evidence of removal.
 */
export const WorkspaceRenameInput = Schema.Struct({
  name: Schema.String,
});
export type WorkspaceRenameInput = typeof WorkspaceRenameInput.Type;

export const WorkspaceSyncMachinesInput = Schema.Struct({
  machines: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: Schema.String,
      kind: WorkspaceMachineKind,
      unoBoxId: Schema.optional(Schema.NullOr(Schema.Number)),
      lastSeenAt: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  /** Which of them is this client's registry daemon, if it knows. */
  registryEnvironmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
});
export type WorkspaceSyncMachinesInput = typeof WorkspaceSyncMachinesInput.Type;

export const WorkspaceUpdateMachineInput = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.optional(Schema.String),
  monogram: Schema.optional(Schema.String),
  colorSlot: Schema.optional(Schema.Number),
  scope: Schema.optional(WorkspaceMachineScope),
  repositories: Schema.optional(Schema.Array(Schema.String)),
});
export type WorkspaceUpdateMachineInput = typeof WorkspaceUpdateMachineInput.Type;

export const WorkspaceRemoveMachineInput = Schema.Struct({
  environmentId: EnvironmentId,
});
export type WorkspaceRemoveMachineInput = typeof WorkspaceRemoveMachineInput.Type;

export const WorkspaceGetInstructionsInput = Schema.Struct({
  environmentId: EnvironmentId,
  /** Optional project root, so the repository layer can be read from disk. */
  projectPath: Schema.optional(Schema.String),
});
export type WorkspaceGetInstructionsInput = typeof WorkspaceGetInstructionsInput.Type;

export const WorkspaceSetInstructionsInput = Schema.Struct({
  /** `*` is the workspace-wide layer; a concrete id is that machine's override. */
  scope: Schema.String,
  text: Schema.String,
});
export type WorkspaceSetInstructionsInput = typeof WorkspaceSetInstructionsInput.Type;

export const WorkspaceApplyInstructionsInput = Schema.Struct({
  environmentId: EnvironmentId,
  projectPath: Schema.String,
});
export type WorkspaceApplyInstructionsInput = typeof WorkspaceApplyInstructionsInput.Type;

export const WorkspaceApplyInstructionsResult = Schema.Struct({
  generatedPath: Schema.String,
  /** False when the user removed the marker block — we never put it back. */
  pointerWritten: Schema.Boolean,
  merged: Schema.String,
});
export type WorkspaceApplyInstructionsResult = typeof WorkspaceApplyInstructionsResult.Type;

export const WsWorkspaceGetStateRpc = Rpc.make(WS_METHODS.workspaceGetState, {
  payload: WorkspaceGetStateInput,
  success: WorkspaceState,
  error: WorkspaceRpcError,
});

export const WsWorkspaceRenameRpc = Rpc.make(WS_METHODS.workspaceRename, {
  payload: WorkspaceRenameInput,
  success: WorkspaceState,
  error: WorkspaceRpcError,
});

export const WsWorkspaceSyncMachinesRpc = Rpc.make(WS_METHODS.workspaceSyncMachines, {
  payload: WorkspaceSyncMachinesInput,
  success: WorkspaceState,
  error: WorkspaceRpcError,
});

export const WsWorkspaceUpdateMachineRpc = Rpc.make(WS_METHODS.workspaceUpdateMachine, {
  payload: WorkspaceUpdateMachineInput,
  success: WorkspaceState,
  error: WorkspaceRpcError,
});

export const WsWorkspaceRemoveMachineRpc = Rpc.make(WS_METHODS.workspaceRemoveMachine, {
  payload: WorkspaceRemoveMachineInput,
  success: WorkspaceState,
  error: WorkspaceRpcError,
});

export const WsWorkspaceGetInstructionsRpc = Rpc.make(WS_METHODS.workspaceGetInstructions, {
  payload: WorkspaceGetInstructionsInput,
  success: WorkspaceInstructions,
  error: WorkspaceRpcError,
});

export const WsWorkspaceSetInstructionsRpc = Rpc.make(WS_METHODS.workspaceSetInstructions, {
  payload: WorkspaceSetInstructionsInput,
  success: WorkspaceState,
  error: WorkspaceRpcError,
});

export const WsWorkspaceApplyInstructionsRpc = Rpc.make(WS_METHODS.workspaceApplyInstructions, {
  payload: WorkspaceApplyInstructionsInput,
  success: WorkspaceApplyInstructionsResult,
  error: WorkspaceRpcError,
});

/* ------------------------------------------------------------------ *
 * Uno cloud
 * ------------------------------------------------------------------ */

export class UnoCloudRpcError extends Schema.TaggedErrorClass<UnoCloudRpcError>()(
  "UnoCloudRpcError",
  {
    message: Schema.String,
  },
) {}

export const UnoCloudGetStateInput = Schema.Struct({
  /** Skip the short cache; used by the explicit refresh button. */
  refresh: Schema.optional(Schema.Boolean),
});
export type UnoCloudGetStateInput = typeof UnoCloudGetStateInput.Type;

export const UnoCloudBoxPowerInput = Schema.Struct({
  boxId: Schema.Number,
  action: Schema.Literals(["wake", "sleep", "start", "stop"]),
});
export type UnoCloudBoxPowerInput = typeof UnoCloudBoxPowerInput.Type;

export const UnoCloudConnectBoxInput = Schema.Struct({
  boxId: Schema.Number,
});
export type UnoCloudConnectBoxInput = typeof UnoCloudConnectBoxInput.Type;

export const WsUnoCloudGetStateRpc = Rpc.make(WS_METHODS.unoCloudGetState, {
  payload: UnoCloudGetStateInput,
  success: UnoCloudState,
  error: UnoCloudRpcError,
});

export const WsUnoCloudBoxPowerRpc = Rpc.make(WS_METHODS.unoCloudBoxPower, {
  payload: UnoCloudBoxPowerInput,
  success: UnoCloudState,
  error: UnoCloudRpcError,
});

export const WsUnoCloudConnectBoxRpc = Rpc.make(WS_METHODS.unoCloudConnectBox, {
  payload: UnoCloudConnectBoxInput,
  success: UnoBoxConnection,
  error: UnoCloudRpcError,
});

/* ------------------------------------------------------------------ *
 * Provider setup (install + sign in)
 * ------------------------------------------------------------------ */

export const WsProviderInstallStartRpc = Rpc.make(WS_METHODS.providerInstallStart, {
  payload: ProviderInstallStartInput,
  success: ProviderInstallStartResult,
  error: ProviderSetupRpcError,
});

export const WsProviderInstallStatusRpc = Rpc.make(WS_METHODS.providerInstallStatus, {
  payload: ProviderInstallStatusInput,
  success: ProviderInstallJobStatus,
  error: ProviderSetupRpcError,
});

export const WsProviderAuthStartRpc = Rpc.make(WS_METHODS.providerAuthStart, {
  payload: ProviderAuthStartInput,
  success: ProviderAuthStartResult,
  error: ProviderSetupRpcError,
});

export const WsProviderAuthStatusRpc = Rpc.make(WS_METHODS.providerAuthStatus, {
  payload: ProviderAuthStatusInput,
  success: ProviderAuthJobStatus,
  error: ProviderSetupRpcError,
});

export const WsProviderAuthSubmitCodeRpc = Rpc.make(WS_METHODS.providerAuthSubmitCode, {
  payload: ProviderAuthSubmitCodeInput,
  success: ProviderAuthJobStatus,
  error: ProviderSetupRpcError,
});

/**
 * Creating a box is billable, so the RPC returns immediately with a job id and
 * the client polls `createBoxStatus`. One RPC call = at most one launch call to
 * the control plane; the daemon never retries the launch on its own.
 */
export const UnoCloudCreateBoxInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  ramMb: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  vcpu: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  diskGb: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  /** Only `work` exists today: a box launched from the Uno Work golden image. */
  purpose: Schema.optional(Schema.Literals(["work"])),
});
export type UnoCloudCreateBoxInput = typeof UnoCloudCreateBoxInput.Type;

export const UnoCloudCreateBoxResult = Schema.Struct({
  jobId: Schema.String,
});
export type UnoCloudCreateBoxResult = typeof UnoCloudCreateBoxResult.Type;

export const UnoCloudCreateBoxStatusInput = Schema.Struct({
  jobId: Schema.String,
});
export type UnoCloudCreateBoxStatusInput = typeof UnoCloudCreateBoxStatusInput.Type;

export const WsUnoCloudCreateBoxRpc = Rpc.make(WS_METHODS.unoCloudCreateBox, {
  payload: UnoCloudCreateBoxInput,
  success: UnoCloudCreateBoxResult,
  error: UnoCloudRpcError,
});

export const WsUnoCloudCreateBoxStatusRpc = Rpc.make(WS_METHODS.unoCloudCreateBoxStatus, {
  payload: UnoCloudCreateBoxStatusInput,
  success: UnoBoxCreateJobStatus,
  error: UnoCloudRpcError,
});

/* ------------------------------------------------------------------ *
 * "This computer" (Uno Work desktop)
 *
 * Reads never fail on a missing control-plane route: they answer with an
 * `availability` so the UI can say "coming soon". Install and power are
 * actions, so they fail with `UnoCloudRpcError` carrying a readable message.
 * ------------------------------------------------------------------ */

export const WsUnoComputerGetStateRpc = Rpc.make(WS_METHODS.unoComputerGetState, {
  payload: UnoComputerTargetInput,
  success: UnoComputerState,
  error: UnoCloudRpcError,
});

export const WsUnoComputerMetricsRpc = Rpc.make(WS_METHODS.unoComputerMetrics, {
  payload: UnoComputerTargetInput,
  success: UnoComputerMetrics,
  error: UnoCloudRpcError,
});

export const WsUnoComputerActivityRpc = Rpc.make(WS_METHODS.unoComputerActivity, {
  payload: UnoComputerActivityInput,
  success: UnoComputerActivity,
  error: UnoCloudRpcError,
});

export const WsUnoComputerAppsRpc = Rpc.make(WS_METHODS.unoComputerApps, {
  payload: UnoComputerTargetInput,
  success: UnoComputerApps,
  error: UnoCloudRpcError,
});

export const WsUnoComputerInstallAppRpc = Rpc.make(WS_METHODS.unoComputerInstallApp, {
  payload: UnoComputerInstallAppInput,
  success: UnoComputerInstallAppResult,
  error: UnoCloudRpcError,
});

export const WsUnoComputerInstallStatusRpc = Rpc.make(WS_METHODS.unoComputerInstallStatus, {
  payload: UnoComputerInstallStatusInput,
  success: UnoComputerInstallStatus,
  error: UnoCloudRpcError,
});

export const WsUnoComputerPowerRpc = Rpc.make(WS_METHODS.unoComputerPower, {
  payload: UnoComputerPowerInput,
  success: UnoComputerState,
  error: UnoCloudRpcError,
});

/* ------------------------------------------------------------------
 * Files — the computer's file manager. Paths are absolute and confined
 * to the Work user's home; shares are public `/s/<token>` links.
 * ------------------------------------------------------------------ */

export const WsFilesListRpc = Rpc.make(WS_METHODS.filesList, {
  payload: FilesListInput,
  success: FilesListResult,
  error: FilesError,
});

export const WsFilesStatRpc = Rpc.make(WS_METHODS.filesStat, {
  payload: FilesStatInput,
  success: FilesEntry,
  error: FilesError,
});

export const WsFilesCreateFolderRpc = Rpc.make(WS_METHODS.filesCreateFolder, {
  payload: FilesCreateFolderInput,
  success: FilesEntry,
  error: FilesError,
});

export const WsFilesRenameRpc = Rpc.make(WS_METHODS.filesRename, {
  payload: FilesRenameInput,
  success: FilesEntry,
  error: FilesError,
});

export const WsFilesMoveRpc = Rpc.make(WS_METHODS.filesMove, {
  payload: FilesMoveInput,
  success: FilesMoveResult,
  error: FilesError,
});

export const WsFilesDeleteRpc = Rpc.make(WS_METHODS.filesDelete, {
  payload: FilesDeleteInput,
  success: FilesDeleteResult,
  error: FilesError,
});

export const WsFilesSearchRpc = Rpc.make(WS_METHODS.filesSearch, {
  payload: FilesSearchInput,
  success: FilesSearchResult,
  error: FilesError,
});

export const WsFilesShareCreateRpc = Rpc.make(WS_METHODS.filesShareCreate, {
  payload: FilesShareCreateInput,
  success: FilesShare,
  error: FilesError,
});

export const WsFilesShareListRpc = Rpc.make(WS_METHODS.filesShareList, {
  payload: FilesShareListInput,
  success: FilesShareListResult,
  error: FilesError,
});

export const WsFilesShareRevokeRpc = Rpc.make(WS_METHODS.filesShareRevoke, {
  payload: FilesShareRevokeInput,
  success: FilesShare,
  error: FilesError,
});

export const WsFilesPublishSiteRpc = Rpc.make(WS_METHODS.filesPublishSite, {
  payload: FilesPublishSiteInput,
  success: FilesPublishSiteResult,
  error: FilesError,
});

export const WsFilesCloudStateRpc = Rpc.make(WS_METHODS.filesCloudState, {
  payload: Schema.Struct({}),
  success: FilesCloudState,
  error: FilesError,
});

export const WsFilesCloudListRpc = Rpc.make(WS_METHODS.filesCloudList, {
  payload: FilesCloudListInput,
  success: FilesCloudListResult,
  error: FilesError,
});

export const WsFilesCloudCreateBucketRpc = Rpc.make(WS_METHODS.filesCloudCreateBucket, {
  payload: FilesCloudCreateBucketInput,
  success: FilesCloudBucket,
  error: FilesError,
});

export const WsFilesCloudDeleteRpc = Rpc.make(WS_METHODS.filesCloudDelete, {
  payload: FilesCloudObjectInput,
  success: FilesCloudDeleteResult,
  error: FilesError,
});

export const WsFilesCloudDownloadUrlRpc = Rpc.make(WS_METHODS.filesCloudDownloadUrl, {
  payload: FilesCloudObjectInput,
  success: FilesCloudDownloadUrl,
  error: FilesError,
});

export const WsFilesCloudCopyToCloudRpc = Rpc.make(WS_METHODS.filesCloudCopyToCloud, {
  payload: FilesCloudCopyToCloudInput,
  success: FilesCloudTransferResult,
  error: FilesError,
});

export const WsFilesCloudCopyToComputerRpc = Rpc.make(WS_METHODS.filesCloudCopyToComputer, {
  payload: FilesCloudCopyToComputerInput,
  success: FilesCloudTransferResult,
  error: FilesError,
});

/** Programs found on the machine this daemon runs on. Never fails: see `warnings`. */
export const WsUnoComputerMachineAppsRpc = Rpc.make(WS_METHODS.unoComputerMachineApps, {
  payload: Schema.Struct({}),
  success: UnoMachineApps,
  error: UnoCloudRpcError,
});

/** Start / stop / show on the internet / hide one of them. */
export const WsUnoComputerAppActionRpc = Rpc.make(WS_METHODS.unoComputerAppAction, {
  payload: UnoMachineAppActionInput,
  success: UnoMachineApps,
  error: UnoCloudRpcError,
});

export const WsUnoComputerLocalMetricsRpc = Rpc.make(WS_METHODS.unoComputerLocalMetrics, {
  payload: Schema.Struct({}),
  success: UnoComputerLocalMetrics,
  error: UnoCloudRpcError,
});

/** Sizes this computer can take on its plan. Never fails: see `availability`. */
export const WsUnoComputerResizeOptionsRpc = Rpc.make(WS_METHODS.unoComputerResizeOptions, {
  payload: UnoComputerTargetInput,
  success: UnoComputerResizeOptions,
  error: UnoCloudRpcError,
});

/** Add memory / cores / disk. A plan limit is an answer (`plan_limit`), not an error. */
export const WsUnoComputerResizeRpc = Rpc.make(WS_METHODS.unoComputerResize, {
  payload: UnoComputerResizeInput,
  success: UnoComputerResizeResult,
  error: UnoCloudRpcError,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerProbeRpc,
  WsServerReportClientActivityRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpsertKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsVaultListRpc,
  WsVaultUpsertRpc,
  WsVaultDeleteRpc,
  WsVaultImportRpc,
  WsVaultFillRpc,
  WsVaultSyncRpc,
  WsWorkspaceGetStateRpc,
  WsWorkspaceRenameRpc,
  WsWorkspaceSyncMachinesRpc,
  WsWorkspaceUpdateMachineRpc,
  WsWorkspaceRemoveMachineRpc,
  WsWorkspaceGetInstructionsRpc,
  WsWorkspaceSetInstructionsRpc,
  WsWorkspaceApplyInstructionsRpc,
  WsUnoCloudGetStateRpc,
  WsUnoCloudBoxPowerRpc,
  WsUnoCloudConnectBoxRpc,
  WsUnoCloudCreateBoxRpc,
  WsUnoCloudCreateBoxStatusRpc,
  WsUnoComputerGetStateRpc,
  WsUnoComputerMetricsRpc,
  WsUnoComputerActivityRpc,
  WsUnoComputerAppsRpc,
  WsUnoComputerInstallAppRpc,
  WsUnoComputerInstallStatusRpc,
  WsUnoComputerPowerRpc,
  WsFilesListRpc,
  WsFilesStatRpc,
  WsFilesCreateFolderRpc,
  WsFilesRenameRpc,
  WsFilesMoveRpc,
  WsFilesDeleteRpc,
  WsFilesSearchRpc,
  WsFilesShareCreateRpc,
  WsFilesShareListRpc,
  WsFilesShareRevokeRpc,
  WsFilesPublishSiteRpc,
  WsFilesCloudStateRpc,
  WsFilesCloudListRpc,
  WsFilesCloudCreateBucketRpc,
  WsFilesCloudDeleteRpc,
  WsFilesCloudDownloadUrlRpc,
  WsFilesCloudCopyToCloudRpc,
  WsFilesCloudCopyToComputerRpc,
  WsUnoComputerMachineAppsRpc,
  WsUnoComputerAppActionRpc,
  WsUnoComputerLocalMetricsRpc,
  WsUnoComputerResizeOptionsRpc,
  WsUnoComputerResizeRpc,
  WsProviderInstallStartRpc,
  WsProviderInstallStatusRpc,
  WsProviderAuthStartRpc,
  WsProviderAuthStatusRpc,
  WsProviderAuthSubmitCodeRpc,
  WsServerListPluginsRpc,
  WsServerSetPluginEnabledRpc,
  WsPluginsSendToThreadRpc,
  WsPluginsResolvePanelThreadRpc,
  WsSubscribePluginsRpc,
  WsUnoCreateLlmTopUpActionRpc,
  WsUnoVideoCreateUploadRpc,
  WsUnoVideoCompleteUploadRpc,
  WsUnoVideoCreateJobRpc,
  WsUnoVideoGetJobRpc,
  WsUnoVideoCancelJobRpc,
  WsUnoVideoGetDigestRpc,
  WsUnoVideoPackDigestRpc,
  WsUnoTranscribeAudioRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsFilesystemReadFileRpc,
  WsSubscribeFileChangesRpc,
  WsSubscribeVcsStatusRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsThreadContinueInspectRpc,
  WsThreadContinueSnapshotRpc,
  WsThreadContinueReadChunkRpc,
  WsThreadContinueWriteChunkRpc,
  WsThreadContinueLandRpc,
  WsThreadContinueDiscardRpc,
  WsThreadContinuePrepareRpc,
  WsThreadContinueReceiveRpc,
  WsThreadContinueCleanupRpc,
  WsThreadContinueCompleteRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeAuthLinkRequestsRpc,
  WsSubscribeBrowserBridgeRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
