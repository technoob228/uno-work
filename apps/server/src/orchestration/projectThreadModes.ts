/**
 * "Project default" runtime / interaction mode for a thread created on the
 * project's behalf by something other than the human in the composer
 * (plugin panels, chat connectors).
 *
 * A project has no runtime mode of its own — the mode lives on the thread.
 * So "inherited from the project" = the mode of the project's first active
 * thread; with no threads to inherit from, the narrowest mode wins
 * (`approval-required`), NOT the app-wide `DEFAULT_RUNTIME_MODE`
 * (`full-access`): nothing automated may widen its own permissions.
 */
import type { ProjectId, ProviderInteractionMode, RuntimeMode, ThreadId } from "@t3tools/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

/** Narrowest mode — the default when there is nothing to inherit from. */
export const FALLBACK_RUNTIME_MODE: RuntimeMode = "approval-required";

export interface InheritedThreadModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

const FALLBACK_MODES: InheritedThreadModes = {
  runtimeMode: FALLBACK_RUNTIME_MODE,
  interactionMode: "default",
};

export function inheritProjectThreadModes(
  projections: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadShellById" | "getFirstActiveThreadIdByProjectId"
  >,
  projectId: ProjectId,
): Effect.Effect<InheritedThreadModes, never> {
  return Effect.gen(function* () {
    const firstThreadId = yield* projections
      .getFirstActiveThreadIdByProjectId(projectId)
      .pipe(Effect.orElseSucceed(() => Option.none<ThreadId>()));
    if (Option.isNone(firstThreadId)) {
      return FALLBACK_MODES;
    }
    const shell = yield* projections
      .getThreadShellById(firstThreadId.value)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(shell)) {
      return FALLBACK_MODES;
    }
    return {
      runtimeMode: shell.value.runtimeMode,
      interactionMode: shell.value.interactionMode,
    };
  });
}

/**
 * Permission order of runtime modes, narrowest first. Anything automated
 * acting on a thread's behalf (the agent-threads bridge) may never run work
 * in a mode wider than the acting thread's own.
 */
const RUNTIME_MODE_RANK: Readonly<Record<RuntimeMode, number>> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  "full-access": 2,
};

/** `mode` grants more than `ceiling` (e.g. full-access vs approval-required). */
export function isRuntimeModeWider(mode: RuntimeMode, ceiling: RuntimeMode): boolean {
  return RUNTIME_MODE_RANK[mode] > RUNTIME_MODE_RANK[ceiling];
}

/** `mode`, narrowed to `ceiling` when it would grant more. */
export function capRuntimeMode(mode: RuntimeMode, ceiling: RuntimeMode): RuntimeMode {
  return isRuntimeModeWider(mode, ceiling) ? ceiling : mode;
}
