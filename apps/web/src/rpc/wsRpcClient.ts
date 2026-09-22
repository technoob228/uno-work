import {
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusResult,
  type VcsStatusStreamEvent,
  type LocalApi,
  ORCHESTRATION_WS_METHODS,
  type ServerSettingsPatch,
  WS_METHODS,
} from "@t3tools/contracts";
import { applyGitStatusStreamEvent } from "@t3tools/shared/git";
import { Effect, Stream } from "effect";

import { type WsRpcProtocolClient } from "./protocol";
import { resetWsReconnectBackoff } from "./wsConnectionState";
import { WsTransport } from "./wsTransport";

type RpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends RpcTag> = WsRpcProtocolClient[TTag];
type RpcInput<TTag extends RpcTag> = Parameters<RpcMethod<TTag>>[0];

interface StreamSubscriptionOptions {
  readonly onResubscribe?: () => void;
}

type RpcUnaryMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? (input: RpcInput<TTag>) => Promise<TSuccess>
    : never;

type RpcUnaryNoArgMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? () => Promise<TSuccess>
    : never;

type RpcStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (listener: (event: TEvent) => void, options?: StreamSubscriptionOptions) => () => void
    : never;

type RpcInputStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (
        input: RpcInput<TTag>,
        listener: (event: TEvent) => void,
        options?: StreamSubscriptionOptions,
      ) => () => void
    : never;

interface GitRunStackedActionOptions {
  readonly onProgress?: (event: GitActionProgressEvent) => void;
}

