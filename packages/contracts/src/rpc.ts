import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { EnvironmentId } from "./baseSchemas.ts";
import {
  CrossEnvironmentWriteMode,
  UnoBoxConnection,
  UnoCloudState,
  WorkspaceCapability,
  WorkspaceClaim,
  WorkspaceInstructions,
  WorkspaceMachineKind,
  WorkspaceMachineScope,
  WorkspacePolicy,
  WorkspaceRequest,
  WorkspaceRequestKind,
  WorkspaceState,
  WorkspaceTransport,
} from "./workspace.ts";
import { OpenError, OpenInEditorInput } from "./editor.ts";
import { AuthAccessStreamEvent } from "./auth.ts";
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

  // Credentials vault methods (web-only Settings panel)
  vaultList: "vault.list",
  vaultUpsert: "vault.upsert",
  vaultDelete: "vault.delete",
  vaultImport: "vault.import",

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
  workspaceSetPolicy: "workspace.setPolicy",
  workspaceUpsertGrant: "workspace.upsertGrant",
  workspaceRemoveGrant: "workspace.removeGrant",
  workspaceAcquireClaim: "workspace.acquireClaim",
  workspaceReleaseClaim: "workspace.releaseClaim",
  workspaceCreateRequest: "workspace.createRequest",
  workspaceDecideRequest: "workspace.decideRequest",
  workspaceGetInstructions: "workspace.getInstructions",
  workspaceSetInstructions: "workspace.setInstructions",
  workspaceApplyInstructions: "workspace.applyInstructions",

  // Uno cloud: the account behind the workspace and its boxes
  unoCloudGetState: "uno.cloud.getState",
  unoCloudBoxPower: "uno.cloud.boxPower",
  unoCloudConnectBox: "uno.cloud.connectBox",

  // Streaming subscriptions
  subscribeFileChanges: "subscribeFileChanges",
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeBrowserBridge: "subscribeBrowserBridge",
  subscribePlugins: "subscribePlugins",
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

export const WorkspaceSetPolicyInput = Schema.Struct({
  policy: WorkspacePolicy,
});
export type WorkspaceSetPolicyInput = typeof WorkspaceSetPolicyInput.Type;

export const WorkspaceUpsertGrantInput = Schema.Struct({
  /** Omitted for a new grant; present when editing an existing row. */
  grantId: Schema.optional(Schema.String),
  fromEnvironmentId: Schema.String,
  toEnvironmentId: Schema.String,
  repositoryKey: Schema.String,
  capabilities: Schema.Array(WorkspaceCapability),
  transport: WorkspaceTransport,
  mode: CrossEnvironmentWriteMode,
  requiresClaim: Schema.Boolean,
});
export type WorkspaceUpsertGrantInput = typeof WorkspaceUpsertGrantInput.Type;

export const WorkspaceRemoveGrantInput = Schema.Struct({
  grantId: Schema.String,
});
export type WorkspaceRemoveGrantInput = typeof WorkspaceRemoveGrantInput.Type;

export const WorkspaceAcquireClaimInput = Schema.Struct({
  claimKey: Schema.String,
  holderEnvironmentId: EnvironmentId,
  reason: Schema.String,
  ttlSeconds: Schema.optional(Schema.Number),
});
export type WorkspaceAcquireClaimInput = typeof WorkspaceAcquireClaimInput.Type;

export const WorkspaceAcquireClaimResult = Schema.Struct({
  outcome: Schema.Literals(["acquired", "renewed", "taken"]),
  claim: WorkspaceClaim,
  state: WorkspaceState,
});
export type WorkspaceAcquireClaimResult = typeof WorkspaceAcquireClaimResult.Type;

export const WorkspaceReleaseClaimInput = Schema.Struct({
  claimKey: Schema.String,
  /** Null releases regardless of holder — the "take it back" path, behind a confirm. */
  holderEnvironmentId: Schema.NullOr(EnvironmentId),
});
export type WorkspaceReleaseClaimInput = typeof WorkspaceReleaseClaimInput.Type;

