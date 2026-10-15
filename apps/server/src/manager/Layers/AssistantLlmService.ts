/**
 * ManagerAssistantLlm — the Uno assistant's engine panel (0.0.84).
 *
 * @module manager/Layers/AssistantLlmService
 */
import {
  ASSISTANT_DEFAULT_GATEWAY_MODEL,
  ASSISTANT_HARNESS_INSTANCE_ID,
  ASSISTANT_PROJECT_ID,
  AI_PROVIDER_LABELS,
  type AssistantLlmModelList,
  type AssistantSignInStatus,
  CommandId,
  isAssistantProjectId,
  isSubscriptionLlmProvider,
  type SubscriptionLlmProvider,
  ProviderDriverKind,
  type ProviderInstallJobStatus,
  type ProviderSetupJobId,
} from "@t3tools/contracts";
import { findMarkedAssistantChat, listAssistantConversations } from "@t3tools/shared/assistantChat";
import {
  assistantModelSelection,
  coerceAssistantModelSelection,
  DEFAULT_ASSISTANT_MODEL_SELECTION,
  defaultAssistantModelFor,
  readAssistantLlmProvider,
  sameAssistantModelSelection,
  SUBSCRIPTION_DEFAULT_MODEL,
  SUBSCRIPTION_MODELS,
} from "@t3tools/shared/assistantLlm";
import { Effect, Layer, Ref } from "effect";
import * as crypto from "node:crypto";
import * as os from "node:os";

import { AiProviderKeys } from "../../aiProviders/AiProviderKeys.ts";
import { ServerConfig } from "../../config.ts";
import { HERMES_CLAUDE_PLUGIN_CATALOG_NAME } from "../../provider/acp/HermesAcpSupport.ts";
import { assistantCommandOrigin } from "../../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { fetchHermesModelCatalog } from "../../provider/Layers/HermesProvider.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { HarnessSetup } from "../../provider/setup/HarnessSetupService.ts";
import {
  HERMES_CLAUDE_READY_ENV,
  HERMES_CLAUDE_READY_VERSION,
  HERMES_UV_TOOL_ARGS_CLAUDE_READY,
} from "../../provider/setup/harnessInstallCommands.ts";
import {
  type HarnessProcessHandle,
  spawnHarnessProcess,
  withUserLocalBinOnPath,
} from "../../provider/setup/harnessProcess.ts";
import {
  type HermesMcpProbeResult,
  probeHermesMcpHttp,
} from "../../provider/setup/hermesMcpProbe.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { UnoGatewayKey } from "../../unoGatewayKey.ts";
import {
  deriveAssistantHarnessStatus,
  HERMES_MCP_BROKEN_MESSAGE,
  orderAssistantModels,
} from "../assistantLlm.ts";
import {
  claudePluginInstalled,
  claudeSignInFromProviders,
  hermesCommandEnvironment,
  hermesSharedHome,
  hermesVersionAtLeast,
  parseDeviceSignIn,
  readChatgptSignIn,
  stripAnsi,
  subscriptionStatuses,
} from "../assistantSubscriptions.ts";
import {
  ManagerAssistantLlm,
  type ManagerAssistantLlmShape,
} from "../Services/AssistantLlmService.ts";
import { ManagerAssistantError } from "../Services/AssistantService.ts";

const HERMES_DRIVER = ProviderDriverKind.make("hermes");
/** A device code is good for ~15 minutes; the sign-in stops waiting then. */
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
const PLUGIN_INSTALL_TIMEOUT_MS = 4 * 60_000;
/** Building Hermes from its tag: ~25 s on a fast box, minutes on a small one. */
const HERMES_UPDATE_TIMEOUT_MS = 15 * 60_000;

interface SignInJob {
  status: AssistantSignInStatus;
  output: string;
  handle: HarnessProcessHandle | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function idleSignIn(provider: SubscriptionLlmProvider): AssistantSignInStatus {
  return { provider, state: "idle", url: null, code: null, message: null };
}

function lastLines(text: string, count = 4): string {
  return stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-count)
    .join("\n");
}

