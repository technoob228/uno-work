import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface ServerEnvironmentShape {
  readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
  readonly getDescriptor: Effect.Effect<ExecutionEnvironmentDescriptor>;
  /**
   * Clone identity rotation (memory-snapshot clones, see cloneIdentity.ts): a
   * new environment id, persisted, without a daemon restart. Optional so
   * test doubles need not implement it.
   */
  readonly rotateEnvironmentId?: Effect.Effect<void>;
}

export class ServerEnvironment extends Context.Service<ServerEnvironment, ServerEnvironmentShape>()(
  "t3/environment/Services/ServerEnvironment",
) {}
