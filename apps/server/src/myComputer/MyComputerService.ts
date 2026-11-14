/**
 * MyComputerService: "Connect my computer" in the daemon. The core
 * (`myComputerCore.ts`) wired to this computer's machine token and state
 * folder; interrupting an operation aborts it (a running command gets `kill`).
 *
 * Without `settings.uno.boxToken` (a desktop app on a laptop) the feature is
 * off: `status` answers `enabled: false`, nothing is logged.
 *
 * @module myComputer/MyComputerService
 */
import {
  MyComputerError,
  type MyComputerActivity,
  type MyComputerPairing,
  type MyComputerPairStatus,
  type MyComputerStatus,
  type MyComputerStopAllResult,
  type MyComputerTrustSettings,
  type MyComputerTrustState,
} from "@t3tools/contracts";
import { Context, Effect, Layer } from "effect";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { parseSettingsBoxId } from "../unoBoxIdentity.ts";
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";
import {
  createMyComputerCore,
  type ExecInput,
  type ExecResult,
  type HelperAnswer,
  type ListInput,
  type MyComputerCore,
  type ReadInput,
  type ReadResult,
  type WriteInput,
} from "./myComputerCore.ts";
import { makeTrustJudge, type TrustJudge } from "./trust/judge.ts";
import { makeTrustStore, type TrustStore } from "./trust/trustStore.ts";

/** The resolver's call (`trust/resolver.ts`): quiet, short, its whole answer. */
const RESOLVER_TIMEOUT_MS = 15_000;
const RESOLVER_OUTPUT_BYTES = 1024 * 1024;

export interface MyComputerShape {
  /** The plain core, for code that needs to tell its failures apart (chat import). */
  readonly core: MyComputerCore;
  readonly status: Effect.Effect<MyComputerStatus, MyComputerError>;
  readonly pair: Effect.Effect<MyComputerPairing, MyComputerError>;
  readonly pairStatus: (code: string) => Effect.Effect<MyComputerPairStatus, MyComputerError>;
  readonly disconnect: (computerId: string) => Effect.Effect<void, MyComputerError>;
  readonly activity: (
    computerId: string,
    limit?: number,
  ) => Effect.Effect<MyComputerActivity, MyComputerError>;
  /** For `tools/list`: bounded and cached, never fails. */
  readonly toolsVisible: Effect.Effect<boolean>;
  readonly exec: (input: ExecInput) => Effect.Effect<ExecResult, MyComputerError>;
  readonly read: (input: ReadInput) => Effect.Effect<ReadResult, MyComputerError>;
  readonly write: (input: WriteInput) => Effect.Effect<{ readonly bytes: number }, MyComputerError>;
  readonly list: (input: ListInput) => Effect.Effect<HelperAnswer, MyComputerError>;
  readonly stat: (input: {
    readonly computerId: string;
    readonly path: string;
  }) => Effect.Effect<HelperAnswer, MyComputerError>;
  readonly info: (computerId: string) => Effect.Effect<HelperAnswer, MyComputerError>;
  /** Trust tiers (`trust/`): what agents may do there without asking. */
  readonly trust: TrustStore;
  readonly judge: TrustJudge;
  readonly trustState: Effect.Effect<MyComputerTrustState, MyComputerError>;
  readonly setTrust: (
    settings: MyComputerTrustSettings,
  ) => Effect.Effect<MyComputerTrustState, MyComputerError>;
  readonly revokeGrant: (input: {
    readonly threadId: string;
    readonly computerId: string;
  }) => Effect.Effect<MyComputerTrustState, MyComputerError>;
  /**
   * "Stop all agents on my computers": agents paused (nothing runs until
   * Resume), every running call stopped, every computer disconnected. The
   * caller forgets what disconnected computers were for (`removed`).
   */
  readonly stopAll: Effect.Effect<
    MyComputerStopAllResult & { readonly removed: ReadonlyArray<string> },
    MyComputerError
  >;
  readonly resume: Effect.Effect<MyComputerTrustState, MyComputerError>;
}

export class MyComputerService extends Context.Service<MyComputerService, MyComputerShape>()(
  "t3/myComputer/MyComputerService",
) {}

