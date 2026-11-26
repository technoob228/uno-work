/**
 * "Hand to…" across computers (T63-C): the person's other computers a chat
 * can be handed to, and which connected computer a box is — so a chat
 * handled on another computer shows under its handler there.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { readEnvironmentSupportsHandToRemote } from "../environments/handToSupport";
import { usePrimaryEnvironmentDescriptor } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { handToComputers, type HandToComputer } from "../handTo.logic";
import { useMachineRows } from "./useMachineRows";

/** environmentId → the box its daemon says it runs on (null on a laptop). */
function useOwnBoxIds(): ReadonlyMap<string, number> {
  const primary = usePrimaryEnvironmentDescriptor();
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  return useMemo(() => {
    const out = new Map<string, number>();
    if (primary?.unoBoxId != null) out.set(primary.environmentId, primary.unoBoxId);
    for (const [environmentId, runtime] of Object.entries(runtimeById)) {
      const boxId = runtime.descriptor?.unoBoxId;
      if (boxId != null) out.set(environmentId, boxId);
    }
    return out;
  }, [primary, runtimeById]);
}

export function useHandToComputers(
  environmentId: EnvironmentId | null,
): ReadonlyArray<HandToComputer> {
  const rows = useMachineRows();
  const ownBoxIds = useOwnBoxIds();
  return useMemo(
    () =>
      environmentId === null
        ? []
        : handToComputers({
            rows,
            environmentId,
            supportsRemote: readEnvironmentSupportsHandToRemote,
            ownBoxIdOf: (id) => ownBoxIds.get(id) ?? null,
          }),
    [environmentId, ownBoxIds, rows],
  );
}

/** Box id → the connected computer (environment) it is. */
export function useEnvironmentIdByBoxId(): ReadonlyMap<number, EnvironmentId> {
  const rows = useMachineRows();
  const ownBoxIds = useOwnBoxIds();
  return useMemo(() => {
    const out = new Map<number, EnvironmentId>();
    for (const row of rows) {
      if (row.box !== null && row.environmentId !== null && !out.has(row.box.id)) {
        out.set(row.box.id, row.environmentId);
      }
    }
    for (const [environmentId, boxId] of ownBoxIds) {
      if (!out.has(boxId)) out.set(boxId, environmentId as EnvironmentId);
    }
    return out;
  }, [ownBoxIds, rows]);
}
