import { useCallback, useState } from "react";

import { scopeProjectRef } from "@t3tools/client-runtime";
import { DEFAULT_MODEL, ProviderInstanceId, type ScopedProjectRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";
import { createEnvironmentApi } from "~/environmentApi";
import { getPrimaryEnvironmentConnection } from "~/environments/runtime";
import { joinWorkspacePath, pickFirstProjectModelSelection } from "~/firstProject";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useSettings } from "~/hooks/useSettings";
import { pickUsableDefaultModelSelection } from "~/providerModels";
import { newCommandId, newProjectId } from "~/lib/utils";
import { useServerProviders } from "~/rpc/serverState";
import { selectProjectsAcrossEnvironments, useStore } from "~/store";
import {
  FIRST_CHAT_PROJECT_DIR,
  FIRST_CHAT_PROJECT_TITLE,
  pickFirstChatProject,
} from "./firstChat";

const DEFAULT_WORKSPACE_ROOT = "~/projects";

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
          const api = createEnvironmentApi(connection.client);
          // Same bar as a new chat (builtin-ai-default): only a harness that is
          // installed, signed in and serving models may own the starter
          // project, and Uno starts on its canonical default rather than the
          // pinned headline model. The looser picker is the last resort.
          const modelSelection =
            pickUsableDefaultModelSelection(providers) ??
            pickFirstProjectModelSelection(
              providers.map((provider) => ({
                instanceId: provider.instanceId,
                status: provider.status,
                models: provider.models.map((model) => ({ slug: model.slug })),
              })),
              { instanceId: "codex", model: DEFAULT_MODEL },
            );
          const baseDirectory =
            configuredBaseDirectory.length > 0 ? configuredBaseDirectory : DEFAULT_WORKSPACE_ROOT;
          const projectId = newProjectId();
          await api.orchestration.dispatchCommand({
            type: "project.create",
            commandId: newCommandId(),
            projectId,
            title: FIRST_CHAT_PROJECT_TITLE,
            workspaceRoot: joinWorkspacePath(baseDirectory, FIRST_CHAT_PROJECT_DIR),
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make(modelSelection.instanceId),
              model: modelSelection.model,
            },
            createdAt: new Date().toISOString(),
          });
          projectRef = scopeProjectRef(environmentId, projectId);
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
