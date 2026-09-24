/**
 * CustomHarnessService — the RPC side of Settings → Harnesses:
 *
 *   list        every custom harness on this machine (Settings + files),
 *               invalid files with reasons, where the guide lives;
 *   test        spawn → initialize → (authenticate) → session/new in a temp
 *               folder → prompt "Reply with OK" → report (Test connection);
 *   setSecret   value of a `secretEnv` name of a file harness → secret store;
 *   install     run a harness's install command as a background job.
 *
 * @module provider/customHarness/CustomHarnessService
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import {
  CUSTOM_HARNESS_DRIVER_KIND,
  type CustomHarnessInstallStatus,
  type CustomHarnessListResult,
  CustomHarnessRpcError,
  CustomHarnessSettings,
  type CustomHarnessSummary,
  type CustomHarnessTestInput,
  type CustomHarnessTestResult,
  type CustomHarnessTestStage,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironment,
  ProviderInstanceId,
  UNO_GATEWAY_BASE_URL,
} from "@t3tools/contracts";
import { formatCommandLine, validateHarnessConfig } from "@t3tools/shared/customHarness";
import { Context, Effect, Layer, Ref, Schema, Scope, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsService } from "../../serverSettings.ts";
import { UnoAgentAccess } from "../../unoAgentAccess.ts";
import { UnoGatewayKey } from "../../unoGatewayKey.ts";
import {
  discoverSessionModels,
  harnessPath,
  makeCustomAcpRuntime,
  makeTextTail,
  resolveHarnessExecutable,
  selectPermissionOptionForDecision,
} from "../acp/CustomAcpSupport.ts";
import { deriveProviderInstanceConfigMap } from "../Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { CustomHarnessFiles } from "./CustomHarnessFiles.ts";
import { resolveHarnessGuidePath } from "./harnessGuide.ts";
import { displayHarnessesDir } from "./harnessFiles.ts";

export const TEST_TIMEOUT_MS = 60_000;
export const TEST_PROMPT = "Reply with OK.";
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const INSTALL_LOG_MAX_CHARS = 20_000;

const decodeSettings = Schema.decodeUnknownEffect(CustomHarnessSettings);

export interface CustomHarnessServiceShape {
  readonly list: Effect.Effect<CustomHarnessListResult, CustomHarnessRpcError>;
  readonly test: (
    input: CustomHarnessTestInput,
  ) => Effect.Effect<CustomHarnessTestResult, CustomHarnessRpcError>;
  readonly setSecret: CustomHarnessFiles["Service"]["setSecret"];
  readonly installStart: (input: {
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<CustomHarnessInstallStatus, CustomHarnessRpcError>;
  readonly installStatus: (input: {
    readonly jobId: string;
  }) => Effect.Effect<CustomHarnessInstallStatus, CustomHarnessRpcError>;
}

export class CustomHarnessService extends Context.Service<
  CustomHarnessService,
  CustomHarnessServiceShape
>()("t3/provider/customHarness/CustomHarnessService") {}

const invalid = (message: string) => new CustomHarnessRpcError({ code: "invalid", message });

/* ------------------------------------------------------------------ *
 * Test connection
 * ------------------------------------------------------------------ */

export interface HarnessTestTarget {
  readonly config: CustomHarnessSettings;
  /** Final environment of the agent process. */
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

function describeCause(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message: unknown }).message);
    if (message) return message;
  }
  return String(error);
}

/**
 * The Test connection routine. Exported for the end-to-end test with the
 * echo harness; needs only a ChildProcessSpawner.
 */