const toError = (cause: unknown) =>
  new MyComputerError({
    message: (cause instanceof Error ? cause.message : String(cause)).trim() || "It didn't work.",
  });

/** The core as Effects. Exported for tests, which run it against a fake console. */
export function myComputerShape(
  core: MyComputerCore,
  trust: TrustStore = makeTrustStore({ stateDir: core.stateDir }),
): MyComputerShape {
  const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: toError });
  const judge = makeTrustJudge(async (computerId, cmd, signal) => {
    const result = await core.exec(
      {
        computerId,
        cmd,
        quiet: true,
        timeoutMs: RESOLVER_TIMEOUT_MS,
        maxOutputBytes: RESOLVER_OUTPUT_BYTES,
      },
      signal,
    );
    return result.exitCode === 0 && result.cutBytes === 0 ? result.text : null;
  });
  const trustState = attempt(() => trust.state(core.running()));
  return {
    core,
    status: attempt(() => core.status()),
    pair: attempt(() => core.pair()),
    pairStatus: (code) =>
      attempt(async () => {
        const answer = await core.pairStatus(code);
        // The person connected a computer: they mean agents to work there.
        if (answer.state === "claimed") {
          if ((await trust.paused()) !== null) await trust.resume();
          else await trust.touch();
        }
        return answer;
      }),
    disconnect: (computerId) =>
      attempt(async () => {
        await core.disconnect(computerId);
        trust.revokeComputer(computerId);
        judge.forget(computerId);
      }),
    activity: (computerId, limit) => attempt(() => core.activity(computerId, limit)),
    toolsVisible: attempt(() => core.toolsVisible()).pipe(Effect.orElseSucceed(() => false)),
    exec: (input) => attempt((signal) => core.exec(input, signal)),
    read: (input) => attempt((signal) => core.read(input, signal)),
    write: (input) => attempt((signal) => core.write(input, signal)),
    list: (input) => attempt((signal) => core.list(input, signal)),
    stat: (input) => attempt((signal) => core.stat(input, signal)),
    info: (computerId) => attempt((signal) => core.info(computerId, signal)),
    trust,
    judge,
    trustState,
    setTrust: (settings) =>
      attempt(async () => {
        await trust.setSettings(settings);
        return trust.state(core.running());
      }),
    revokeGrant: ({ threadId, computerId }) =>
      attempt(async () => {
        trust.revoke(threadId, computerId);
        return trust.state(core.running());
      }),
    stopAll: attempt(async () => {
      // Paused first: nothing new starts while the rest happens.
      await trust.pause("stopped");
      const stopped = core.abortAll();
      const status = await core.status().catch(() => null);
      const disconnected: Array<string> = [];
      const failed: Array<string> = [];
      const removed: Array<string> = [];
      for (const computer of status?.computers ?? []) {
        const name = computer.name || "Computer";
        try {
          await core.disconnect(computer.id);
          trust.revokeComputer(computer.id);
          judge.forget(computer.id);
          disconnected.push(name);
          removed.push(computer.id);
        } catch {
          failed.push(name);
        }
      }
      if (status === null) failed.push("the Uno console didn't answer");
      return { stopped, disconnected, failed, removed };
    }),
    resume: attempt(async () => {
      await trust.resume();
      return trust.state(core.running());
    }),
  };
}

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const config = yield* ServerConfig;

  const core = createMyComputerCore({
    token: () =>
      Effect.runPromise(
        serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.uno.boxToken?.trim() ?? ""),
          Effect.orElseSucceed(() => ""),
        ),
      ),
    boxId: () =>
      Effect.runPromise(
        serverSettings.getSettings.pipe(
          Effect.map((settings) => parseSettingsBoxId(settings.uno.boxId)),
          Effect.orElseSucceed(() => null),
        ),
      ),
    baseUrl: controlPlaneBaseUrl,
    stateDir: config.stateDir,
    warn: (message) => {
      Effect.runFork(Effect.logWarning(message));
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => core.closeAll()));
  return myComputerShape(core);
});

export const MyComputerServiceLive = Layer.effect(MyComputerService, make);
