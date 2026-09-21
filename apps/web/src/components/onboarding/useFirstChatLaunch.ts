import { useCallback, useState } from "react";

import { scopeProjectRef } from "@t3tools/client-runtime";
import type { ScopedProjectRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";
import { createEnvironmentApi } from "~/environmentApi";
import { getPrimaryEnvironmentConnection } from "~/environments/runtime";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useSettings } from "~/hooks/useSettings";
import { useServerProviders } from "~/rpc/serverState";
import { createStarterProject } from "~/starterProject";
import { selectProjectsAcrossEnvironments, useStore } from "~/store";
import { pickFirstChatProject } from "./firstChat";

export interface FirstChatLaunch {
  readonly pending: boolean;
  readonly error: string | null;
  /**
   * Ends onboarding in a draft chat on the connected machine. Reuses the first
   * real project when one exists, otherwise creates a starter project; with a
   * `prompt` the composer opens pre-filled so the first send is one keystroke.
   */
  readonly launch: (prompt: string | null) => Promise<void>;
}

export function useFirstChatLaunch(options: {
  /** Runs after the chat target exists, right before navigating away. */
  onBeforeNavigate: () => void;
}): FirstChatLaunch {
  const providers = useServerProviders();
  const { handleNewThread } = useNewThreadHandler();
  const configuredBaseDirectory = useSettings(
    (settings) => settings.addProjectBaseDirectory?.trim() ?? "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { onBeforeNavigate } = options;

  const launch = useCallback(
    async (prompt: string | null) => {
      if (pending) return;
      setPending(true);
      setError(null);
      try {
        // The onboarding route renders outside the chat layout, so the primary
        // connection may not be registered yet — ask the runtime to create it.
        const connection = getPrimaryEnvironmentConnection();
        await connection.ensureBootstrapped();
        const environmentId = connection.environmentId;

        const existingProject = pickFirstChatProject(
          selectProjectsAcrossEnvironments(useStore.getState()),
          environmentId,
        );
        let projectRef: ScopedProjectRef;
        if (existingProject) {
          projectRef = scopeProjectRef(existingProject.environmentId, existingProject.id);
        } else {
          projectRef = await createStarterProject({
            environmentId,
            providers,
            baseDirectory: configuredBaseDirectory,
            api: createEnvironmentApi(connection.client),
          });
        }

        onBeforeNavigate();
        await handleNewThread(projectRef);
        if (prompt !== null && prompt.trim().length > 0) {
          const draftStore = useComposerDraftStore.getState();
          const draft = draftStore.getDraftSessionByProjectRef(projectRef);
          if (draft) draftStore.setPrompt(draft.draftId, prompt);
        }
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not reach your computer. Give it a moment and try again.",
        );
      } finally {
        setPending(false);
      }
    },
    [configuredBaseDirectory, handleNewThread, onBeforeNavigate, pending, providers],
  );

  return { pending, error, launch };
}
