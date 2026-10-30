/**
 * What a new chat starts with on one computer, in one project: the project's
 * own value, else the computer's. Read from the chat's computer, not from the
 * one serving this window.
 *
 * @module newChatDefaults
 */
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type RuntimeMode,
  type ServerSettings,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { readEnvironmentServerConfig } from "./environments/settings/serverSettings";

export interface NewChatDefaults {
  readonly runtimeMode: RuntimeMode;
  readonly envMode: ThreadEnvMode;
  /** The project's own model. The computer's and the app's are read with the start model. */
  readonly projectModel: ModelSelection | null;
}

export function newChatDefaultsFrom(
  settings: ServerSettings,
  projectId: string | null,
): NewChatDefaults {
  const resolved = resolveProjectSettings(settings, projectId);
  return {
    runtimeMode: resolved.settings.defaultRuntimeMode,
    envMode: resolved.settings.defaultThreadEnvMode,
    projectModel: resolved.overrides.defaultModelSelection ?? null,
  };
}

export function readNewChatDefaults(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string | null;
}): NewChatDefaults {
  const settings = readEnvironmentServerConfig(input.environmentId)?.settings;
  return newChatDefaultsFrom(settings ?? DEFAULT_SERVER_SETTINGS, input.projectId);
}

export function newChatEnvMode(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
}): ThreadEnvMode {
  return readNewChatDefaults(input).envMode;
}
