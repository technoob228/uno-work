import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import { usePrimaryEnvironmentDescriptor } from "./primary";
import { useSavedEnvironmentRuntimeStore } from "./runtime";

/**
 * Whether the daemon behind `environmentId` marks THE assistant chat
 * (`assistantRole`). Older daemons do not advertise `assistantChat`; for them
 * the client picks the chat itself (see `resolveAssistantChat`).
 */
export function descriptorSupportsAssistantChat(
  descriptor: ExecutionEnvironmentDescriptor | null | undefined,
): boolean {
  return descriptor?.capabilities.assistantChat === true;
}

export function useEnvironmentSupportsAssistantChat(
  environmentId: EnvironmentId | null | undefined,
): boolean {
  const primary = usePrimaryEnvironmentDescriptor();
  const saved = useSavedEnvironmentRuntimeStore((state) =>
    environmentId ? descriptorSupportsAssistantChat(state.byId[environmentId]?.descriptor) : false,
  );
  if (!environmentId) return false;
  if (primary?.environmentId === environmentId) return descriptorSupportsAssistantChat(primary);
  return saved;
}
