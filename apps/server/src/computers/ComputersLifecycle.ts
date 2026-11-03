/**
 * ComputersLifecycle: the daemon's side of the computers lifecycle (contracts
 * computers.ts; reports/day_2026-11-02/computers-lifecycle/CONTRACT.md §2).
 *
 * This file holds the service tag, the flag and the purposes. The work on the
 * computer itself — finding projects and key names, bringing them over, a
 * folder on it as a project here, continuing a chat in the cloud — lives in
 * the live layer `myComputer/ComputersLifecycleLive.ts`.
 *
 * @module computers/ComputersLifecycle
 */
import {
  type ComputerPurpose,
  type ComputersBringWorkInput,
  type ComputersContinueInCloudInput,
  type ComputersContinueInCloudResult,
  type ComputersOpenFolderInput,
  type ComputersOpenFolderResult,
  type ComputersState,
  type ComputerWorkStatus,
  MyComputerError,
  type MyComputerStatus,
} from "@t3tools/contracts";
import { Context, Effect, Layer } from "effect";

import { ServerConfig } from "../config.ts";
import { MyComputerService } from "../myComputer/MyComputerService.ts";
import { lifecycleOverride, makePurposeStore, type PurposeStore } from "./purposeStore.ts";

export interface ComputersLifecycleShape {
  readonly state: Effect.Effect<ComputersState, MyComputerError>;
  readonly setPurpose: (
    computerId: string,
    purpose: ComputerPurpose,
  ) => Effect.Effect<ComputersState, MyComputerError>;
  /** For the tool routing: a computer nobody chose for is a tool. */
  readonly purposeOf: (computerId: string) => Effect.Effect<ComputerPurpose>;
  /** The computer was removed: its choice goes with it. */
  readonly forget: (computerId: string) => Effect.Effect<void>;
  readonly workStatus: (computerId: string) => Effect.Effect<ComputerWorkStatus, MyComputerError>;
  readonly workScan: (computerId: string) => Effect.Effect<ComputerWorkStatus, MyComputerError>;
  readonly bringWork: (
    input: ComputersBringWorkInput,
  ) => Effect.Effect<ComputerWorkStatus, MyComputerError>;
  readonly openFolder: (
    input: ComputersOpenFolderInput,
  ) => Effect.Effect<ComputersOpenFolderResult, MyComputerError>;
  readonly continueInCloud: (
    input: ComputersContinueInCloudInput,
  ) => Effect.Effect<ComputersContinueInCloudResult, MyComputerError>;
}

export class ComputersLifecycle extends Context.Service<
  ComputersLifecycle,
  ComputersLifecycleShape
>()("t3/computers/ComputersLifecycle") {}

/** On for this account: the env override, else the console's answer (off with the feature off). */
export function lifecycleOn(status: MyComputerStatus, override: boolean | null): boolean {
  if (override !== null) return override;
  return status.enabled && status.lifecycle === true;
}

/**
 * The parts every implementation shares: the flag and the purposes. A backend
 * live layer builds on this and fills in the rest.
 */
export function makeComputersLifecycleBase(input: {
  readonly store: PurposeStore;
  readonly status: Effect.Effect<MyComputerStatus, MyComputerError>;
  readonly override: boolean | null;
}): Pick<ComputersLifecycleShape, "state" | "setPurpose" | "purposeOf" | "forget"> {
  // A console that doesn't answer for a moment keeps the last known flag.
  let lastStatus: MyComputerStatus = { enabled: false, computers: [] };
  const status = input.status.pipe(
    Effect.tap((next) =>
      Effect.sync(() => {
        lastStatus = next;
      }),
    ),
    Effect.orElseSucceed(() => lastStatus),
  );
  const snapshot = (current: MyComputerStatus): ComputersState => ({
    lifecycle: lifecycleOn(current, input.override),
    purposes: input.store.list(),
  });
  return {
    state: Effect.map(status, snapshot),
    setPurpose: (computerId, purpose) =>
      Effect.gen(function* () {
        const current = yield* status;
        if (current.enabled && !current.computers.some((one) => one.id === computerId)) {
          return yield* new MyComputerError({ message: "This computer isn’t connected any more." });
        }
        yield* Effect.try({
          try: () => input.store.set(computerId, purpose),
          catch: () => new MyComputerError({ message: "Couldn’t save it. Try again." }),
        });
        return snapshot(current);
      }),
    purposeOf: (computerId) => Effect.sync(() => input.store.purposeOf(computerId)),
    forget: (computerId) =>
      Effect.sync(() => {
        try {
          input.store.forget(computerId);
        } catch {
          // The file stays as it was; a removed computer's choice is harmless.
        }
      }),
  };
}