export interface WsRpcClient {
  readonly dispose: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly isConnectionHealthy: () => boolean;
  readonly terminal: {
    readonly open: RpcUnaryMethod<typeof WS_METHODS.terminalOpen>;
    readonly write: RpcUnaryMethod<typeof WS_METHODS.terminalWrite>;
    readonly resize: RpcUnaryMethod<typeof WS_METHODS.terminalResize>;
    readonly clear: RpcUnaryMethod<typeof WS_METHODS.terminalClear>;
    readonly restart: RpcUnaryMethod<typeof WS_METHODS.terminalRestart>;
    readonly close: RpcUnaryMethod<typeof WS_METHODS.terminalClose>;
    readonly onEvent: RpcStreamMethod<typeof WS_METHODS.subscribeTerminalEvents>;
  };
  readonly projects: {
    readonly searchEntries: RpcUnaryMethod<typeof WS_METHODS.projectsSearchEntries>;
    readonly writeFile: RpcUnaryMethod<typeof WS_METHODS.projectsWriteFile>;
  };
  readonly filesystem: {
    readonly browse: RpcUnaryMethod<typeof WS_METHODS.filesystemBrowse>;
    readonly readFile: RpcUnaryMethod<typeof WS_METHODS.filesystemReadFile>;
    readonly watchFile: RpcInputStreamMethod<typeof WS_METHODS.subscribeFileChanges>;
  };
  readonly sourceControl: {
    readonly lookupRepository: RpcUnaryMethod<typeof WS_METHODS.sourceControlLookupRepository>;
    readonly cloneRepository: RpcUnaryMethod<typeof WS_METHODS.sourceControlCloneRepository>;
    readonly publishRepository: RpcUnaryMethod<typeof WS_METHODS.sourceControlPublishRepository>;
  };
  readonly shell: {
    readonly openInEditor: (input: {
      readonly cwd: Parameters<LocalApi["shell"]["openInEditor"]>[0];
      readonly editor: Parameters<LocalApi["shell"]["openInEditor"]>[1];
    }) => ReturnType<LocalApi["shell"]["openInEditor"]>;
  };
  readonly vcs: {
    readonly pull: RpcUnaryMethod<typeof WS_METHODS.vcsPull>;
    readonly refreshStatus: RpcUnaryMethod<typeof WS_METHODS.vcsRefreshStatus>;
    readonly onStatus: (
      input: RpcInput<typeof WS_METHODS.subscribeVcsStatus>,
      listener: (status: VcsStatusResult) => void,
      options?: StreamSubscriptionOptions,
    ) => () => void;
    readonly listRefs: RpcUnaryMethod<typeof WS_METHODS.vcsListRefs>;
    readonly createWorktree: RpcUnaryMethod<typeof WS_METHODS.vcsCreateWorktree>;
    readonly removeWorktree: RpcUnaryMethod<typeof WS_METHODS.vcsRemoveWorktree>;
    readonly createRef: RpcUnaryMethod<typeof WS_METHODS.vcsCreateRef>;
    readonly switchRef: RpcUnaryMethod<typeof WS_METHODS.vcsSwitchRef>;
    readonly init: RpcUnaryMethod<typeof WS_METHODS.vcsInit>;
  };
  /**
   * Git-specific workflows. Local repository mechanics live under `vcs`.
   */
  readonly git: {
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitRunStackedActionOptions,
    ) => Promise<GitRunStackedActionResult>;
    readonly resolvePullRequest: RpcUnaryMethod<typeof WS_METHODS.gitResolvePullRequest>;
    readonly preparePullRequestThread: RpcUnaryMethod<
      typeof WS_METHODS.gitPreparePullRequestThread
    >;
  };
  /** "Continue on <machine>": prepare/complete on the source daemon, receive on the target. */
  readonly threadContinue: {
    readonly inspect: RpcUnaryMethod<typeof WS_METHODS.threadContinueInspect>;
    readonly snapshot: RpcUnaryMethod<typeof WS_METHODS.threadContinueSnapshot>;
    readonly readChunk: RpcUnaryMethod<typeof WS_METHODS.threadContinueReadChunk>;
    readonly writeChunk: RpcUnaryMethod<typeof WS_METHODS.threadContinueWriteChunk>;
    readonly land: RpcUnaryMethod<typeof WS_METHODS.threadContinueLand>;
    readonly discard: RpcUnaryMethod<typeof WS_METHODS.threadContinueDiscard>;
    readonly complete: RpcUnaryMethod<typeof WS_METHODS.threadContinueComplete>;
  };
  readonly server: {
    readonly getConfig: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetConfig>;
    /**
     * Refresh provider snapshots. Pass `{ instanceId }` to refresh a single
     * configured instance; pass no argument (or `{}`) to refresh all.
     */
    readonly refreshProviders: (
      input?: RpcInput<typeof WS_METHODS.serverRefreshProviders>,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverRefreshProviders>>;
    readonly upsertKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverUpsertKeybinding>;
    readonly getSettings: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetSettings>;
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverUpdateSettings>>;
    readonly discoverSourceControl: RpcUnaryNoArgMethod<
      typeof WS_METHODS.serverDiscoverSourceControl
    >;
    readonly listPlugins: RpcUnaryNoArgMethod<typeof WS_METHODS.serverListPlugins>;
    readonly setPluginEnabled: RpcUnaryMethod<typeof WS_METHODS.serverSetPluginEnabled>;
    /** Мост панели плагина: «спроси агента» из sandbox-iframe. */
    readonly sendPluginToThread: RpcUnaryMethod<typeof WS_METHODS.pluginsSendToThread>;
    /** Тред встроенного чата панели — тот же mapping, что у sendToThread. */
    readonly resolvePluginPanelThread: RpcUnaryMethod<typeof WS_METHODS.pluginsResolvePanelThread>;
    readonly subscribePlugins: RpcStreamMethod<typeof WS_METHODS.subscribePlugins>;
    readonly createUnoLlmTopUpAction: RpcUnaryMethod<typeof WS_METHODS.unoCreateLlmTopUpAction>;
    readonly createUnoVideoUpload: RpcUnaryMethod<typeof WS_METHODS.unoVideoCreateUpload>;
    readonly completeUnoVideoUpload: RpcUnaryMethod<typeof WS_METHODS.unoVideoCompleteUpload>;
    readonly createUnoVideoJob: RpcUnaryMethod<typeof WS_METHODS.unoVideoCreateJob>;
    readonly getUnoVideoJob: RpcUnaryMethod<typeof WS_METHODS.unoVideoGetJob>;
    readonly cancelUnoVideoJob: RpcUnaryMethod<typeof WS_METHODS.unoVideoCancelJob>;
    readonly getUnoVideoDigest: RpcUnaryMethod<typeof WS_METHODS.unoVideoGetDigest>;
    readonly packUnoVideoDigest: RpcUnaryMethod<typeof WS_METHODS.unoVideoPackDigest>;
    readonly transcribeAudio: RpcUnaryMethod<typeof WS_METHODS.unoTranscribeAudio>;
    readonly subscribeConfig: RpcStreamMethod<typeof WS_METHODS.subscribeServerConfig>;
    readonly subscribeLifecycle: RpcStreamMethod<typeof WS_METHODS.subscribeServerLifecycle>;
    readonly subscribeAuthAccess: RpcStreamMethod<typeof WS_METHODS.subscribeAuthAccess>;
    /** Pending "use this computer" approvals; empty for non-owner sessions. */
    readonly subscribeAuthLinkRequests: RpcStreamMethod<
      typeof WS_METHODS.subscribeAuthLinkRequests
    >;
  };
  readonly orchestration: {
    readonly dispatchCommand: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>;
    readonly getTurnDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnDiff>;
    readonly getFullThreadDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>;
    readonly subscribeShell: RpcStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeShell>;
    readonly subscribeThread: RpcInputStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeThread>;
  };
  readonly browser: {
    readonly subscribeBridge: RpcStreamMethod<typeof WS_METHODS.subscribeBrowserBridge>;
  };
  readonly vault: {
    readonly list: RpcUnaryNoArgMethod<typeof WS_METHODS.vaultList>;
    readonly upsert: RpcUnaryMethod<typeof WS_METHODS.vaultUpsert>;
    readonly delete: RpcUnaryMethod<typeof WS_METHODS.vaultDelete>;
    readonly import: RpcUnaryMethod<typeof WS_METHODS.vaultImport>;
    readonly fill: RpcUnaryMethod<typeof WS_METHODS.vaultFill>;
    readonly sync: RpcUnaryMethod<typeof WS_METHODS.vaultSync>;
  };
  /**
   * Workspace registry. Every mutating call answers with the full state, so a
   * caller never has to reconcile a local delta against the daemon's epoch.
   */
  readonly workspace: {
    readonly getState: RpcUnaryNoArgMethod<typeof WS_METHODS.workspaceGetState>;
    readonly rename: RpcUnaryMethod<typeof WS_METHODS.workspaceRename>;
    readonly syncMachines: RpcUnaryMethod<typeof WS_METHODS.workspaceSyncMachines>;
    readonly updateMachine: RpcUnaryMethod<typeof WS_METHODS.workspaceUpdateMachine>;
    readonly removeMachine: RpcUnaryMethod<typeof WS_METHODS.workspaceRemoveMachine>;
    readonly getInstructions: RpcUnaryMethod<typeof WS_METHODS.workspaceGetInstructions>;
    readonly setInstructions: RpcUnaryMethod<typeof WS_METHODS.workspaceSetInstructions>;
    readonly applyInstructions: RpcUnaryMethod<typeof WS_METHODS.workspaceApplyInstructions>;
  };
  readonly providerSetup: {
    readonly installStart: RpcUnaryMethod<typeof WS_METHODS.providerInstallStart>;
    readonly installStatus: RpcUnaryMethod<typeof WS_METHODS.providerInstallStatus>;
    readonly authStart: RpcUnaryMethod<typeof WS_METHODS.providerAuthStart>;
    readonly authStatus: RpcUnaryMethod<typeof WS_METHODS.providerAuthStatus>;
    readonly authSubmitCode: RpcUnaryMethod<typeof WS_METHODS.providerAuthSubmitCode>;
  };
  readonly unoCloud: {
    readonly getState: (
      input?: RpcInput<typeof WS_METHODS.unoCloudGetState>,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.unoCloudGetState>>;
    readonly boxPower: RpcUnaryMethod<typeof WS_METHODS.unoCloudBoxPower>;
    readonly connectBox: RpcUnaryMethod<typeof WS_METHODS.unoCloudConnectBox>;
    readonly createBox: RpcUnaryMethod<typeof WS_METHODS.unoCloudCreateBox>;
    readonly createBoxStatus: RpcUnaryMethod<typeof WS_METHODS.unoCloudCreateBoxStatus>;
  };
  readonly unoComputer: {
    readonly getState: (
      input?: RpcInput<typeof WS_METHODS.unoComputerGetState>,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.unoComputerGetState>>;
    readonly metrics: (
      input?: RpcInput<typeof WS_METHODS.unoComputerMetrics>,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.unoComputerMetrics>>;
    readonly activity: (
      input?: RpcInput<typeof WS_METHODS.unoComputerActivity>,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.unoComputerActivity>>;
    readonly apps: (
      input?: RpcInput<typeof WS_METHODS.unoComputerApps>,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.unoComputerApps>>;
    readonly installApp: RpcUnaryMethod<typeof WS_METHODS.unoComputerInstallApp>;
    readonly installStatus: RpcUnaryMethod<typeof WS_METHODS.unoComputerInstallStatus>;
    readonly power: RpcUnaryMethod<typeof WS_METHODS.unoComputerPower>;
    readonly machineApps: () => ReturnType<
      RpcUnaryMethod<typeof WS_METHODS.unoComputerMachineApps>
    >;
    readonly appAction: RpcUnaryMethod<typeof WS_METHODS.unoComputerAppAction>;
    readonly localMetrics: () => ReturnType<
      RpcUnaryMethod<typeof WS_METHODS.unoComputerLocalMetrics>
    >;
  };
}

export function createWsRpcClient(transport: WsTransport): WsRpcClient {
  return {
    dispose: () => transport.dispose(),
    reconnect: async () => {
      resetWsReconnectBackoff();
      await transport.reconnect();
    },
    isConnectionHealthy: () => transport.isConnectionHealthy(),
    terminal: {
      open: (input) => transport.request((client) => client[WS_METHODS.terminalOpen](input)),
      write: (input) => transport.request((client) => client[WS_METHODS.terminalWrite](input)),
      resize: (input) => transport.request((client) => client[WS_METHODS.terminalResize](input)),
      clear: (input) => transport.request((client) => client[WS_METHODS.terminalClear](input)),
      restart: (input) => transport.request((client) => client[WS_METHODS.terminalRestart](input)),
      close: (input) => transport.request((client) => client[WS_METHODS.terminalClose](input)),
      onEvent: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeTerminalEvents]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribeTerminalEvents,
        }),
    },
    projects: {
      searchEntries: (input) =>
        transport.request((client) => client[WS_METHODS.projectsSearchEntries](input)),
      writeFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsWriteFile](input)),
    },
    filesystem: {
      browse: (input) => transport.request((client) => client[WS_METHODS.filesystemBrowse](input)),
      readFile: (input) =>
        transport.request((client) => client[WS_METHODS.filesystemReadFile](input)),
      watchFile: (input, listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeFileChanges](input), listener, {
          ...options,
          tag: WS_METHODS.subscribeFileChanges,
        }),
    },
    sourceControl: {
      lookupRepository: (input) =>
        transport.request((client) => client[WS_METHODS.sourceControlLookupRepository](input)),
      cloneRepository: (input) =>
        transport.request((client) => client[WS_METHODS.sourceControlCloneRepository](input)),
      publishRepository: (input) =>
        transport.request((client) => client[WS_METHODS.sourceControlPublishRepository](input)),
    },
    shell: {
      openInEditor: (input) =>
        transport.request((client) => client[WS_METHODS.shellOpenInEditor](input)),
    },
    vcs: {
      pull: (input) => transport.request((client) => client[WS_METHODS.vcsPull](input)),
      refreshStatus: (input) =>
        transport.request((client) => client[WS_METHODS.vcsRefreshStatus](input)),
      onStatus: (input, listener, options) => {
        let current: VcsStatusResult | null = null;
        return transport.subscribe(
          (client) => client[WS_METHODS.subscribeVcsStatus](input),
          (event: VcsStatusStreamEvent) => {
            current = applyGitStatusStreamEvent(current, event);
            listener(current);
          },
          { ...options, tag: WS_METHODS.subscribeVcsStatus },
        );
      },
      listRefs: (input) => transport.request((client) => client[WS_METHODS.vcsListRefs](input)),
      createWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.vcsCreateWorktree](input)),
      removeWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.vcsRemoveWorktree](input)),
      createRef: (input) => transport.request((client) => client[WS_METHODS.vcsCreateRef](input)),
      switchRef: (input) => transport.request((client) => client[WS_METHODS.vcsSwitchRef](input)),
      init: (input) => transport.request((client) => client[WS_METHODS.vcsInit](input)),
    },
    git: {
      runStackedAction: async (input, options) => {
        let result: GitRunStackedActionResult | null = null;

        await transport.requestStream(
          (client) => client[WS_METHODS.gitRunStackedAction](input),
          (event) => {
            options?.onProgress?.(event);
            if (event.kind === "action_finished") {
              result = event.result;
            }
          },
        );

        if (result) {
          return result;
        }

        throw new Error("Git action stream completed without a final result.");
      },
      resolvePullRequest: (input) =>
        transport.request((client) => client[WS_METHODS.gitResolvePullRequest](input)),
      preparePullRequestThread: (input) =>
        transport.request((client) => client[WS_METHODS.gitPreparePullRequestThread](input)),
    },
    threadContinue: {
      inspect: (input) =>
        transport.request((client) => client[WS_METHODS.threadContinueInspect](input)),
      snapshot: (input) =>
        transport.request((client) => client[WS_METHODS.threadContinueSnapshot](input)),
      readChunk: (input) =>
        transport.request((client) => client[WS_METHODS.threadContinueReadChunk](input)),
      writeChunk: (input) =>
        transport.request((client) => client[WS_METHODS.threadContinueWriteChunk](input)),
      land: (input) => transport.request((client) => client[WS_METHODS.threadContinueLand](input)),
      discard: (input) =>
        transport.request((client) => client[WS_METHODS.threadContinueDiscard](input)),
      complete: (input) =>
        transport.request((client) => client[WS_METHODS.threadContinueComplete](input)),
    },
    server: {
      getConfig: () => transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
      refreshProviders: (input) =>
        transport.request((client) => client[WS_METHODS.serverRefreshProviders](input ?? {})),
      upsertKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpsertKeybinding](input)),
      getSettings: () => transport.request((client) => client[WS_METHODS.serverGetSettings]({})),
      updateSettings: (patch) =>
        transport.request((client) => client[WS_METHODS.serverUpdateSettings]({ patch })),
      discoverSourceControl: () =>
        transport.request((client) => client[WS_METHODS.serverDiscoverSourceControl]({})),
      listPlugins: () => transport.request((client) => client[WS_METHODS.serverListPlugins]({})),
      setPluginEnabled: (input) =>
        transport.request((client) => client[WS_METHODS.serverSetPluginEnabled](input)),
      sendPluginToThread: (input) =>
        transport.request((client) => client[WS_METHODS.pluginsSendToThread](input)),
      resolvePluginPanelThread: (input) =>
        transport.request((client) => client[WS_METHODS.pluginsResolvePanelThread](input)),
      subscribePlugins: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribePlugins]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribePlugins,
        }),
      createUnoLlmTopUpAction: (input) =>
        transport.request((client) => client[WS_METHODS.unoCreateLlmTopUpAction](input)),
      createUnoVideoUpload: (input) =>
        transport.request((client) => client[WS_METHODS.unoVideoCreateUpload](input)),
      completeUnoVideoUpload: (input) =>
        transport.request((client) => client[WS_METHODS.unoVideoCompleteUpload](input)),
      createUnoVideoJob: (input) =>
        transport.request((client) => client[WS_METHODS.unoVideoCreateJob](input)),
      getUnoVideoJob: (input) =>
        transport.request((client) => client[WS_METHODS.unoVideoGetJob](input)),
      cancelUnoVideoJob: (input) =>
        transport.request((client) => client[WS_METHODS.unoVideoCancelJob](input)),
      getUnoVideoDigest: (input) =>
        transport.request((client) => client[WS_METHODS.unoVideoGetDigest](input)),
      packUnoVideoDigest: (input) =>
        transport.request((client) => client[WS_METHODS.unoVideoPackDigest](input)),
      transcribeAudio: (input) =>
        transport.request((client) => client[WS_METHODS.unoTranscribeAudio](input)),
      subscribeConfig: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeServerConfig]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribeServerConfig,
        }),
      subscribeLifecycle: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeServerLifecycle]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribeServerLifecycle,
        }),
      subscribeAuthAccess: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeAuthAccess]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribeAuthAccess,
        }),
      subscribeAuthLinkRequests: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeAuthLinkRequests]({}),
          listener,
          {
            ...options,
            tag: WS_METHODS.subscribeAuthLinkRequests,
          },
        ),
    },
    orchestration: {
      dispatchCommand: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](input), {
          // Every orchestration command carries commandId and the server
          // persists command receipts, so replay after an ambiguous socket
          // failure is safe and cannot start the same turn twice.
          retryOnConnectionLoss: true,
        }),
      getTurnDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiff](input)),
      getFullThreadDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
      subscribeShell: (listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
          listener,
          { ...options, tag: ORCHESTRATION_WS_METHODS.subscribeShell },
        ),
      subscribeThread: (input, listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeThread](input),
          listener,
          { ...options, tag: ORCHESTRATION_WS_METHODS.subscribeThread },
        ),
    },
    browser: {
      subscribeBridge: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeBrowserBridge]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribeBrowserBridge,
        }),
    },
    vault: {
      list: () => transport.request((client) => client[WS_METHODS.vaultList]({})),
      upsert: (input) => transport.request((client) => client[WS_METHODS.vaultUpsert](input)),
      delete: (input) => transport.request((client) => client[WS_METHODS.vaultDelete](input)),
      import: (input) => transport.request((client) => client[WS_METHODS.vaultImport](input)),
      fill: (input) => transport.request((client) => client[WS_METHODS.vaultFill](input)),
      sync: (input) => transport.request((client) => client[WS_METHODS.vaultSync](input)),
    },
    workspace: {
      getState: () => transport.request((client) => client[WS_METHODS.workspaceGetState]({})),
      rename: (input) => transport.request((client) => client[WS_METHODS.workspaceRename](input)),
      syncMachines: (input) =>
        transport.request((client) => client[WS_METHODS.workspaceSyncMachines](input)),
      updateMachine: (input) =>
        transport.request((client) => client[WS_METHODS.workspaceUpdateMachine](input)),
      removeMachine: (input) =>
        transport.request((client) => client[WS_METHODS.workspaceRemoveMachine](input)),
      getInstructions: (input) =>
        transport.request((client) => client[WS_METHODS.workspaceGetInstructions](input)),
      setInstructions: (input) =>
        transport.request((client) => client[WS_METHODS.workspaceSetInstructions](input)),
      applyInstructions: (input) =>
        transport.request((client) => client[WS_METHODS.workspaceApplyInstructions](input)),
    },
    providerSetup: {
      installStart: (input) =>
        transport.request((client) => client[WS_METHODS.providerInstallStart](input)),
      installStatus: (input) =>
        transport.request((client) => client[WS_METHODS.providerInstallStatus](input)),
      authStart: (input) =>
        transport.request((client) => client[WS_METHODS.providerAuthStart](input)),
      authStatus: (input) =>
        transport.request((client) => client[WS_METHODS.providerAuthStatus](input)),
      authSubmitCode: (input) =>
        transport.request((client) => client[WS_METHODS.providerAuthSubmitCode](input)),
    },
    unoCloud: {
      getState: (input) =>
        transport.request((client) => client[WS_METHODS.unoCloudGetState](input ?? {})),
      boxPower: (input) =>
        transport.request((client) => client[WS_METHODS.unoCloudBoxPower](input)),
      connectBox: (input) =>
        transport.request((client) => client[WS_METHODS.unoCloudConnectBox](input)),
      createBox: (input) =>
        transport.request((client) => client[WS_METHODS.unoCloudCreateBox](input)),
      createBoxStatus: (input) =>
        transport.request((client) => client[WS_METHODS.unoCloudCreateBoxStatus](input)),
    },
    unoComputer: {
      getState: (input) =>
        transport.request((client) => client[WS_METHODS.unoComputerGetState](input ?? {})),
      metrics: (input) =>
        transport.request((client) => client[WS_METHODS.unoComputerMetrics](input ?? {})),
      activity: (input) =>
        transport.request((client) => client[WS_METHODS.unoComputerActivity](input ?? {})),
      apps: (input) =>
        transport.request((client) => client[WS_METHODS.unoComputerApps](input ?? {})),
      installApp: (input) =>
        transport.request((client) => client[WS_METHODS.unoComputerInstallApp](input)),
      installStatus: (input) =>
        transport.request((client) => client[WS_METHODS.unoComputerInstallStatus](input)),
      power: (input) => transport.request((client) => client[WS_METHODS.unoComputerPower](input)),
      machineApps: () =>
        transport.request((client) => client[WS_METHODS.unoComputerMachineApps]({})),
      appAction: (input) =>
        transport.request((client) => client[WS_METHODS.unoComputerAppAction](input)),
      localMetrics: () =>
        transport.request((client) => client[WS_METHODS.unoComputerLocalMetrics]({})),
    },
  };
}
