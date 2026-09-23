import { Cause, Duration, Effect, Layer, Option, Queue, Ref, Schema, Stream } from "effect";
import {
  type AuthAccessStreamEvent,
  type AuthLinkRequestStreamEvent,
  AuthSessionId,
  CommandId,
  type EnvironmentId as EnvironmentIdType,
  EventId,
  WorkspaceRpcError,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  FilesystemBrowseError,
  FilesystemReadFileError,
  FilesystemWatchFileError,
  ThreadId,
  type TerminalEvent,
  UnoBillingRpcError,
  PersonalAiRpcError,
  UnoCloudRpcError,
  UNO_GATEWAY_BASE_URL,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { RpcServer } from "effect/unstable/rpc";

import { layerJsonMobileCompat } from "./compat/rpcSerializationMobileCompat.ts";
import { translateAuthDescriptorForUpstream } from "./compat/mobileScopes.ts";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { ServerConfig } from "./config.ts";
import { Keybindings } from "./keybindings.ts";
import { Open, resolveAvailableEditors } from "./open.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import { makePanelThreadResolver, makePanelThreadSender } from "./plugins/panelThread.ts";
import { PluginRegistry } from "./plugins/PluginRegistry.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { staleProviderInstanceIds } from "./provider/staleProviders.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";
import { BrowserBridge } from "./browserBridge.ts";
import { fillCredentialInBrowser } from "./credentialsFill.ts";
import {
  pullVaultFromAccount,
  pushVaultToAccount,
  pushVaultToAccountInBackground,
} from "./credentialsAccountSync.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "./serverSettings.ts";
import {
  PersonalAiRequestError,
  fetchPersonalAiModels,
  personalAiAction,
} from "./unoPersonalAi.ts";
import { CredentialsVaultService } from "./credentialsVault.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths.ts";
import { WorkspaceService } from "./workspaceRegistry/WorkspaceService.ts";
import { UnoCloudService } from "./workspaceRegistry/UnoCloudService.ts";
import { UnoComputerService } from "./workspaceRegistry/UnoComputerService.ts";
import { FilesService } from "./files/FilesService.ts";
import { MachineAppsService } from "./machineApps/MachineAppsService.ts";
import { ComputerResourcesService } from "./computerResources/ComputerResourcesService.ts";
import { checkEmbed } from "./machineApps/embedCheck.ts";
import { AppSdkService } from "./appSdk/AppSdkService.ts";
import { HarnessSetup } from "./provider/setup/HarnessSetupService.ts";
import {
  GENERATED_INSTRUCTIONS_RELATIVE_PATH,
  WORKSPACE_INSTRUCTIONS_SCOPE,
  mergeInstructionLayers,
  readRepositoryInstructions,
  writeInstructionFiles,
} from "./workspaceRegistry/instructionLayers.ts";
import { VcsStatusBroadcaster } from "./vcs/VcsStatusBroadcaster.ts";
import { VcsProvisioningService } from "./vcs/VcsProvisioningService.ts";
import { GitWorkflowService } from "./git/GitWorkflowService.ts";
import { ContinueTransport } from "./git/continueTransport.ts";
import { makeContinueTransferStore } from "./git/continueTransferStore.ts";
import {
  makeThreadContinueComplete,
  makeThreadContinueDiscard,
  makeThreadContinueInspect,
  makeThreadContinueLand,
  makeThreadContinueLegacyRefusal,
  makeThreadContinueReadChunk,
  makeThreadContinueSnapshot,
  makeThreadContinueWriteChunk,
} from "./orchestration/continueOnMachine.ts";
import { expandHomePath } from "./pathExpansion.ts";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";
import { ProjectSetupScriptRunner } from "./project/Services/ProjectSetupScriptRunner.ts";
import { RepositoryIdentityResolver } from "./project/Services/RepositoryIdentityResolver.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import { LinkRequestService } from "./auth/Services/LinkRequestService.ts";
import * as SourceControlDiscoveryLayer from "./sourceControl/SourceControlDiscovery.ts";
import { SourceControlRepositoryService } from "./sourceControl/SourceControlRepositoryService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import {
  BootstrapCredentialService,
  type BootstrapCredentialChange,
} from "./auth/Services/BootstrapCredentialService.ts";
import {
  SessionCredentialService,
  type SessionCredentialChange,
  type SessionRole,
} from "./auth/Services/SessionCredentialService.ts";
import { respondToAuthError } from "./auth/http.ts";
import {
  cancelUnoVideoJob,
  completeUnoVideoUpload,
  createUnoVideoJob,
  createUnoVideoUpload,
  getUnoVideoDigest,
  getUnoVideoJob,
  packUnoVideoDigest,
} from "./unoVideoGateway.ts";
import { transcribeUnoAudio } from "./unoTranscription.ts";

function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

