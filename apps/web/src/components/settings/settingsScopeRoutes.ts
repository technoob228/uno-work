/**
 * The settings URL space, as data.
 *
 * Settings answer to two different owners: this installation of the app on
 * this device, and one execution environment's daemon. Which one a page edits
 * used to be implicit — it followed whatever environment happened to be
 * active. Here it is part of the path instead, so a reload, a bookmark and
 * back/forward all keep editing the same owner:
 *
 *   /settings/app/general
 *   /settings/environment/$environmentId/providers
 *
 * Kept free of React so the nav, the redirects and the tests all read the
 * same table.
 *
 * @module components/settings/settingsScopeRoutes
 */
import type { EnvironmentId } from "@t3tools/contracts";

export type SettingsScopeKind = "app" | "environment";

export type AppSettingsSection = "general" | "connections" | "browser";
export type EnvironmentSettingsSection =
  | "general"
  | "providers"
  | "assistants"
  | "source-control"
  | "archived";

export const APP_SETTINGS_SECTIONS: ReadonlyArray<AppSettingsSection> = [
  "general",
  "connections",
  "browser",
];

export const ENVIRONMENT_SETTINGS_SECTIONS: ReadonlyArray<EnvironmentSettingsSection> = [
  "general",
  "providers",
  "assistants",
  "source-control",
  "archived",
];

export function appSettingsPath(section: AppSettingsSection): string {
  return `/settings/app/${section}`;
}

export function environmentSettingsPath(
  environmentId: EnvironmentId,
  section: EnvironmentSettingsSection,
): string {
  return `/settings/environment/${encodeURIComponent(environmentId)}/${section}`;
}

export interface SettingsScopeLocation {
  readonly kind: SettingsScopeKind;
  readonly environmentId: EnvironmentId | null;
  readonly section: string | null;
}

/**
 * Read the scope out of a pathname. Anything that is not a scoped settings
 * path resolves to the app scope, which is the one that owns no daemon and so
 * cannot write to the wrong machine.
 */
export function parseSettingsScopeLocation(pathname: string): SettingsScopeLocation {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments[0] !== "settings") {
    return { kind: "app", environmentId: null, section: null };
  }

  if (segments[1] === "environment") {
    const environmentId = segments[2] ? (decodeURIComponent(segments[2]) as EnvironmentId) : null;
    return { kind: "environment", environmentId, section: segments[3] ?? null };
  }

  return { kind: "app", environmentId: null, section: segments[2] ?? null };
}

/**
 * Where a section on one scope maps to when the user switches scope. Sections
 * that only exist on one side fall back to that side's landing page rather
 * than pretending the other scope has them.
 */
export function correspondingSectionForScope(
  section: string | null,
  target: SettingsScopeKind,
): string {
  if (target === "app") {
    return (APP_SETTINGS_SECTIONS as ReadonlyArray<string>).includes(section ?? "")
      ? (section as string)
      : "general";
  }
  return (ENVIRONMENT_SETTINGS_SECTIONS as ReadonlyArray<string>).includes(section ?? "")
    ? (section as string)
    : "general";
}
