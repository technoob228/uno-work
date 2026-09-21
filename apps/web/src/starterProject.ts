/**
 * The "Home" project a machine gets when a chat is started on it and it has no
 * project yet. Used by the onboarding's first chat and by "New chat" on a
 * machine that was just connected — a chat needs a project, and asking a
 * person to pick a folder on a brand-new computer is exactly the step Uno Work
 * promises to skip.
 *
 * @module starterProject
 */
import { scopeProjectRef } from "@t3tools/client-runtime";
import {
  DEFAULT_MODEL,
  ProviderInstanceId,
  type EnvironmentApi,
  type EnvironmentId,
  type ScopedProjectRef,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  FIRST_CHAT_PROJECT_DIR,
  FIRST_CHAT_PROJECT_TITLE,
} from "./components/onboarding/firstChat";
import { ensureEnvironmentApi } from "./environmentApi";
import { joinWorkspacePath, pickFirstProjectModelSelection } from "./firstProject";
import { newCommandId, newProjectId } from "./lib/utils";
import { pickUsableDefaultModelSelection } from "./providerModels";

export const DEFAULT_STARTER_WORKSPACE_ROOT = "~/projects";

export async function createStarterProject(input: {
  readonly environmentId: EnvironmentId;
  /** Providers of *that* machine — its harnesses decide the default model. */
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly baseDirectory?: string | null;
  /** For callers that hold a connection not yet registered with the runtime (onboarding). */
  readonly api?: EnvironmentApi;
}): Promise<ScopedProjectRef> {
  const api = input.api ?? ensureEnvironmentApi(input.environmentId);
  // Same bar as a new chat (builtin-ai-default): only a harness that is
  // installed, signed in and serving models may own the starter project; the
  // looser picker is the last resort.
  const modelSelection =
    pickUsableDefaultModelSelection(input.providers) ??
    pickFirstProjectModelSelection(
      input.providers.map((provider) => ({
        instanceId: provider.instanceId,
        status: provider.status,
        models: provider.models.map((model) => ({ slug: model.slug })),
      })),
      { instanceId: "codex", model: DEFAULT_MODEL },
    );
  const baseDirectory = input.baseDirectory?.trim() || DEFAULT_STARTER_WORKSPACE_ROOT;
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
  return scopeProjectRef(input.environmentId, projectId);
}