function toAuthAccessStreamEvent(
  change: BootstrapCredentialChange | SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const makeWsRpcLayer = (
  currentSessionId: AuthSessionId,
  currentSessionRole: SessionRole,
  // Mobile-compat: коннект пришёл от апстримного клиента (query wsTicket) —
  // в отдаваемых конфигах транслируем литералы session-методов в апстримные.
  mobileCompat = false,
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const linkRequests = yield* LinkRequestService;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const checkpointDiffQuery = yield* CheckpointDiffQuery;
      const keybindings = yield* Keybindings;
      const open = yield* Open;
      const gitWorkflow = yield* GitWorkflowService;
      const vcsProvisioning = yield* VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager;
      const providerRegistry = yield* ProviderRegistry;
      const pluginRegistry = yield* PluginRegistry;
      const config = yield* ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const browserBridge = yield* BrowserBridge;
      const serverSettings = yield* ServerSettingsService;
      const credentialsVault = yield* CredentialsVaultService;
      const startup = yield* ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
      const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
      const serverEnvironment = yield* ServerEnvironment;
      const serverAuth = yield* ServerAuth;
      const sourceControlDiscovery = yield* SourceControlDiscoveryLayer.SourceControlDiscovery;
      const sourceControlRepositories = yield* SourceControlRepositoryService;
      const bootstrapCredentials = yield* BootstrapCredentialService;
      const sessions = yield* SessionCredentialService;
      const workspaceRegistry = yield* WorkspaceService;
      const unoCloud = yield* UnoCloudService;
      const unoComputer = yield* UnoComputerService;
      const files = yield* FilesService;
      const machineApps = yield* MachineAppsService;
      const appSdk = yield* AppSdkService;
      const computerResources = yield* ComputerResourcesService;
      const harnessSetup = yield* HarnessSetup;
      const serverCommandId = (tag: string) =>
        CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

      const panelThreadDeps = {
        registry: pluginRegistry,
        engine: orchestrationEngine,
        projections: projectionSnapshotQuery,
      };
      const sendPluginPanelToThread = makePanelThreadSender(panelThreadDeps);
      const resolvePluginPanelThread = makePanelThreadResolver(panelThreadDeps);

      const continueTransport = yield* ContinueTransport;
      const continueOnMachineDeps = {
        transport: continueTransport,
        transfers: makeContinueTransferStore({
          rootDir: nodePath.join(config.tempDir, "continue"),
        }),
        worktreesDir: config.worktreesDir,
        projections: projectionSnapshotQuery,
        engine: orchestrationEngine,
        getProviders: providerRegistry.getProviders,
        getMachineLabel: serverEnvironment.getDescriptor.pipe(
          Effect.map((descriptor) => descriptor.label),
        ),
        readEnvFile: (folder: string) =>
          workspaceFileSystem.readFile({ path: nodePath.join(folder, ".env") }).pipe(
            Effect.map((file) =>
              file.encoding === "utf8"
                ? file.content
                : Buffer.from(file.content, "base64").toString("utf8"),
            ),
            Effect.catch(() => Effect.succeed(null)),
          ),
        writeEnvFile: (folder: string, text: string) =>
          workspaceFileSystem
            .writeFile({ cwd: folder, relativePath: ".env", contents: text, encoding: "utf8" })
            .pipe(Effect.asVoid),
        cloneRepository: (input: {
          readonly remoteUrl: string;
          readonly destinationPath: string;
        }) => sourceControlRepositories.cloneRepository(input),
        directoryExists: (path: string) =>
          Effect.tryPromise(() => fsPromises.stat(path)).pipe(
            Effect.map((stats) => stats.isDirectory()),
            Effect.catch(() => Effect.succeed(false)),
          ),
        makeDirectory: (path: string) =>
          Effect.tryPromise(() => fsPromises.mkdir(path, { recursive: true })).pipe(Effect.asVoid),
        expandPath: expandHomePath,
      };
      const threadContinueInspect = makeThreadContinueInspect(continueOnMachineDeps);
      const threadContinueSnapshot = makeThreadContinueSnapshot(continueOnMachineDeps);
      const threadContinueReadChunk = makeThreadContinueReadChunk(continueOnMachineDeps);
      const threadContinueWriteChunk = makeThreadContinueWriteChunk(continueOnMachineDeps);
      const threadContinueLand = makeThreadContinueLand(continueOnMachineDeps);
      const threadContinueDiscard = makeThreadContinueDiscard(continueOnMachineDeps);
      const threadContinueComplete = makeThreadContinueComplete(continueOnMachineDeps);

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks().pipe(Effect.orDie),
          clientSessions: serverAuth.listClientSessions(currentSessionId).pipe(Effect.orDie),
        });

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: serverCommandId("setup-script-activity"),
          threadId: input.threadId,
          activity: {
            id: EventId.make(crypto.randomUUID()),
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        });

      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        Schema.is(OrchestrationDispatchCommandError)(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              cause,
            });

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return Schema.is(OrchestrationDispatchCommandError)(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
              cause,
            });
      };

      const enrichProjectEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<OrchestrationEvent, never, never> => {
        switch (event.type) {
          case "project.created":
            return repositoryIdentityResolver.resolve(event.payload.workspaceRoot).pipe(
              Effect.map((repositoryIdentity) => ({
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              })),
            );
          case "project.meta-updated":
            return Effect.gen(function* () {
              const workspaceRoot =
                event.payload.workspaceRoot ??
                Option.match(
                  yield* projectionSnapshotQuery.getProjectShellById(event.payload.projectId),
                  {
                    onNone: () => null,
                    onSome: (project) => project.workspaceRoot,
                  },
                ) ??
                null;
              if (workspaceRoot === null) {
                return event;
              }

              const repositoryIdentity = yield* repositoryIdentityResolver.resolve(workspaceRoot);
              return {
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              } satisfies OrchestrationEvent;
            }).pipe(Effect.catch(() => Effect.succeed(event)));
          default:
            return Effect.succeed(event);
        }
      };

      const enrichOrchestrationEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
        Effect.forEach(events, enrichProjectEvent, { concurrency: 4 });

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return projectionSnapshotQuery.getProjectShellById(event.payload.projectId).pipe(
              Effect.map((project) =>
                Option.map(project, (nextProject) => ({
                  kind: "project-upserted" as const,
                  sequence: event.sequence,
                  project: nextProject,
                })),
              ),
              Effect.catch(() => Effect.succeed(Option.none())),
            );
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          default:
            if (event.aggregateKind !== "thread") {
              return Effect.succeed(Option.none());
            }
            return projectionSnapshotQuery
              .getThreadShellById(ThreadId.make(event.aggregateId))
              .pipe(
                Effect.map((thread) =>
                  Option.map(thread, (nextThread) => ({
                    kind: "thread-upserted" as const,
                    sequence: event.sequence,
                    thread: nextThread,
                  })),
                ),
                Effect.catch(() => Effect.succeed(Option.none())),
              );
        }
      };

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          let createdThread = false;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

          const cleanupCreatedThread = () =>
            createdThread
              ? orchestrationEngine
                  .dispatch({
                    type: "thread.delete",
                    commandId: serverCommandId("bootstrap-thread-delete"),
                    threadId: command.threadId,
                  })
                  .pipe(Effect.ignoreCause({ log: true }))
              : Effect.void;

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: unknown;
            readonly requestedAt: string;
            readonly worktreePath: string;
          }) => {
            const detail =
              input.error instanceof Error ? input.error.message : "Unknown setup failure.";
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          };

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string;
            readonly worktreePath: string;
            readonly scriptId: string;
            readonly scriptName: string;
            readonly terminalId: string;
          }) => {
            const payload = {
              scriptId: input.scriptId,
              scriptName: input.scriptName,
              terminalId: input.terminalId,
              worktreePath: input.worktreePath,
            };
            return Effect.all([
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.requested",
                summary: "Starting setup script",
                createdAt: input.requestedAt,
                payload,
                tone: "info",
              }),
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.started",
                summary: "Setup script started",
                createdAt: new Date().toISOString(),
                payload,
                tone: "info",
              }),
            ]).pipe(
              Effect.asVoid,
              Effect.catch((error) =>
                Effect.logWarning(
                  "bootstrap turn start launched setup script but failed to record setup activity",
                  {
                    threadId: command.threadId,
                    worktreePath: input.worktreePath,
                    scriptId: input.scriptId,
                    terminalId: input.terminalId,
                    detail: error.message,
                  },
                ),
              ),
            );
          };

          const runSetupProgram = () =>
            bootstrap?.runSetupScript && targetWorktreePath
              ? (() => {
                  const worktreePath = targetWorktreePath;
                  const requestedAt = new Date().toISOString();
                  return projectSetupScriptRunner
                    .runForThread({
                      threadId: command.threadId,
                      ...(targetProjectId ? { projectId: targetProjectId } : {}),
                      ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                      worktreePath,
                    })
                    .pipe(
                      Effect.matchEffect({
                        onFailure: (error) =>
                          recordSetupScriptLaunchFailure({
                            error,
                            requestedAt,
                            worktreePath,
                          }),
                        onSuccess: (setupResult) => {
                          if (setupResult.status !== "started") {
                            return Effect.void;
                          }
                          return recordSetupScriptStarted({
                            requestedAt,
                            worktreePath,
                            scriptId: setupResult.scriptId,
                            scriptName: setupResult.scriptName,
                            terminalId: setupResult.terminalId,
                          });
                        },
                      }),
                    );
                })()
              : Effect.void;

          const bootstrapProgram = Effect.gen(function* () {
            if (bootstrap?.createThread) {
              // A stale/persisted client draft can re-send bootstrap.createThread
              // with a thread id that was already created (the composer draft
              // pins its server thread id and survives reloads). Treat an
              // already-existing thread as a benign no-op and proceed to the
              // turn instead of aborting the whole send with a hard
              // "already exists" invariant failure the user sees as an error.
              const alreadyExists = yield* projectionSnapshotQuery
                .getThreadShellById(command.threadId)
                .pipe(
                  Effect.map(Option.isSome),
                  Effect.catch(() => Effect.succeed(false)),
                );
              if (alreadyExists) {
                yield* Effect.logWarning(
                  "bootstrap turn start reused an existing thread id; skipping thread.create",
                  { threadId: command.threadId },
                );
              } else {
                yield* orchestrationEngine.dispatch({
                  type: "thread.create",
                  commandId: serverCommandId("bootstrap-thread-create"),
                  threadId: command.threadId,
                  projectId: bootstrap.createThread.projectId,
                  title: bootstrap.createThread.title,
                  modelSelection: bootstrap.createThread.modelSelection,
                  runtimeMode: bootstrap.createThread.runtimeMode,
                  interactionMode: bootstrap.createThread.interactionMode,
                  branch: bootstrap.createThread.branch,
                  worktreePath: bootstrap.createThread.worktreePath,
                  createdAt: bootstrap.createThread.createdAt,
                });
                createdThread = true;
              }
            }

            if (bootstrap?.prepareWorktree) {
              const worktree = yield* gitWorkflow.createWorktree({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: bootstrap.prepareWorktree.baseBranch,
                newRefName: bootstrap.prepareWorktree.branch,
                path: null,
              });
              targetWorktreePath = worktree.worktree.path;
              yield* orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: serverCommandId("bootstrap-thread-meta-update"),
                threadId: command.threadId,
                branch: worktree.worktree.refName,
                worktreePath: targetWorktreePath,
              });
              yield* refreshGitStatus(targetWorktreePath);
            }

            yield* runSetupProgram();

            return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.fail(dispatchError);
              }
              return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
            }),
          );
        });

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : orchestrationEngine
                .dispatch(normalizedCommand)
                .pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                  ),
                );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = redactServerSettingsForClient(yield* serverSettings.getSettings);
        const environment = yield* serverEnvironment.getDescriptor;
        const rawAuth = yield* serverAuth.getDescriptor();
        const auth = mobileCompat ? translateAuthDescriptorForUpstream(rawAuth) : rawAuth;

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors: resolveAvailableEditors(),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
        };
      });

      // Personal AI: ключ — тот же, что у пополнения (ключ аккаунта или шлюза;
      // бэкенд пускает оба). Ошибки — человеческим текстом для тоста.
      const personalAiKey = serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.uno.apiKey.trim()),
        Effect.orElseSucceed(() => ""),
      );
      const toPersonalAiError = (cause: unknown) =>
        new PersonalAiRpcError({
          message: cause instanceof Error ? cause.message : String(cause),
          ...(cause instanceof PersonalAiRequestError && cause.code ? { code: cause.code } : {}),
        });
      const listPersonalAi = () =>
        Effect.flatMap(personalAiKey, (key) =>
          Effect.tryPromise({ try: () => fetchPersonalAiModels(key), catch: toPersonalAiError }),
        );
      const personalAiDo = (modelId: string, action: "start" | "stop") =>
        Effect.flatMap(personalAiKey, (key) =>
          Effect.tryPromise({
            try: () => personalAiAction(key, modelId, action),
            catch: toPersonalAiError,
          }),
        );

      const createUnoLlmTopUpAction = (input: { readonly amount?: number | undefined }) =>
        Effect.gen(function* () {
          const amount =
            typeof input.amount === "number" && Number.isFinite(input.amount) && input.amount > 0
              ? input.amount
              : 10;
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError(
              () =>
                new UnoBillingRpcError({
                  message: "Unable to read Uno billing settings.",
                }),
            ),
          );
          const apiKey = settings.uno.apiKey.trim();
          if (apiKey.length === 0) {
            return yield* new UnoBillingRpcError({
              message: "Connect your Uno account before topping up LLM credits.",
            });
          }
          const apiBaseUrl = UNO_GATEWAY_BASE_URL.replace(/\/v1\/?$/, "");
          const authHeaders = {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          };
          const buyResponse = yield* Effect.tryPromise({
            try: () =>
              fetch(`${apiBaseUrl}/llm/credits/buy`, {
                method: "POST",
                headers: authHeaders,
                body: JSON.stringify({ amount }),
              }),
            catch: (cause) =>
              new UnoBillingRpcError({
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          });
          if (buyResponse.ok) {
            const body = (yield* Effect.tryPromise({
              try: () => buyResponse.json(),
              catch: () =>
                new UnoBillingRpcError({ message: "Uno credits purchase response was invalid." }),
            })) as {
              readonly llm_balance?: unknown;
              readonly charged_from_balance?: unknown;
            };
            return {
              kind: "credits_bought" as const,
              llmBalance: typeof body.llm_balance === "number" ? body.llm_balance : 0,
              chargedFromBalance:
                typeof body.charged_from_balance === "number" ? body.charged_from_balance : amount,
            };
          }
          if (buyResponse.status !== 402) {
            const detail = yield* Effect.promise(() =>
              buyResponse.text().catch(() => `HTTP ${buyResponse.status}`),
            );
            return yield* new UnoBillingRpcError({
              message: detail || `Uno credits purchase failed with HTTP ${buyResponse.status}.`,
            });
          }
          const linkResponse = yield* Effect.tryPromise({
            try: () =>
              fetch(`${apiBaseUrl}/pay/create-link`, {
                method: "POST",
                headers: authHeaders,
                body: JSON.stringify({ amount }),
              }),
            catch: (cause) =>
              new UnoBillingRpcError({
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          });
          if (!linkResponse.ok) {
            const detail = yield* Effect.promise(() =>
              linkResponse.text().catch(() => `HTTP ${linkResponse.status}`),
            );
            return yield* new UnoBillingRpcError({
              message:
                detail || `Uno payment link creation failed with HTTP ${linkResponse.status}.`,
            });
          }
          const body = (yield* Effect.tryPromise({
            try: () => linkResponse.json(),
            catch: () =>
              new UnoBillingRpcError({ message: "Uno payment link response was invalid." }),
          })) as { readonly payment_url?: unknown; readonly amount?: unknown };
          if (typeof body.payment_url !== "string" || body.payment_url.length === 0) {
            return yield* new UnoBillingRpcError({
              message: "Uno payment link response did not include a payment URL.",
            });
          }
          return {
            kind: "payment_link" as const,
            paymentUrl: body.payment_url,
            amount: typeof body.amount === "number" ? body.amount : amount,
          };
        });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      const readInstructionLayers = (input: {
        readonly environmentId: string;
        readonly projectPath?: string | undefined;
      }) =>
        Effect.gen(function* () {
          const workspaceText = yield* workspaceRegistry.getInstructionText({
            scope: WORKSPACE_INSTRUCTIONS_SCOPE,
          });
          const machineText = yield* workspaceRegistry.getInstructionText({
            scope: input.environmentId,
          });
          const repositoryText = input.projectPath
            ? yield* Effect.promise(() => readRepositoryInstructions(input.projectPath ?? "")).pipe(
                Effect.orElseSucceed(() => ""),
              )
            : "";
          return { repository: repositoryText, workspace: workspaceText, machine: machineText };
        });

      const getWorkspaceInstructions = (input: {
        readonly environmentId: EnvironmentIdType;
        readonly projectPath?: string | undefined;
      }) =>
        Effect.gen(function* () {
          const layers = yield* readInstructionLayers(input);
          return {
            environmentId: input.environmentId,
            layers: [
              {
                kind: "repository" as const,
                text: layers.repository,
                editable: false,
                source: input.projectPath ? "AGENTS.md from git" : "no project selected",
              },
              {
                kind: "workspace" as const,
                text: layers.workspace,
                editable: true,
                source: "workspace manifest",
              },
              {
                kind: "machine" as const,
                text: layers.machine,
                editable: true,
                source: "this machine — overrides the workspace",
              },
            ],
            merged: mergeInstructionLayers(layers),
          };
        });

      const applyWorkspaceInstructions = (input: {
        readonly environmentId: EnvironmentIdType;
        readonly projectPath: string;
      }) =>
        Effect.gen(function* () {
          const layers = yield* readInstructionLayers(input);
          const result = yield* Effect.tryPromise({
            try: () =>
              writeInstructionFiles({
                projectPath: input.projectPath,
                layers,
                createPointerIfMissing: true,
              }),
            catch: (cause) =>
              new WorkspaceRpcError({
                message:
                  cause instanceof Error
                    ? `Unable to write ${GENERATED_INSTRUCTIONS_RELATIVE_PATH}: ${cause.message}`
                    : `Unable to write ${GENERATED_INSTRUCTIONS_RELATIVE_PATH}.`,
              }),
          });
          return result;
        });

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              const needsVideoMaterialization =
                command.type === "thread.turn.start" &&
                command.message.attachments.some(
                  (attachment) => attachment.type === "video_digest",
                );
              const unoApiKey = needsVideoMaterialization
                ? yield* serverSettings.getSettings.pipe(
                    Effect.map((settings) => settings.uno.apiKey),
                    Effect.catch(() => Effect.succeed("")),
                  )
                : null;
              const normalizedCommand = yield* normalizeDispatchCommand(command, { unoApiKey });
              const shouldStopSessionAfterArchive =
                normalizedCommand.type === "thread.archive"
                  ? yield* projectionSnapshotQuery
                      .getThreadShellById(normalizedCommand.threadId)
                      .pipe(
                        Effect.map(
                          Option.match({
                            onNone: () => false,
                            onSome: (thread) =>
                              thread.session !== null && thread.session.status !== "stopped",
                          }),
                        ),
                        Effect.catch(() => Effect.succeed(false)),
                      )
                  : false;
              const result = yield* dispatchNormalizedCommand(normalizedCommand);
              if (normalizedCommand.type === "thread.archive") {
                if (shouldStopSessionAfterArchive) {
                  yield* Effect.gen(function* () {
                    const stopCommand = yield* normalizeDispatchCommand({
                      type: "thread.session.stop",
                      commandId: CommandId.make(
                        `session-stop-for-archive:${normalizedCommand.commandId}`,
                      ),
                      threadId: normalizedCommand.threadId,
                      createdAt: new Date().toISOString(),
                    });

                    yield* dispatchNormalizedCommand(stopCommand);
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to stop provider session during archive", {
                        threadId: normalizedCommand.threadId,
                        cause,
                      }),
                    ),
                  );
                }

                yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId: normalizedCommand.threadId,
                      error: error.message,
                    }),
                  ),
                );
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                Schema.is(OrchestrationDispatchCommandError)(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.replayEvents,
            Stream.runCollect(
              orchestrationEngine.readEvents(
                clamp(input.fromSequenceExclusive, {
                  maximum: Number.MAX_SAFE_INTEGER,
                  minimum: 0,
                }),
              ),
            ).pipe(
              Effect.map((events) => Array.from(events)),
              Effect.flatMap(enrichOrchestrationEvents),
              Effect.mapError(
                (cause) =>
                  new OrchestrationReplayEventsError({
                    message: "Failed to replay orchestration events",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (_input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.tapError((cause) =>
                  Effect.logError("orchestration shell snapshot load failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                      cause,
                    }),
                ),
              );

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.mapEffect(toShellStreamEvent),
                Stream.flatMap((event) =>
                  Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
                ),
              );

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot,
                }),
                liveStream,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              const [threadDetail, snapshotSequence] = yield* Effect.all([
                projectionSnapshotQuery.getThreadDetailById(input.threadId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to load thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                ),
                projectionSnapshotQuery.getSnapshotSequence().pipe(
                  Effect.map(({ snapshotSequence }) => snapshotSequence),
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to load orchestration snapshot sequence",
                        cause,
                      }),
                  ),
                ),
              ]);

              if (Option.isNone(threadDetail)) {
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter(
                  (event) =>
                    event.aggregateKind === "thread" &&
                    event.aggregateId === input.threadId &&
                    isThreadDetailEvent(event),
                ),
                Stream.map((event) => ({
                  kind: "event" as const,
                  event,
                })),
              );

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot: {
                    snapshotSequence,
                    thread: threadDetail.value,
                  },
                }),
                liveStream,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        // Mobile-compat: заглушки методов апстримного клиента. Смысл — не дать
        // вызову свалиться в defect "Unknown request tag" (он в effect/rpc не
        // привязан к requestId и рушит все in-flight запросы клиента).
        [WS_METHODS.serverProbe]: (_input) =>
          observeRpcEffect(WS_METHODS.serverProbe, Effect.succeed({}), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverReportClientActivity]: (_input) =>
          observeRpcEffect(WS_METHODS.serverReportClientActivity, Effect.void, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            (input.instanceId !== undefined
              ? providerRegistry.refreshInstance(input.instanceId)
              : providerRegistry.refresh()
            ).pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(Effect.map(redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            serverSettings.updateSettings(patch).pipe(Effect.map(redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.vaultList]: (_input) =>
          observeRpcEffect(WS_METHODS.vaultList, credentialsVault.list, {
            "rpc.aggregate": "vault",
          }),
        // Каждая мутация хранилища тянет за собой фоновый push в аккаунт Uno
        // (если синк включён): иначе правка осталась бы только на этой машине.
        [WS_METHODS.vaultUpsert]: (input) =>
          observeRpcEffect(
            WS_METHODS.vaultUpsert,
            credentialsVault.upsert(input).pipe(Effect.tap(() => pushVaultToAccountInBackground)),
            { "rpc.aggregate": "vault" },
          ),
        [WS_METHODS.vaultDelete]: ({ id }) =>
          observeRpcEffect(
            WS_METHODS.vaultDelete,
            credentialsVault.remove(id).pipe(Effect.tap(() => pushVaultToAccountInBackground)),
            { "rpc.aggregate": "vault" },
          ),
        [WS_METHODS.vaultImport]: ({ items }) =>
          observeRpcEffect(
            WS_METHODS.vaultImport,
            credentialsVault
              .importItems(items)
              .pipe(Effect.tap(() => pushVaultToAccountInBackground)),
            { "rpc.aggregate": "vault" },
          ),
        [WS_METHODS.vaultSync]: ({ direction }) =>
          observeRpcEffect(
            WS_METHODS.vaultSync,
            direction === "push" ? pushVaultToAccount : pullVaultFromAccount,
            { "rpc.aggregate": "vault" },
          ),
        [WS_METHODS.vaultFill]: (input) =>
          observeRpcEffect(WS_METHODS.vaultFill, fillCredentialInBrowser(input), {
            "rpc.aggregate": "vault",
          }),
        [WS_METHODS.workspaceGetState]: (_input) =>
          observeRpcEffect(WS_METHODS.workspaceGetState, workspaceRegistry.getState, {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.workspaceRename]: (input) =>
          observeRpcEffect(WS_METHODS.workspaceRename, workspaceRegistry.rename(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.workspaceSyncMachines]: (input) =>
          observeRpcEffect(
            WS_METHODS.workspaceSyncMachines,
            workspaceRegistry.syncMachines(input),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.workspaceUpdateMachine]: (input) =>
          observeRpcEffect(
            WS_METHODS.workspaceUpdateMachine,
            workspaceRegistry.updateMachine(input),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.workspaceRemoveMachine]: (input) =>
          observeRpcEffect(
            WS_METHODS.workspaceRemoveMachine,
            workspaceRegistry.removeMachine(input),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.workspaceGetInstructions]: (input) =>
          observeRpcEffect(WS_METHODS.workspaceGetInstructions, getWorkspaceInstructions(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.workspaceSetInstructions]: (input) =>
          observeRpcEffect(
            WS_METHODS.workspaceSetInstructions,
            workspaceRegistry.setInstructionText(input),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.workspaceApplyInstructions]: (input) =>
          observeRpcEffect(
            WS_METHODS.workspaceApplyInstructions,
            applyWorkspaceInstructions(input),
            { "rpc.aggregate": "workspace" },
          ),
        // Both cloud calls answer with state rather than failing: an
        // unreachable control plane is reported inside `UnoCloudState.error`,
        // so the panel keeps rendering the machines it already knows about.
        [WS_METHODS.unoCloudGetState]: (input) =>
          observeRpcEffect(WS_METHODS.unoCloudGetState, unoCloud.getState(input), {
            "rpc.aggregate": "uno-cloud",
          }),
        [WS_METHODS.unoCloudBoxPower]: (input) =>
          observeRpcEffect(WS_METHODS.unoCloudBoxPower, unoCloud.boxPower(input), {
            "rpc.aggregate": "uno-cloud",
          }),
        [WS_METHODS.unoCloudConnectBox]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoCloudConnectBox,
            unoCloud
              .connectBox(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-cloud" },
          ),
        // Creating a box is billable: the RPC starts one background job and
        // answers with its id; the client polls `createBoxStatus`.
        [WS_METHODS.unoCloudCreateBox]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoCloudCreateBox,
            unoCloud
              .createBox(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-cloud" },
          ),
        [WS_METHODS.unoCloudCreateBoxStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoCloudCreateBoxStatus,
            unoCloud
              .createBoxStatus(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-cloud" },
          ),
        // "This computer": reads answer with an availability instead of failing,
        // so a control-plane route that is not deployed yet reads as "coming soon".
        // Files app: the computer's file manager and its public share links.
        [WS_METHODS.filesList]: (input) =>
          observeRpcEffect(WS_METHODS.filesList, files.list(input), { "rpc.aggregate": "files" }),
        [WS_METHODS.filesStat]: (input) =>
          observeRpcEffect(WS_METHODS.filesStat, files.stat(input), { "rpc.aggregate": "files" }),
        [WS_METHODS.filesCreateFolder]: (input) =>
          observeRpcEffect(WS_METHODS.filesCreateFolder, files.createFolder(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesRename]: (input) =>
          observeRpcEffect(WS_METHODS.filesRename, files.rename(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesMove]: (input) =>
          observeRpcEffect(WS_METHODS.filesMove, files.move(input), { "rpc.aggregate": "files" }),
        [WS_METHODS.filesDelete]: (input) =>
          observeRpcEffect(WS_METHODS.filesDelete, files.remove(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesSearch]: (input) =>
          observeRpcEffect(WS_METHODS.filesSearch, files.search(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesShareCreate]: (input) =>
          observeRpcEffect(WS_METHODS.filesShareCreate, files.createShare(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesShareList]: (input) =>
          observeRpcEffect(WS_METHODS.filesShareList, files.listShares(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesShareRevoke]: (input) =>
          observeRpcEffect(WS_METHODS.filesShareRevoke, files.revokeShare(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesCloudState]: (input) =>
          observeRpcEffect(WS_METHODS.filesCloudState, files.cloudState, {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesCloudList]: (input) =>
          observeRpcEffect(WS_METHODS.filesCloudList, files.cloudList(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesCloudCreateBucket]: (input) =>
          observeRpcEffect(WS_METHODS.filesCloudCreateBucket, files.cloudCreateBucket(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesCloudDelete]: (input) =>
          observeRpcEffect(WS_METHODS.filesCloudDelete, files.cloudDelete(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesCloudDownloadUrl]: (input) =>
          observeRpcEffect(WS_METHODS.filesCloudDownloadUrl, files.cloudDownloadUrl(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesCloudCopyToCloud]: (input) =>
          observeRpcEffect(WS_METHODS.filesCloudCopyToCloud, files.cloudCopyToCloud(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesCloudCopyToComputer]: (input) =>
          observeRpcEffect(WS_METHODS.filesCloudCopyToComputer, files.cloudCopyToComputer(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesCloudOfficeOpen]: (input) =>
          observeRpcEffect(WS_METHODS.filesCloudOfficeOpen, files.cloudOfficeOpen(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesCloudOfficeSave]: (input) =>
          observeRpcEffect(WS_METHODS.filesCloudOfficeSave, files.cloudOfficeSave(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.filesPublishSite]: (input) =>
          observeRpcEffect(WS_METHODS.filesPublishSite, files.publishSite(input), {
            "rpc.aggregate": "files",
          }),
        [WS_METHODS.unoComputerGetState]: (input) =>
          observeRpcEffect(WS_METHODS.unoComputerGetState, unoComputer.getState(input), {
            "rpc.aggregate": "uno-computer",
          }),
        [WS_METHODS.unoComputerMetrics]: (input) =>
          observeRpcEffect(WS_METHODS.unoComputerMetrics, unoComputer.metrics(input), {
            "rpc.aggregate": "uno-computer",
          }),
        [WS_METHODS.unoComputerActivity]: (input) =>
          observeRpcEffect(WS_METHODS.unoComputerActivity, unoComputer.activity(input), {
            "rpc.aggregate": "uno-computer",
          }),
        [WS_METHODS.unoComputerApps]: (input) =>
          observeRpcEffect(WS_METHODS.unoComputerApps, unoComputer.apps(input), {
            "rpc.aggregate": "uno-computer",
          }),
        [WS_METHODS.unoComputerInstallApp]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerInstallApp,
            unoComputer
              .installApp(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.unoComputerInstallStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerInstallStatus,
            unoComputer
              .installStatus(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.unoComputerRemoveApp]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerRemoveApp,
            unoComputer
              .removeApp(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.unoComputerSetAppAiLimit]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerSetAppAiLimit,
            unoComputer
              .setAppAiLimit(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.unoComputerOpenApp]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerOpenApp,
            unoComputer
              .openApp(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.unoComputerAppAccess]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerAppAccess,
            unoComputer
              .appAccess(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.unoComputerShareApp]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerShareApp,
            unoComputer
              .shareApp(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.unoComputerUnshareApp]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerUnshareApp,
            unoComputer
              .unshareApp(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-computer" },
          ),
        // Power reuses `uno.cloud.boxPower` (same key, same control-plane call)
        // and answers with the refreshed computer.
        [WS_METHODS.unoComputerPower]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerPower,
            Effect.gen(function* () {
              const boxId = yield* unoComputer.resolveBoxId(input);
              if (boxId === null) {
                return yield* new UnoCloudRpcError({
                  message: "This machine isn't an Uno computer.",
                });
              }
              // Своя машина — её же токеном (на Work-машине ключа аккаунта нет,
              // а ключ ИИ консоль не принимает). Иначе — ключом аккаунта.
              const viaBoxToken = yield* unoComputer
                .powerOwnBox(boxId, input.action)
                .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message })));
              if (viaBoxToken) return yield* unoComputer.getState({ boxId });
              const cloud = yield* unoCloud.boxPower({ boxId, action: input.action });
              if (!cloud.connected) {
                return yield* new UnoCloudRpcError({
                  message: cloud.error ?? "Connect your Uno account first.",
                });
              }
              if (cloud.error !== null) {
                return yield* new UnoCloudRpcError({ message: cloud.error });
              }
              return yield* unoComputer.getState({ boxId });
            }),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.unoComputerResizeOptions]: (input) =>
          observeRpcEffect(WS_METHODS.unoComputerResizeOptions, unoComputer.resizeOptions(input), {
            "rpc.aggregate": "uno-computer",
          }),
        [WS_METHODS.unoComputerResize]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerResize,
            unoComputer
              .resize(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.unoComputerBoost]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerBoost,
            unoComputer
              .boost(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.unoComputerEndBoost]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerEndBoost,
            unoComputer
              .endBoost(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.unoComputerMachineApps]: (_input) =>
          observeRpcEffect(WS_METHODS.unoComputerMachineApps, machineApps.list, {
            "rpc.aggregate": "uno-computer",
          }),
        [WS_METHODS.unoComputerAppAction]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerAppAction,
            machineApps
              .action(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.unoComputerEmbedCheck]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerEmbedCheck,
            Effect.promise(() => checkEmbed(input)),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.appAiList]: (_input) =>
          observeRpcEffect(WS_METHODS.appAiList, appSdk.overview, {
            "rpc.aggregate": "app-sdk",
          }),
        [WS_METHODS.appAiUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.appAiUpdate,
            appSdk
              .update(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "app-sdk" },
          ),
        [WS_METHODS.unoComputerLocalMetrics]: (_input) =>
          observeRpcEffect(WS_METHODS.unoComputerLocalMetrics, machineApps.localMetrics, {
            "rpc.aggregate": "uno-computer",
          }),
        [WS_METHODS.unoComputerResources]: (_input) =>
          observeRpcEffect(WS_METHODS.unoComputerResources, computerResources.snapshot, {
            "rpc.aggregate": "uno-computer",
          }),
        [WS_METHODS.unoComputerDiskUsage]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerDiskUsage,
            computerResources
              .diskUsage(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.unoComputerDiskClean]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerDiskClean,
            computerResources
              .clean(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.unoComputerResourceAction]: (input) =>
          observeRpcEffect(
            WS_METHODS.unoComputerResourceAction,
            computerResources
              .action(input)
              .pipe(Effect.mapError((cause) => new UnoCloudRpcError({ message: cause.message }))),
            { "rpc.aggregate": "uno-computer" },
          ),
        [WS_METHODS.serverListPlugins]: (_input) =>
          observeRpcEffect(WS_METHODS.serverListPlugins, pluginRegistry.getSnapshot, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverSetPluginEnabled]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverSetPluginEnabled,
            pluginRegistry.setPluginEnabled(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.pluginsSendToThread]: (input) =>
          observeRpcEffect(WS_METHODS.pluginsSendToThread, sendPluginPanelToThread(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.pluginsResolvePanelThread]: (input) =>
          observeRpcEffect(WS_METHODS.pluginsResolvePanelThread, resolvePluginPanelThread(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.unoPersonalAiList]: () =>
          observeRpcEffect(WS_METHODS.unoPersonalAiList, listPersonalAi(), {
            "rpc.aggregate": "uno",
          }),
        [WS_METHODS.unoPersonalAiStart]: (input) =>
          observeRpcEffect(WS_METHODS.unoPersonalAiStart, personalAiDo(input.modelId, "start"), {
            "rpc.aggregate": "uno",
          }),
        [WS_METHODS.unoPersonalAiStop]: (input) =>
          observeRpcEffect(WS_METHODS.unoPersonalAiStop, personalAiDo(input.modelId, "stop"), {
            "rpc.aggregate": "uno",
          }),
        [WS_METHODS.unoCreateLlmTopUpAction]: (input) =>
          observeRpcEffect(WS_METHODS.unoCreateLlmTopUpAction, createUnoLlmTopUpAction(input), {
            "rpc.aggregate": "uno",
          }),
        [WS_METHODS.unoVideoCreateUpload]: (input) =>
          observeRpcEffect(WS_METHODS.unoVideoCreateUpload, createUnoVideoUpload(input), {
            "rpc.aggregate": "uno-video",
          }),
        [WS_METHODS.unoVideoCompleteUpload]: (input) =>
          observeRpcEffect(WS_METHODS.unoVideoCompleteUpload, completeUnoVideoUpload(input), {
            "rpc.aggregate": "uno-video",
          }),
        [WS_METHODS.unoVideoCreateJob]: (input) =>
          observeRpcEffect(WS_METHODS.unoVideoCreateJob, createUnoVideoJob(input), {
            "rpc.aggregate": "uno-video",
          }),
        [WS_METHODS.unoVideoGetJob]: (input) =>
          observeRpcEffect(WS_METHODS.unoVideoGetJob, getUnoVideoJob(input), {
            "rpc.aggregate": "uno-video",
          }),
        [WS_METHODS.unoVideoCancelJob]: (input) =>
          observeRpcEffect(WS_METHODS.unoVideoCancelJob, cancelUnoVideoJob(input), {
            "rpc.aggregate": "uno-video",
          }),
        [WS_METHODS.unoVideoGetDigest]: (input) =>
          observeRpcEffect(WS_METHODS.unoVideoGetDigest, getUnoVideoDigest(input), {
            "rpc.aggregate": "uno-video",
          }),
        [WS_METHODS.unoVideoPackDigest]: (input) =>
          observeRpcEffect(WS_METHODS.unoVideoPackDigest, packUnoVideoDigest(input), {
            "rpc.aggregate": "uno-video",
          }),
        [WS_METHODS.unoTranscribeAudio]: (input) =>
          observeRpcEffect(WS_METHODS.unoTranscribeAudio, transcribeUnoAudio(input), {
            "rpc.aggregate": "uno",
          }),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            sourceControlRepositories
              .publishRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    message: `Failed to search workspace entries: ${cause.detail}`,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError((cause) => {
                const message = Schema.is(WorkspacePathOutsideRootError)(cause)
                  ? "Workspace file path must stay within the project root."
                  : "Failed to write workspace file";
                return new ProjectWriteFileError({
                  message,
                  cause,
                });
              }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, open.openInEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    message: cause.detail,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.filesystemReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemReadFile,
            workspaceFileSystem.readFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemReadFileError({
                    message: cause.detail,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeFileChanges]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeFileChanges,
            workspaceFileSystem.watchFile(input).pipe(
              Stream.mapError(
                (cause) =>
                  new FilesystemWatchFileError({
                    message: cause.detail,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            vcsStatusBroadcaster.streamStatus(input),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            vcsStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            gitWorkflow.pullCurrentBranch(input.cwd).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
              gitWorkflow
                .runStackedAction(input, {
                  actionId: input.actionId,
                  progressReporter: {
                    publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                  },
                })
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) => Queue.failCause(queue, cause),
                    onSuccess: () =>
                      refreshGitStatus(input.cwd).pipe(
                        Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            gitWorkflow.resolvePullRequest(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitWorkflow
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.threadContinueInspect]: (input) =>
          observeRpcEffect(WS_METHODS.threadContinueInspect, threadContinueInspect(input), {
            "rpc.aggregate": "thread-continue",
          }),
        [WS_METHODS.threadContinueSnapshot]: (input) =>
          observeRpcEffect(WS_METHODS.threadContinueSnapshot, threadContinueSnapshot(input), {
            "rpc.aggregate": "thread-continue",
          }),
        [WS_METHODS.threadContinueReadChunk]: (input) =>
          observeRpcEffect(WS_METHODS.threadContinueReadChunk, threadContinueReadChunk(input), {
            "rpc.aggregate": "thread-continue",
          }),
        [WS_METHODS.threadContinueWriteChunk]: (input) =>
          observeRpcEffect(WS_METHODS.threadContinueWriteChunk, threadContinueWriteChunk(input), {
            "rpc.aggregate": "thread-continue",
          }),
        [WS_METHODS.threadContinueLand]: (input) =>
          observeRpcEffect(
            WS_METHODS.threadContinueLand,
            threadContinueLand(input).pipe(
              Effect.tap((result) => refreshGitStatus(result.worktreePath)),
            ),
            { "rpc.aggregate": "thread-continue" },
          ),
        [WS_METHODS.threadContinueDiscard]: (input) =>
          observeRpcEffect(WS_METHODS.threadContinueDiscard, threadContinueDiscard(input), {
            "rpc.aggregate": "thread-continue",
          }),
        [WS_METHODS.threadContinuePrepare]: (input) =>
          observeRpcEffect(
            WS_METHODS.threadContinuePrepare,
            makeThreadContinueLegacyRefusal(WS_METHODS.threadContinuePrepare)(input),
            { "rpc.aggregate": "thread-continue" },
          ),
        [WS_METHODS.threadContinueReceive]: (input) =>
          observeRpcEffect(
            WS_METHODS.threadContinueReceive,
            makeThreadContinueLegacyRefusal(WS_METHODS.threadContinueReceive)(input),
            { "rpc.aggregate": "thread-continue" },
          ),
        [WS_METHODS.threadContinueCleanup]: (input) =>
          observeRpcEffect(
            WS_METHODS.threadContinueCleanup,
            makeThreadContinueLegacyRefusal(WS_METHODS.threadContinueCleanup)(input),
            { "rpc.aggregate": "thread-continue" },
          ),
        [WS_METHODS.threadContinueComplete]: (input) =>
          observeRpcEffect(WS_METHODS.threadContinueComplete, threadContinueComplete(input), {
            "rpc.aggregate": "thread-continue",
          }),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            vcsProvisioning
              .initRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.callback<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              // Re-probe only what the periodic refresh has clearly missed:
              // probing every harness on each connect cost several seconds
              // of a full processor per page open (see staleProviders.ts).
              yield* (providerRegistry.awaitBootProbes ?? Effect.void).pipe(
                Effect.andThen(providerRegistry.getProviders),
                Effect.flatMap((providers) =>
                  Effect.forEach(
                    staleProviderInstanceIds(providers, Date.now()),
                    (instanceId) => providerRegistry.refreshInstance(instanceId),
                    { concurrency: "unbounded", discard: true },
                  ),
                ),
                Effect.ignoreCause({ log: true }),
                Effect.forkScoped,
              );

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(providerStatuses, settingsUpdates),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                BootstrapCredentialChange | SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.subscribeAuthLinkRequests]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthLinkRequests,
            Effect.gen(function* () {
              // Only the owner (the desktop renderer) may see who is asking
              // to use this computer; a paired client gets an empty, silent
              // stream rather than an error the RPC schema cannot express.
              if (currentSessionRole !== "owner") {
                return Stream.make({
                  type: "snapshot" as const,
                  payload: { pending: [] },
                } satisfies AuthLinkRequestStreamEvent);
              }
              const pending = yield* linkRequests.listPending();
              return Stream.concat(
                Stream.make({
                  type: "snapshot" as const,
                  payload: { pending },
                } satisfies AuthLinkRequestStreamEvent),
                linkRequests.streamChanges,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.providerInstallStart]: (input) =>
          observeRpcEffect(WS_METHODS.providerInstallStart, harnessSetup.installStart(input), {
            "rpc.aggregate": "provider-setup",
          }),
        [WS_METHODS.providerInstallStatus]: (input) =>
          observeRpcEffect(WS_METHODS.providerInstallStatus, harnessSetup.installStatus(input), {
            "rpc.aggregate": "provider-setup",
          }),
        [WS_METHODS.providerAuthStart]: (input) =>
          observeRpcEffect(WS_METHODS.providerAuthStart, harnessSetup.authStart(input), {
            "rpc.aggregate": "provider-setup",
          }),
        [WS_METHODS.providerAuthStatus]: (input) =>
          observeRpcEffect(WS_METHODS.providerAuthStatus, harnessSetup.authStatus(input), {
            "rpc.aggregate": "provider-setup",
          }),
        [WS_METHODS.providerAuthSubmitCode]: (input) =>
          observeRpcEffect(WS_METHODS.providerAuthSubmitCode, harnessSetup.authSubmitCode(input), {
            "rpc.aggregate": "provider-setup",
          }),
        [WS_METHODS.subscribeBrowserBridge]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeBrowserBridge,
            Effect.succeed(browserBridge.stream),
            { "rpc.aggregate": "browser" },
          ),
        [WS_METHODS.subscribePlugins]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribePlugins,
            Effect.gen(function* () {
              const snapshot = yield* pluginRegistry.getSnapshot;
              return Stream.concat(Stream.make(snapshot), pluginRegistry.streamChanges);
            }),
            { "rpc.aggregate": "server" },
          ),
      });
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.succeed(
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
        // Mobile-compat: апстримный клиент передаёт тикет как ?wsTicket=
        // (наши клиенты — ?wsToken=). По этому признаку включаем трансляцию
        // литералов в отдаваемых конфигах.
        const mobileCompat = Option.match(HttpServerRequest.toURL(request), {
          onNone: () => false,
          onSome: (url) => url.searchParams.has("wsTicket"),
        });
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          spanPrefix: "ws.rpc",
          spanAttributes: {
            "rpc.transport": "websocket",
            "rpc.system": "effect-rpc",
          },
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(session.sessionId, session.role, mobileCompat).pipe(
              // Mobile-compat: JSON-сериализация с коерсией числовых request id
              // апстримного клиента (effect rc.115) к нашим строковым (beta.59).
              Layer.provideMerge(layerJsonMobileCompat),
              Layer.provide(
                SourceControlDiscoveryLayer.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AzureDevOpsCli.layer,
                          BitbucketApi.layer,
                          GitHubCli.layer,
                          GitLabCli.layer,
                        ),
                      ),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                  Layer.provide(VcsProcess.layer),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
    ),
  ),
);
