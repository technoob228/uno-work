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

export type AppSettingsSection = "general" | "connections" | "phone" | "browser" | "labs";
export type EnvironmentSettingsSection =
  | "general"
  | "providers"
  | "harnesses"
  | "assistants"
  | "apps"
  | "source-control"
  | "archived";

export const APP_SETTINGS_SECTIONS: ReadonlyArray<AppSettingsSection> = [
  "general",
  "connections",
  "phone",
  "browser",
  "labs",
];

export const ENVIRONMENT_SETTINGS_SECTIONS: ReadonlyArray<EnvironmentSettingsSection> = [
  "general",
  "providers",
  "harnesses",
  "assistants",
  "apps",
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

/** Does `section` exist on the given scope at all? */
export function sectionExistsInScope(section: string | null, kind: SettingsScopeKind): boolean {
  if (section === null) return false;
  const table: ReadonlyArray<string> =
    kind === "app" ? APP_SETTINGS_SECTIONS : ENVIRONMENT_SETTINGS_SECTIONS;
  return table.includes(section);
}

/** Where the user wants their settings to apply: this app, or one machine. */
export type SettingsScopeTarget =
  | { readonly kind: "app" }
  | { readonly kind: "environment"; readonly environmentId: EnvironmentId };

export interface SettingsScopeSwitchResult {
  /** The path to navigate to. */
  readonly to: string;
  /** The current section had a counterpart on the target scope and was kept. */
  readonly keptSection: boolean;
  /**
   * The target names a machine this app does not know. The switch still
   * navigates — the page then says so — instead of silently picking another
   * machine.
   */
  readonly unknownMachine: boolean;
}

/**
 * The one line shown when a scope switch could not keep the section, so the
 * user learns why they landed on a different page instead of assuming the
 * setting they were looking at exists everywhere.
 */
export const SETTINGS_SCOPE_SWITCH_HINT =
  "General and Theme apply to this app on every machine. Agents, Uno account, Telegram and Instructions live on each machine.";

/**
 * Resolve where switching scope from `section` lands. Pure: the caller
 * supplies the machines it knows so the result can say when the target is
 * not among them.
 */
export function resolveSettingsScopeSwitch(input: {
  readonly section: string | null;
  readonly target: SettingsScopeTarget;
  readonly knownEnvironmentIds: ReadonlyArray<EnvironmentId>;
}): SettingsScopeSwitchResult {
  const { section, target } = input;
  const keptSection = sectionExistsInScope(section, target.kind);
  if (target.kind === "app") {
    return {
      to: appSettingsPath(correspondingSectionForScope(section, "app") as AppSettingsSection),
      keptSection,
      unknownMachine: false,
    };
  }
  return {
    to: environmentSettingsPath(
      target.environmentId,
      correspondingSectionForScope(section, "environment") as EnvironmentSettingsSection,
    ),
    keptSection,
    unknownMachine: !input.knownEnvironmentIds.includes(target.environmentId),
  };
}

/**
 * Where "open Settings" lands. A remembered machine wins over the app scope so
 * a person who was configuring a box and comes back keeps configuring that
 * box — but only while the app still knows the machine.
 */
export function settingsLandingPath(input: {
  readonly memory: {
    readonly machineEnvironmentId: string | null;
    readonly lastKind: SettingsScopeKind;
  };
  readonly knownEnvironmentIds: ReadonlyArray<EnvironmentId>;
}): string {
  const remembered = input.memory.machineEnvironmentId as EnvironmentId | null;
  if (
    input.memory.lastKind === "environment" &&
    remembered !== null &&
    input.knownEnvironmentIds.includes(remembered)
  ) {
    return environmentSettingsPath(remembered, "general");
  }
  return appSettingsPath("general");
}
