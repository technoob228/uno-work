/**
 * Settings → AI "Default model" set for all computers lives in the app
 * (`newChatModelSelection`); each computer's server reads its own copy
 * (`defaultModelSelection`) for the assistant's work (13.11 v2). Until then
 * "all computers" cleared the computer's copy, so a choice made before this
 * version reached new chats but not the assistant. This copies it once to
 * each computer that answers and has none — the value the person already
 * chose, nothing new: for new chats it is the same choice either way.
 *
 * @module components/settings/useDefaultModelMirror
 */
import type { EnvironmentId, ModelSelection, ServerSettings } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import { updateEnvironmentSettings } from "../../environments/settings/serverSettings";
import { useSettings } from "../../hooks/useSettings";
import { useServerConfig } from "../../rpc/serverState";

export interface MirrorCandidate {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly settings: Pick<ServerSettings, "defaultModelSelection"> | null;
}

/** The computers that should get the app's choice: they answer and have none of their own. */
export function computersMissingDefaultModel(
  appChoice: ModelSelection | null,
  candidates: ReadonlyArray<MirrorCandidate>,
): ReadonlyArray<EnvironmentId> {
  if (appChoice === null) return [];
  return candidates
    .filter(
      (candidate) =>
        candidate.connected &&
        candidate.settings !== null &&
        candidate.settings.defaultModelSelection === null,
    )
    .map((candidate) => candidate.environmentId);
}

export function useDefaultModelMirror(): void {
  const appChoice = useSettings((settings) => settings.newChatModelSelection);
  const primaryId = usePrimaryEnvironmentId();
  const primarySettings = useServerConfig()?.settings ?? null;
  const saved = useSavedEnvironmentRuntimeStore((state) => state.byId);
  // Once per computer per session: a refused write isn't retried in a loop.
  const tried = useRef(new Set<string>());
  useEffect(() => {
    const candidates: MirrorCandidate[] = [
      ...(primaryId === null
        ? []
        : [{ environmentId: primaryId, connected: true, settings: primarySettings }]),
      ...Object.entries(saved).map(([environmentId, runtime]) => ({
        environmentId: environmentId as EnvironmentId,
        connected: runtime.connectionState === "connected",
        settings: runtime.serverConfig?.settings ?? null,
      })),
    ];
    for (const environmentId of computersMissingDefaultModel(appChoice, candidates)) {
      if (appChoice === null || tried.current.has(environmentId)) continue;
      tried.current.add(environmentId);
      void updateEnvironmentSettings(environmentId, { defaultModelSelection: appChoice }).catch(
        () => undefined,
      );
    }
  }, [appChoice, primaryId, primarySettings, saved]);
}