export const WorkspaceCreateRequestInput = Schema.Struct({
  kind: WorkspaceRequestKind,
  fromEnvironmentId: EnvironmentId,
  toEnvironmentId: EnvironmentId,
  repositoryKey: Schema.String,
  threadId: Schema.optional(Schema.NullOr(Schema.String)),
  reason: Schema.String,
  payloadPreview: Schema.String,
  hops: Schema.optional(Schema.Number),
});
export type WorkspaceCreateRequestInput = typeof WorkspaceCreateRequestInput.Type;

export const WorkspaceCreateRequestResult = Schema.Struct({
  /**
   * `auto_approved` when a grant already says `allow` — the caller still gets a
   * request row, so the audit trail does not depend on which path was taken.
   */
  disposition: Schema.Literals(["pending", "auto_approved"]),
  request: WorkspaceRequest,
  state: WorkspaceState,
});
export type WorkspaceCreateRequestResult = typeof WorkspaceCreateRequestResult.Type;

export const WorkspaceDecideRequestInput = Schema.Struct({
  requestId: Schema.String,
  decision: Schema.Literals(["approve", "reject"]),
});
export type WorkspaceDecideRequestInput = typeof WorkspaceDecideRequestInput.Type;

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

export const WsWorkspaceSetPolicyRpc = Rpc.make(WS_METHODS.workspaceSetPolicy, {
  payload: WorkspaceSetPolicyInput,
  success: WorkspaceState,
  error: WorkspaceRpcError,
});

export const WsWorkspaceUpsertGrantRpc = Rpc.make(WS_METHODS.workspaceUpsertGrant, {
  payload: WorkspaceUpsertGrantInput,
  success: WorkspaceState,
  error: WorkspaceRpcError,
});

export const WsWorkspaceRemoveGrantRpc = Rpc.make(WS_METHODS.workspaceRemoveGrant, {
  payload: WorkspaceRemoveGrantInput,
  success: WorkspaceState,
  error: WorkspaceRpcError,
});

export const WsWorkspaceAcquireClaimRpc = Rpc.make(WS_METHODS.workspaceAcquireClaim, {
  payload: WorkspaceAcquireClaimInput,
  success: WorkspaceAcquireClaimResult,
  error: WorkspaceRpcError,
});

export const WsWorkspaceReleaseClaimRpc = Rpc.make(WS_METHODS.workspaceReleaseClaim, {
  payload: WorkspaceReleaseClaimInput,
  success: WorkspaceState,
  error: WorkspaceRpcError,
});

export const WsWorkspaceCreateRequestRpc = Rpc.make(WS_METHODS.workspaceCreateRequest, {
  payload: WorkspaceCreateRequestInput,
  success: WorkspaceCreateRequestResult,
  error: WorkspaceRpcError,
});

export const WsWorkspaceDecideRequestRpc = Rpc.make(WS_METHODS.workspaceDecideRequest, {
  payload: WorkspaceDecideRequestInput,
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

export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpsertKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsVaultListRpc,
  WsVaultUpsertRpc,
  WsVaultDeleteRpc,
  WsVaultImportRpc,
  WsWorkspaceGetStateRpc,
  WsWorkspaceRenameRpc,
  WsWorkspaceSyncMachinesRpc,
  WsWorkspaceUpdateMachineRpc,
  WsWorkspaceRemoveMachineRpc,
  WsWorkspaceSetPolicyRpc,
  WsWorkspaceUpsertGrantRpc,
  WsWorkspaceRemoveGrantRpc,
  WsWorkspaceAcquireClaimRpc,
  WsWorkspaceReleaseClaimRpc,
  WsWorkspaceCreateRequestRpc,
  WsWorkspaceDecideRequestRpc,
  WsWorkspaceGetInstructionsRpc,
  WsWorkspaceSetInstructionsRpc,
  WsWorkspaceApplyInstructionsRpc,
  WsUnoCloudGetStateRpc,
  WsUnoCloudBoxPowerRpc,
  WsUnoCloudConnectBoxRpc,
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
  WsSubscribeBrowserBridgeRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