const makeManagerAssistantLlm = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const providerRegistry = yield* ProviderRegistry;
  const harnessSetup = yield* HarnessSetup;
  const providerKeys = yield* AiProviderKeys;
  const gatewayKey = yield* UnoGatewayKey;
  const serverSettings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const installJobId = yield* Ref.make<ProviderSetupJobId | null>(null);
  const sharedHome = hermesSharedHome(serverConfig.stateDir, ASSISTANT_HARNESS_INSTANCE_ID);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const toError = (detail: string) => (cause: unknown) =>
    new ManagerAssistantError({ detail, cause });

  const currentJob = Effect.gen(function* () {
    const jobId = yield* Ref.get(installJobId);
    if (jobId === null) return null;
    return yield* harnessSetup
      .installStatus({ jobId })
      .pipe(Effect.orElseSucceed((): ProviderInstallJobStatus | null => null));
  });

  // MCP probe of the installed Hermes (hermesMcpProbe.ts), once per install:
  // keyed by the snapshot's version + the last finished install job.
  const mcpProbe = yield* Ref.make<{
    readonly key: string;
    readonly result: HermesMcpProbeResult;
  } | null>(null);
  const autoRepairStarted = yield* Ref.make(false);

  const probeMcp = (key: string) =>
    Effect.gen(function* () {
      const cached = yield* Ref.get(mcpProbe);
      if (cached !== null && cached.key === key) return cached.result;
      const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
      const binaryPath = settings?.providers.hermes.binaryPath || "hermes";
      const result = yield* Effect.promise(() =>
        probeHermesMcpHttp({
          binaryPath,
          env: withUserLocalBinOnPath(process.env, os.homedir()),
        }),
      );
      yield* Ref.set(mcpProbe, { key, result });
      if (result === "broken") {
        yield* Effect.logWarning("assistant: Hermes has no HTTP MCP client (mcp 2.x)");
      }
      return result;
    });

  const harnessStatus = Effect.gen(function* () {
    const providers = yield* providerRegistry.getProviders;
    const snapshot = providers.find(
      (provider) => provider.instanceId === ASSISTANT_HARNESS_INSTANCE_ID,
    );
    const job = yield* currentJob;
    const base = deriveAssistantHarnessStatus({ snapshot, job });
    if (base.state !== "ready") return base;
    const mcp = yield* probeMcp(
      `${snapshot?.version ?? ""}|${job?.state === "succeeded" ? job.jobId : ""}`,
    );
    return deriveAssistantHarnessStatus({ snapshot, job, mcp });
  });

  const subscriptions = (hermesVersion: string | null) =>
    Effect.gen(function* () {
      const providers = yield* providerRegistry.getProviders;
      const chatgpt = yield* Effect.promise(() => readChatgptSignIn(sharedHome));
      return subscriptionStatuses({
        hermesVersion,
        claude: claudeSignInFromProviders(providers),
        chatgpt,
      });
    });

  const hermesBinary = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    return settings?.providers.hermes.binaryPath || "hermes";
  });

  const hermesEnv = () =>
    hermesCommandEnvironment({
      env: withUserLocalBinOnPath(process.env, os.homedir()),
      sharedHome,
    });

  /**
   * The Claude plugin in the shared Hermes home (catalog-pinned by Hermes):
   * `hermes plugins install claude-subscription-directsdk`. A model-provider
   * plugin needs no enabling — Hermes imports it from `plugins/`.
   */
  const ensureClaudePlugin = Effect.gen(function* () {
    if (yield* Effect.promise(() => claudePluginInstalled(sharedHome))) return;
    const binary = yield* hermesBinary;
    // `--yes-deps` (answer the dependency question without a terminal) came
    // with Hermes 0.22; 0.21 doesn't know it and installs without asking.
    const hermesVersion = (yield* harnessStatus).version;
    const consentFlag = hermesVersionAtLeast(hermesVersion, "0.22.0") ? ["--yes-deps"] : [];
    const result = yield* Effect.promise(
      () =>
        new Promise<{ readonly ok: boolean; readonly output: string }>((resolve) => {
          let output = "";
          let handle: HarnessProcessHandle | null = null;
          const timer = setTimeout(() => handle?.kill(), PLUGIN_INSTALL_TIMEOUT_MS);
          handle = spawnHarnessProcess({
            command: binary,
            args: [
              "plugins",
              "install",
              HERMES_CLAUDE_PLUGIN_CATALOG_NAME,
              ...consentFlag,
              "--no-enable",
            ],
            env: hermesEnv(),
            cwd: os.homedir(),
            onOutput: (chunk) => {
              output += chunk;
            },
            onExit: (exit) => {
              clearTimeout(timer);
              resolve({ ok: exit.code === 0 && exit.error === undefined, output });
            },
          });
          handle.endInput();
        }),
    );
    const installed = yield* Effect.promise(() => claudePluginInstalled(sharedHome));
    if (!installed) {
      yield* Effect.logWarning("assistant: Claude plugin install failed").pipe(
        Effect.annotateLogs({ ok: result.ok, tail: lastLines(result.output, 6) }),
      );
      return yield* new ManagerAssistantError({
        detail: `Couldn't connect Uno to your Claude plan on this computer.${
          result.output ? ` Hermes said: ${lastLines(result.output, 2)}` : ""
        }`,
      });
    }
    yield* Effect.logInfo("assistant: Claude plugin installed");
  });

  let hermesUpdate: {
    state: "running" | "succeeded" | "failed";
    message: string | null;
  } | null = null;

  const hermesUpdateStart: ManagerAssistantLlmShape["hermesUpdateStart"] = () =>
    Effect.gen(function* () {
      if (hermesUpdate?.state !== "running") {
        hermesUpdate = { state: "running", message: null };
        let output = "";
        let handle: HarnessProcessHandle | null = null;
        const timer = setTimeout(() => handle?.kill(), HERMES_UPDATE_TIMEOUT_MS);
        handle = spawnHarnessProcess({
          command: "uv",
          args: HERMES_UV_TOOL_ARGS_CLAUDE_READY,
          env: {
            ...withUserLocalBinOnPath(process.env, os.homedir()),
            ...HERMES_CLAUDE_READY_ENV,
          },
          cwd: os.homedir(),
          onOutput: (chunk) => {
            output += chunk;
          },
          onExit: (exit) => {
            clearTimeout(timer);
            const ok = exit.code === 0 && exit.error === undefined;
            hermesUpdate = ok
              ? { state: "succeeded", message: null }
              : {
                  state: "failed",
                  message: exit.error
                    ? `uv didn't start: ${exit.error.message}`
                    : /git/i.test(output) && /not found|No such file/i.test(output)
                      ? "Updating Hermes needs git on this computer."
                      : lastLines(output, 3) || "Updating Hermes failed.",
                };
            // The probe that sees the new version; the assistant's next
            // session starts on it.
            void runPromise(providerRegistry.refresh(HERMES_DRIVER).pipe(Effect.ignore));
          },
        });
        handle.endInput();
        yield* Effect.logInfo("assistant: updating Hermes for the Claude plan").pipe(
          Effect.annotateLogs({ version: HERMES_CLAUDE_READY_VERSION }),
        );
      }
      return yield* status();
    });

  const signInJobs = new Map<SubscriptionLlmProvider, SignInJob>();

  const signInStart: ManagerAssistantLlmShape["signInStart"] = (provider) =>
    Effect.gen(function* () {
      if (provider === "claude") {
        return yield* new ManagerAssistantError({
          detail:
            "Uno uses Claude Code's sign-in on this computer: sign in to Claude under Settings → AI → Agents.",
        });
      }
      const running = signInJobs.get(provider);
      if (running?.status.state === "waiting") return running.status;
      const binary = yield* hermesBinary;
      const job: SignInJob = {
        status: { provider, state: "waiting", url: null, code: null, message: null },
        output: "",
        handle: null,
        timer: null,
      };
      signInJobs.set(provider, job);
      const finish = (next: Omit<AssistantSignInStatus, "provider" | "url" | "code">) => {
        if (job.status.state !== "waiting") return;
        if (job.timer !== null) clearTimeout(job.timer);
        job.status = { ...job.status, ...next };
      };
      job.handle = spawnHarnessProcess({
        command: binary,
        args: ["auth", "add", "openai-codex"],
        env: hermesEnv(),
        cwd: os.homedir(),
        onOutput: (chunk) => {
          job.output += chunk;
          const parsed = parseDeviceSignIn(job.output);
          job.status = {
            ...job.status,
            url: parsed.url ?? job.status.url,
            code: parsed.code ?? job.status.code,
          };
        },
        onExit: (exit) => {
          void readChatgptSignIn(sharedHome).then((signIn) => {
            if (exit.code === 0 && signIn.signedIn) {
              finish({ state: "succeeded", message: null });
            } else {
              finish({
                state: "failed",
                message: exit.error
                  ? `Hermes didn't start: ${exit.error.message}`
                  : lastLines(job.output, 3) || "The ChatGPT sign-in didn't finish.",
              });
            }
          });
        },
      });
      job.handle.endInput();
      job.timer = setTimeout(() => {
        job.handle?.kill();
        finish({ state: "failed", message: "The code expired. Start the sign-in again." });
      }, SIGN_IN_TIMEOUT_MS);
      yield* Effect.logInfo("assistant: ChatGPT sign-in started");
      // The page and code come within a second or two; hand them back in
      // this answer when they are already there.
      for (let attempt = 0; attempt < 20 && job.status.code === null; attempt += 1) {
        if (job.status.state !== "waiting") break;
        yield* Effect.sleep("250 millis");
      }
      return job.status;
    });

  const signInStatus: ManagerAssistantLlmShape["signInStatus"] = (provider) =>
    Effect.sync(() => signInJobs.get(provider)?.status ?? idleSignIn(provider));

  const signInCancel: ManagerAssistantLlmShape["signInCancel"] = (provider) =>
    Effect.sync(() => {
      const job = signInJobs.get(provider);
      if (job === undefined) return idleSignIn(provider);
      if (job.status.state === "waiting") {
        job.handle?.kill();
        if (job.timer !== null) clearTimeout(job.timer);
        job.status = { ...job.status, state: "idle", message: null };
      }
      return job.status;
    });

  const findChat = Effect.gen(function* () {
    const snapshot = yield* snapshotQuery
      .getShellSnapshot()
      .pipe(Effect.mapError(toError("Failed to load chats.")));
    return findMarkedAssistantChat(snapshot.threads);
  });

  const status: ManagerAssistantLlmShape["status"] = () =>
    Effect.gen(function* () {
      const chat = yield* findChat;
      const selection = chat
        ? coerceAssistantModelSelection(chat.modelSelection)
        : DEFAULT_ASSISTANT_MODEL_SELECTION;
      const keys = yield* providerKeys.list();
      const gatewayState = yield* gatewayKey.keyState();
      const harness = yield* harnessStatus;
      return {
        threadId: chat?.id ?? null,
        provider: readAssistantLlmProvider(selection),
        model: selection.model,
        harness,
        keys,
        gatewayConfigured: gatewayState === "ready",
        ...(gatewayState === "pending" ? { gatewayPending: true } : {}),
        subscriptions: yield* subscriptions(harness.version),
        ...(hermesUpdate !== null ? { hermesUpdate } : {}),
      };
    });

  const setLlm: ManagerAssistantLlmShape["setLlm"] = (input) =>
    Effect.gen(function* () {
      if (isSubscriptionLlmProvider(input.provider)) {
        const harness = yield* harnessStatus;
        const subscription = (yield* subscriptions(harness.version)).find(
          (entry) => entry.provider === input.provider,
        );
        if (subscription === undefined || subscription.state !== "ready") {
          return yield* new ManagerAssistantError({
            detail:
              subscription?.message ??
              `Your ${AI_PROVIDER_LABELS[input.provider]} plan isn't ready for Uno on this computer.`,
          });
        }
        if (input.provider === "claude") yield* ensureClaudePlugin;
      } else if (input.provider !== "uno") {
        const stored = yield* providerKeys.resolve(input.provider);
        if (stored === null) {
          return yield* new ManagerAssistantError({
            detail: `No ${AI_PROVIDER_LABELS[input.provider]} key on this computer — add it in Settings → Agents first.`,
          });
        }
      }
      const chat = yield* findChat;
      if (chat === null) {
        return yield* new ManagerAssistantError({
          detail: "The Uno chat is not set up on this computer yet.",
        });
      }
      const next = assistantModelSelection({ provider: input.provider, model: input.model });
      yield* engine
        .dispatch(
          {
            type: "thread.meta.update",
            commandId: CommandId.make(`assistant-llm:${crypto.randomUUID()}`),
            threadId: chat.id,
            modelSelection: next,
          },
          { origin: assistantCommandOrigin({ assistantKey: ASSISTANT_PROJECT_ID }) },
        )
        .pipe(Effect.mapError(toError("Failed to switch the assistant's model.")));
      // One engine for all of the assistant's conversations (0.0.85) — and,
      // since 14.10, every assistant's on this computer: "what powers your
      // assistant" is one choice per computer (new assistants already start
      // on the Uno chat's engine).
      const snapshot = yield* snapshotQuery
        .getShellSnapshot()
        .pipe(Effect.mapError(toError("Failed to load chats.")));
      const otherAssistants = snapshot.threads.filter(
        (thread) =>
          isAssistantProjectId(thread.projectId) &&
          thread.projectId !== ASSISTANT_PROJECT_ID &&
          thread.archivedAt === null &&
          thread.assistantRole !== "spawned" &&
          (thread.spawnedByThreadId ?? null) === null &&
          thread.modelSelection.instanceId === ASSISTANT_HARNESS_INSTANCE_ID,
      );
      yield* Effect.forEach(
        [...listAssistantConversations(snapshot.threads), ...otherAssistants].filter(
          (thread) =>
            thread.id !== chat.id && !sameAssistantModelSelection(thread.modelSelection, next),
        ),
        (thread) =>
          engine
            .dispatch(
              {
                type: "thread.meta.update",
                commandId: CommandId.make(`assistant-llm:${crypto.randomUUID()}`),
                threadId: thread.id,
                modelSelection: next,
              },
              { origin: assistantCommandOrigin({ assistantKey: ASSISTANT_PROJECT_ID }) },
            )
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("assistant llm switch: conversation not updated").pipe(
                  Effect.annotateLogs({ threadId: thread.id, cause }),
                ),
              ),
            ),
        { discard: true },
      );
      yield* Effect.logInfo("assistant llm switched").pipe(
        Effect.annotateLogs({ threadId: chat.id, provider: input.provider, model: input.model }),
      );
      return yield* status();
    });

  const listModels: ManagerAssistantLlmShape["listModels"] = (provider) =>
    Effect.gen(function* () {
      if (provider === "uno") {
        const key = yield* gatewayKey.harnessKey();
        if (key.length === 0) {
          return {
            provider,
            models: orderAssistantModels([], { ensureGatewayAlias: true }),
            defaultModel: ASSISTANT_DEFAULT_GATEWAY_MODEL,
            error: "This computer has no Uno AI key yet.",
          } satisfies AssistantLlmModelList;
        }
        const catalog = yield* Effect.tryPromise(() => fetchHermesModelCatalog(key)).pipe(
          Effect.orElseSucceed(() => []),
        );
        const models = catalog
          .filter(
            (model) =>
              model.supportsTools !== false &&
              (model.outputModalities === undefined || model.outputModalities.includes("text")),
          )
          .map((model) => ({ id: model.modelId, name: model.name }));
        return {
          provider,
          models: orderAssistantModels(models, { ensureGatewayAlias: true }),
          defaultModel: ASSISTANT_DEFAULT_GATEWAY_MODEL,
          error: catalog.length === 0 ? "Could not load the Uno gateway's model list." : null,
        } satisfies AssistantLlmModelList;
      }
      if (isSubscriptionLlmProvider(provider)) {
        return {
          provider,
          models: SUBSCRIPTION_MODELS[provider],
          defaultModel: SUBSCRIPTION_DEFAULT_MODEL[provider],
          error: null,
        } satisfies AssistantLlmModelList;
      }
      const result = yield* providerKeys.listModels(provider);
      if (!result.ok) {
        return { provider, models: [], defaultModel: null, error: result.error };
      }
      const models = orderAssistantModels(result.models);
      return {
        provider,
        models,
        defaultModel: defaultAssistantModelFor(
          provider,
          models.map((model) => model.id),
        ),
        error: null,
      } satisfies AssistantLlmModelList;
    });

  const ensureHarness: ManagerAssistantLlmShape["ensureHarness"] = (input) =>
    Effect.gen(function* () {
      const current = yield* harnessStatus;
      // A Hermes that can't reach MCP servers is repaired once per daemon run
      // without asking — the assistant is useless without its tools.
      const mcpBroken = current.state === "failed" && current.message === HERMES_MCP_BROKEN_MESSAGE;
      const autoRepair = mcpBroken && !(yield* Ref.getAndSet(autoRepairStarted, true));
      const shouldInstall =
        current.state === "missing" ||
        autoRepair ||
        (input.retry && (current.state === "failed" || current.state === "unsupported"));
      if (!shouldInstall) return current;
      const started = yield* harnessSetup.installStart({ driver: HERMES_DRIVER }).pipe(
        Effect.map((result) => result.jobId),
        Effect.catch((error) =>
          Effect.logWarning("assistant: Hermes install did not start").pipe(
            Effect.annotateLogs({ code: error.code, message: error.message }),
            Effect.as(null),
          ),
        ),
      );
      if (started !== null) {
        yield* Ref.set(installJobId, started);
        yield* Effect.logInfo("assistant: installing Hermes on first use").pipe(
          Effect.annotateLogs({ jobId: started }),
        );
      }
      return yield* harnessStatus;
    });

  return {
    status,
    setLlm,
    listModels,
    ensureHarness,
    signInStart,
    signInStatus,
    signInCancel,
    hermesUpdateStart,
  } satisfies ManagerAssistantLlmShape;
});

export const ManagerAssistantLlmLive = Layer.effect(ManagerAssistantLlm, makeManagerAssistantLlm);