export const runHarnessTest = (target: HarnessTestTarget) =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const stageRef = yield* Ref.make<CustomHarnessTestStage>("validate");
    const stderr = makeTextTail(4_000);
    let reply = "";
    let permissionRequested = false;
    const base = {
      command: target.config.command,
      loadSession: false,
      mcpHttp: false,
      images: false,
      authMethods: [] as string[],
      models: [] as string[],
      modes: [] as string[],
    };
    const failure = (stage: CustomHarnessTestStage, error: string): CustomHarnessTestResult => ({
      ...base,
      ok: false,
      stage,
      error,
      reply: reply.trim(),
      permissionRequested,
      stderr: stderr.get().trim(),
      durationMs: Date.now() - startedAt,
    });

    const valid = validateHarnessConfig(target.config);
    if (!valid.ok) return failure("validate", valid.reason);
    const executable = yield* Effect.promise(() =>
      resolveHarnessExecutable(target.config.command, target.environment),
    );
    if (!executable.ok) return failure("spawn", executable.reason);
    base.command = executable.path;

    const tempDir = yield* Effect.promise(() =>
      mkdtemp(nodePath.join(os.tmpdir(), "uno-harness-test-")),
    );
    // Always a throw-away folder, whatever the harness's working directory.
    const cwd = tempDir;

    const attempt = Effect.gen(function* () {
      yield* Ref.set(stageRef, "spawn");
      const acp = yield* makeCustomAcpRuntime({
        childProcessSpawner: spawner,
        command: executable.path,
        args: target.config.args,
        environment: { ...target.environment, UNO_WORK: "1", UNO_WORK_HARNESS_TEST: "1" },
        cwd,
        ...(target.config.authMethodId.trim()
          ? { authMethodId: target.config.authMethodId.trim() }
          : {}),
        onStderr: stderr.append,
        clientInfo: { name: "uno-work", version: "harness-test" },
        requestLogger: (event) =>
          event.status === "started"
            ? Ref.set(
                stageRef,
                event.method === "initialize"
                  ? "initialize"
                  : event.method === "authenticate"
                    ? "authenticate"
                    : event.method === "session/prompt"
                      ? "prompt"
                      : "session",
              )
            : Effect.void,
      });
      yield* acp.handleRequestPermission((params) =>
        Effect.sync(() => {
          permissionRequested = true;
          const optionId = selectPermissionOptionForDecision(params, "decline");
          return {
            outcome:
              optionId === undefined
                ? ({ outcome: "cancelled" } as const)
                : ({ outcome: "selected", optionId } as const),
          };
        }),
      );
      yield* acp.getEvents().pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event._tag === "ContentDelta") reply += event.text;
          }),
        ),
        Effect.forkScoped,
      );
      const started = yield* acp.start();
      const init = started.initializeResult;
      base.loadSession = init.agentCapabilities?.loadSession === true;
      base.mcpHttp = init.agentCapabilities?.mcpCapabilities?.http === true;
      base.images = init.agentCapabilities?.promptCapabilities?.image === true;
      base.authMethods = (init.authMethods ?? []).map((method) => method.id);
      base.models = discoverSessionModels(started.sessionSetupResult).models.map(
        (model) => model.id,
      );
      base.modes = (started.sessionSetupResult.modes?.availableModes ?? []).map((mode) => mode.id);
      const agent = {
        ...(init.agentInfo?.name ? { agentName: init.agentInfo.name } : {}),
        ...(init.agentInfo?.version ? { agentVersion: init.agentInfo.version } : {}),
        protocolVersion: init.protocolVersion,
      };
      yield* Ref.set(stageRef, "prompt");
      const response = yield* acp.prompt({ prompt: [{ type: "text", text: TEST_PROMPT }] });
      // Chunks arrive before the prompt response; give the event fiber a tick.
      yield* Effect.sleep("50 millis");
      const text = reply.trim();
      const ok = text.length > 0 && response.stopReason !== "refusal";
      return {
        ...base,
        ...agent,
        ok,
        stage: ok ? "done" : "prompt",
        ...(ok
          ? {}
          : {
              error:
                text.length === 0
                  ? `The agent finished (${response.stopReason}) without sending any agent_message_chunk text.`
                  : `The agent refused (${response.stopReason}).`,
            }),
        reply: text,
        stopReason: response.stopReason,
        permissionRequested,
        stderr: stderr.get().trim(),
        durationMs: Date.now() - startedAt,
      } satisfies CustomHarnessTestResult;
    }).pipe(Effect.scoped);

    const timeoutMs = target.timeoutMs ?? TEST_TIMEOUT_MS;
    const result = yield* attempt.pipe(
      Effect.timeoutOption(timeoutMs),
      Effect.flatMap((outcome) =>
        outcome._tag === "Some"
          ? Effect.succeed(outcome.value)
          : Ref.get(stageRef).pipe(
              Effect.map((stage) =>
                failure(stage, `No answer within ${timeoutMs / 1000} s (stuck at ${stage}).`),
              ),
            ),
      ),
      Effect.catch((error) =>
        Ref.get(stageRef).pipe(Effect.map((stage) => failure(stage, describeCause(error)))),
      ),
      Effect.ensuring(
        Effect.promise(() => rm(tempDir, { recursive: true, force: true }).catch(() => undefined)),
      ),
    );
    return result;
  });

