/**
 * "Hand to…" across computers (T63-C): the person's other computers a chat
 * can be handed to, and which connected computer a box is — so a chat
 * handled on another computer shows under its handler there.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { readEnvironmentSupportsHandToRemote } from "../environments/handToSupport";
import { handToComputers, type HandToComputer } from "../handTo.logic";
import { useMachineRows } from "./useMachineRows";

export function useHandToComputers(
  environmentId: EnvironmentId | null,
): ReadonlyArray<HandToComputer> {
  const rows = useMachineRows();
  return useMemo(
    () =>
      environmentId === null
        ? []
        : handToComputers({
            rows,
            environmentId,
            supportsRemote: readEnvironmentSupportsHandToRemote,
          }),
    [environmentId, rows],
  );
}

/** Box id → the connected computer (environment) it is. */
export function useEnvironmentIdByBoxId(): ReadonlyMap<number, EnvironmentId> {
  const rows = useMachineRows();
  return useMemo(() => {
    const out = new Map<number, EnvironmentId>();
    for (const row of rows) {
      if (row.box !== null && row.environmentId !== null && !out.has(row.box.id)) {
        out.set(row.box.id, row.environmentId);
      }
    }
    return out;
  }, [rows]);
}
