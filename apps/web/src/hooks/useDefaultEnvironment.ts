/**
 * The user's default machine, as the app should use it right now.
 *
 * Wraps the pure rule in `defaultEnvironment.ts` with the live machine list
 * and the `defaultEnvironmentId` setting. Candidates are the machines this
 * client can actually reach: the daemon serving the page and every saved
 * connection — a box on the account that was never linked is not somewhere
 * the app can land.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import {
  resolveDefaultEnvironment,
  shouldOfferDefaultEnvironmentChoice,
  type DefaultEnvironmentCandidate,
} from "~/defaultEnvironment";

import { useMachineRows } from "./useMachineRows";
import { useSettings, useUpdateSettings } from "./useSettings";

export interface DefaultEnvironmentCandidateOption extends DefaultEnvironmentCandidate {
  readonly label: string;
}

export interface DefaultEnvironmentModel {
  /** The machine to reach for first, after the rule has been applied. */
  readonly defaultEnvironmentId: EnvironmentId | null;
  /** The user's explicit choice, valid or not. */
  readonly explicitDefaultId: EnvironmentId | null;
  readonly candidates: ReadonlyArray<DefaultEnvironmentCandidateOption>;
  /** True when there is a real choice to make and the user has not made it. */
  readonly shouldOfferChoice: boolean;
  readonly setDefaultEnvironment: (environmentId: EnvironmentId | null) => void;
}

export function useDefaultEnvironment(): DefaultEnvironmentModel {
  const rows = useMachineRows();
  const explicitDefaultId = useSettings((settings) => settings.defaultEnvironmentId);
  const { updateSettings } = useUpdateSettings();

  const candidates = useMemo<ReadonlyArray<DefaultEnvironmentCandidateOption>>(
    () =>
      rows.flatMap((row) =>
        row.environmentId !== null && (row.isPrimary || row.isSavedConnection)
          ? [
              {
                environmentId: row.environmentId,
                label: row.label,
                kind: row.kind,
                online: row.status === "online",
                isPrimary: row.isPrimary,
              },
            ]
          : [],
      ),
    [rows],
  );

  const defaultEnvironmentId = useMemo(
    () => resolveDefaultEnvironment({ explicitDefaultId, candidates }),
    [candidates, explicitDefaultId],
  );
  const shouldOfferChoice = useMemo(
    () => shouldOfferDefaultEnvironmentChoice({ explicitDefaultId, candidates }),
    [candidates, explicitDefaultId],
  );

  const setDefaultEnvironment = useCallback(
    (environmentId: EnvironmentId | null) => {
      updateSettings({ defaultEnvironmentId: environmentId });
    },
    [updateSettings],
  );

  return {
    defaultEnvironmentId,
    explicitDefaultId,
    candidates,
    shouldOfferChoice,
    setDefaultEnvironment,
  };
}
