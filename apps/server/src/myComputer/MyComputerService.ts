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
} from "@t3tools/contracts";
import { Context, Effect, Layer } from "effect";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
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
}

export class MyComputerService extends Context.Service<MyComputerService, MyComputerShape>()(
  "t3/myComputer/MyComputerService",
) {}

const toError = (cause: unknown) =>
  new MyComputerError({
    message: (cause instanceof Error ? cause.message : String(cause)).trim() || "It didn't work.",
  });

/** The core as Effects. Exported for tests, which run it against a fake console. */
export function myComputerShape(core: MyComputerCore): MyComputerShape {
  const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: toError });
  return {
    core,
    status: attempt(() => core.status()),
    pair: attempt(() => core.pair()),
    pairStatus: (code) => attempt(() => core.pairStatus(code)),
    disconnect: (computerId) => attempt(() => core.disconnect(computerId)),
    activity: (computerId, limit) => attempt(() => core.activity(computerId, limit)),
    toolsVisible: attempt(() => core.toolsVisible()).pipe(Effect.orElseSucceed(() => false)),
    exec: (input) => attempt((signal) => core.exec(input, signal)),
    read: (input) => attempt((signal) => core.read(input, signal)),
    write: (input) => attempt((signal) => core.write(input, signal)),
    list: (input) => attempt((signal) => core.list(input, signal)),
    stat: (input) => attempt((signal) => core.stat(input, signal)),
    info: (computerId) => attempt((signal) => core.info(computerId, signal)),
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