/* ------------------------------------------------------------------ *
 * Live
 * ------------------------------------------------------------------ */

interface InstallJob {
  status: CustomHarnessInstallStatus;
}

export const CustomHarnessServiceLive = Layer.effect(
  CustomHarnessService,
  Effect.gen(function* () {
    const files = yield* CustomHarnessFiles;
    const serverSettings = yield* ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry;
    const gatewayKey = yield* UnoGatewayKey;
    const agentAccess = yield* UnoAgentAccess;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.Scope;
    const installJobs = new Map<string, InstallJob>();
    const runningInstalls = new Set<ReturnType<typeof spawn>>();
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        for (const child of runningInstalls) child.kill("SIGTERM");
      }),
    );

    const settingsOrFail = serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new CustomHarnessRpcError({ code: "failed", message: `Settings: ${cause.message}` }),
      ),
    );

    /** Every `acp` envelope on this machine, files merged under Settings. */
    const allEnvelopes = Effect.gen(function* () {
      const settings = yield* settingsOrFail;
      const state = yield* files.current;
      const map = deriveProviderInstanceConfigMap(settings, state.configs);
      return { settings, state, map };
    });

    const envelopeOf = (instanceId: string) =>
      Effect.gen(function* () {
        const { map } = yield* allEnvelopes;
        const entry = map[instanceId as ProviderInstanceId];
        if (!entry || entry.driver !== CUSTOM_HARNESS_DRIVER_KIND) {
          return yield* new CustomHarnessRpcError({
            code: "notFound",
            message: `No custom harness "${instanceId}".`,
          });
        }
        return entry;
      });

    const processEnvironment = (
      config: CustomHarnessSettings,
      environment: ProviderInstanceEnvironment | undefined,
    ) =>
      Effect.gen(function* () {
        const base = mergeProviderInstanceEnvironment(environment);
        const account = config.shareUnoAccount ? yield* agentAccess.environment() : {};
        const key = config.shareUnoGateway ? yield* gatewayKey.harnessKey() : "";
        return {
          ...base,
          PATH: harnessPath(base),
          ...account,
          ...(key ? { UNO_GATEWAY_API_KEY: key, UNO_GATEWAY_BASE_URL } : {}),
          UNO_WORK_HARNESS_GUIDE: resolveHarnessGuidePath(),
        } satisfies NodeJS.ProcessEnv;
      });

    const list: CustomHarnessServiceShape["list"] = Effect.gen(function* () {
      const { settings, state } = yield* allEnvelopes;
      const harnesses: CustomHarnessSummary[] = [];
      for (const [instanceId, entry] of Object.entries(settings.providerInstances)) {
        if (entry.driver !== CUSTOM_HARNESS_DRIVER_KIND) continue;
        const config = yield* decodeSettings(entry.config ?? {}).pipe(
          Effect.orElseSucceed(() => Schema.decodeSync(CustomHarnessSettings)({})),
        );
        harnesses.push({
          instanceId: ProviderInstanceId.make(instanceId),
          source: "settings",
          name: entry.displayName ?? instanceId,
          config: { ...config, enabled: entry.enabled ?? config.enabled },
          secrets: (entry.environment ?? [])
            .filter((variable) => variable.sensitive)
            .map((variable) => ({ name: variable.name, isSet: variable.value.length > 0 })),
          environment: [],
        });
      }
      for (const harness of state.scan.harnesses) {
        if (harness.instanceId in settings.providerInstances) continue;
        const setNames = state.secretsSet.get(harness.instanceId) ?? new Set<string>();
        harnesses.push({
          instanceId: harness.instanceId,
          source: "file",
          filePath: harness.filePath,
          name: harness.name,
          config: {
            ...harness.config,
            args: [...harness.config.args],
            installCommand: [...harness.config.installCommand],
            detectCommand: [...harness.config.detectCommand],
            models: harness.config.models.map((model) => ({ ...model })),
          },
          secrets: harness.secretEnv.map((name) => ({ name, isSet: setNames.has(name) })),
          environment: harness.env.map(({ name, value }) => ({ name, value })),
        });
      }
      return {
        directory: displayHarnessesDir(files.dir),
        guidePath: resolveHarnessGuidePath(),
        harnesses,
        invalid: state.scan.invalid.map(({ file, reason }) => ({ file, reason })),
      } satisfies CustomHarnessListResult;
    });

    const test: CustomHarnessServiceShape["test"] = (input) =>
      Effect.gen(function* () {
        let stored: ProviderInstanceConfig | undefined;
        if (input.instanceId) stored = yield* envelopeOf(input.instanceId);
        const rawConfig = input.config ?? stored?.config;
        if (rawConfig === undefined) {
          return yield* invalid("Pass an instanceId or a config to test.");
        }
        const config = yield* decodeSettings(rawConfig).pipe(
          Effect.mapError((cause) => invalid(`Invalid harness config: ${cause.message}`)),
        );
        // A draft edited in the dialog carries secrets it did not change as
        // redacted blanks: take those values from the stored harness.
        const environment = input.environment
          ? input.environment.map((variable) => {
              if (!variable.sensitive || variable.value.length > 0) return variable;
              const saved = stored?.environment?.find((entry) => entry.name === variable.name);
              return saved ? { ...variable, value: saved.value } : variable;
            })
          : stored?.environment;
        const env = yield* processEnvironment(config, environment);
        return yield* runHarnessTest({ config, environment: env }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
      });

    const installStatus: CustomHarnessServiceShape["installStatus"] = (input) => {
      const job = installJobs.get(input.jobId);
      return job
        ? Effect.succeed({ ...job.status })
        : Effect.fail(
            new CustomHarnessRpcError({ code: "notFound", message: "Unknown install job." }),
          );
    };

    const installStart: CustomHarnessServiceShape["installStart"] = (input) =>
      Effect.gen(function* () {
        for (const job of installJobs.values()) {
          if (job.status.instanceId === input.instanceId && job.status.state === "running") {
            return yield* new CustomHarnessRpcError({
              code: "conflict",
              message: "An install for this harness is already running.",
            });
          }
        }
        const entry = yield* envelopeOf(input.instanceId);
        const config = yield* decodeSettings(entry.config ?? {}).pipe(
          Effect.mapError((cause) => invalid(cause.message)),
        );
        if (config.installCommand.length === 0) {
          return yield* invalid("This harness has no install command.");
        }
        const valid = validateHarnessConfig(config);
        if (!valid.ok) return yield* invalid(valid.reason);
        const env = yield* processEnvironment(config, entry.environment);
        const executable = yield* Effect.promise(() =>
          resolveHarnessExecutable(config.installCommand[0]!, env),
        );
        const jobId = crypto.randomUUID();
        const display = formatCommandLine(config.installCommand);
        const job: InstallJob = {
          status: {
            jobId,
            instanceId: input.instanceId,
            state: "running",
            command: display,
            log: `$ ${display}\n`,
          },
        };
        installJobs.set(jobId, job);
        if (!executable.ok) {
          job.status = { ...job.status, state: "failed", error: executable.reason };
          return { ...job.status };
        }
        const append = (chunk: string) => {
          job.status = {
            ...job.status,
            log: (job.status.log + chunk).slice(-INSTALL_LOG_MAX_CHARS),
          };
        };
        const child = spawn(executable.path, config.installCommand.slice(1), {
          env,
          cwd: os.homedir(),
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        });
        runningInstalls.add(child);
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        const timer = setTimeout(() => child.kill("SIGTERM"), INSTALL_TIMEOUT_MS);
        timer.unref();
        const finish = (state: "succeeded" | "failed", error?: string) => {
          clearTimeout(timer);
          runningInstalls.delete(child);
          if (job.status.state !== "running") return;
          job.status = { ...job.status, state, ...(error ? { error } : {}) };
          if (state === "succeeded") {
            Effect.runFork(providerRegistry.refreshInstance(input.instanceId).pipe(Effect.ignore));
          }
        };
        child.on("error", (error) => finish("failed", error.message));
        child.on("close", (code, signal) =>
          code === 0
            ? finish("succeeded")
            : finish("failed", signal ? `Stopped by ${signal}.` : `Exited with code ${code}.`),
        );
        return { ...job.status };
      });

    return {
      list,
      test,
      setSecret: files.setSecret,
      installStart,
      installStatus,
    } satisfies CustomHarnessServiceShape;
  }),
);
