import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import { usePrimaryEnvironmentDescriptor } from "./primary";
import { useSavedEnvironmentRuntimeStore } from "./runtime";

/**
 * Whether the daemon behind `environmentId` reads the person's Claude and
 * ChatGPT plan limits (`uno.computer.planLimits`, 0.0.157). Older daemons
 * don't advertise `planLimits`: Home doesn't offer the widget for them.
 */
export function descriptorSupportsPlanLimits(
  descriptor: ExecutionEnvironmentDescriptor | null | undefined,
): boolean {
  return descriptor?.capabilities.planLimits === true;
}

export function useEnvironmentSupportsPlanLimits(
  environmentId: EnvironmentId | null | undefined,
): boolean {
  const primary = usePrimaryEnvironmentDescriptor();
  const saved = useSavedEnvironmentRuntimeStore((state) =>
    environmentId ? descriptorSupportsPlanLimits(state.byId[environmentId]?.descriptor) : false,
  );
  if (!environmentId) return false;
  if (primary?.environmentId === environmentId) return descriptorSupportsPlanLimits(primary);
  return saved;
}
