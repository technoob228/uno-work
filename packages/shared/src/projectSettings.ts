/**
 * One project's settings on one computer: what the project overrides, else
 * what the computer says. Ported from T3 Code, without its t3.json layer.
 *
 * @module projectSettings
 */
import {
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  type ServerSettings,
} from "@t3tools/contracts";

export type ProjectSettingSource = "environment" | "project";

export type ProjectSettingSources = Readonly<
  Record<ProjectScopedServerSettingKey, ProjectSettingSource>
>;

export interface ResolvedProjectSettings {
  readonly settings: ServerSettings;
  readonly sources: ProjectSettingSources;
  readonly overrides: ProjectSettingsOverrides;
}

const EMPTY_OVERRIDES: ProjectSettingsOverrides = {};

const ENVIRONMENT_SOURCES: ProjectSettingSources = Object.fromEntries(
  PROJECT_SCOPED_SERVER_SETTING_KEYS.map((key) => [key, "environment"]),
) as Record<ProjectScopedServerSettingKey, ProjectSettingSource>;

export function hasProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
): boolean {
  return Object.values(settings.projectSettingsOverrides).some(
    (entry) => Object.keys(entry).length > 0,
  );
}

export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: string | null,
): ResolvedProjectSettings {
  const overrides =
    // Absent on settings from before this existed, and on partial stubs.
    (projectId === null ? undefined : settings.projectSettingsOverrides?.[projectId]) ??
    EMPTY_OVERRIDES;
  if (Object.keys(overrides).length === 0) {
    return { settings, sources: ENVIRONMENT_SOURCES, overrides: EMPTY_OVERRIDES };
  }
  const sources: Record<ProjectScopedServerSettingKey, ProjectSettingSource> = {
    ...ENVIRONMENT_SOURCES,
  };
  const effective: Record<string, unknown> = { ...settings };
  for (const key of PROJECT_SCOPED_SERVER_SETTING_KEYS) {
    const value = overrides[key];
    if (value === undefined) continue;
    effective[key] = value;
    sources[key] = "project";
  }
  return { settings: effective as ServerSettings, sources, overrides };
}

/** The project's entry without `keys`; null when nothing is left, which removes it. */
export function clearProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: string,
  keys: readonly ProjectScopedServerSettingKey[],
): ProjectSettingsOverrides | null {
  const current = settings.projectSettingsOverrides[projectId];
  if (current === undefined) return null;
  const next = { ...current };
  for (const key of keys) delete next[key];
  return Object.keys(next).length === 0 ? null : next;
}
