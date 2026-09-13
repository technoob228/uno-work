/**
 * Feature flags / Labs registry.
 *
 * A single declarative table of the app's experimental / optional surfaces.
 * Each flag is device-level (app scope): its on/off choice rides in the
 * localStorage-backed {@link ClientSettings} `featureFlags` map, keyed by
 * `key`. Absent keys fall back to `default` here, so a fresh device gets the
 * declared defaults without any persisted state.
 *
 * Adding a flag is one array entry below — no schema change, because the
 * backing store is an open `Record<string, boolean>`.
 *
 * Kept free of React so gating code in non-component paths can import the
 * resolver. The React hook lives in `hooks/useFeatureFlags.ts`.
 *
 * @module featureFlags
 */

export interface FeatureFlagDefinition {
  /** Stable storage key. Never rename without a migration. */
  readonly key: string;
  /** Human label shown in the Labs settings panel. */
  readonly label: string;
  /** One-line explanation of what toggling the flag does. */
  readonly description: string;
  /** Value used when the user has not chosen. Defaults are ON so the
   * corresponding feature stays available out of the box. */
  readonly default: boolean;
}

export const FEATURE_FLAGS = [
  {
    key: "plugins",
    label: "Plugins",
    description:
      "The extensions / plugins system. Turn off to hide the Extensions settings and its nav entry.",
    default: true,
  },
  {
    key: "vault",
    label: "Credentials vault",
    description:
      "The credentials vault for storing secrets. Turn off to hide the Credentials settings and its nav entry.",
    default: true,
  },
  {
    key: "browserCompanion",
    label: "Browser companion",
    description:
      "Browser-mode / companion features. Turn off to hide the Browser settings and its nav entry.",
    default: true,
  },
  {
    key: "workspace",
    label: "Advanced sharing between machines",
    description:
      "The shared machine list — grants, claims, requests and instruction layers that let one machine act on another. Turn off to hide the “Advanced sharing” section under Settings → My machines. The machines list itself stays.",
    default: true,
  },
  {
    key: "allMachinesSidebar",
    label: "All machines in one sidebar (experimental)",
    description:
      "Lists chats from every machine in a single sidebar with a machine switcher at the bottom. This is our old workspace experiment, not an inbox. Off keeps the normal sidebar for the machine you are on.",
    default: false,
  },
  {
    key: "inboxSections",
    label: "Inbox sections in the sidebar",
    description:
      "Sorts each project's chats into Pinned, Active, Snoozed and Done, and lets you snooze a chat until later. Off keeps one flat list per project.",
    default: true,
  },
] as const satisfies readonly FeatureFlagDefinition[];

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[number]["key"];

const FLAG_DEFAULTS: Readonly<Record<FeatureFlagKey, boolean>> = Object.fromEntries(
  FEATURE_FLAGS.map((flag) => [flag.key, flag.default]),
) as Record<FeatureFlagKey, boolean>;

/**
 * Keys a flag was stored under before a rename. The persisted map is an open
 * record in localStorage, so a rename cannot rewrite old devices up front:
 * reads fall back to the legacy key and the next write moves the value.
 */
const LEGACY_FEATURE_FLAG_KEYS: Readonly<Partial<Record<FeatureFlagKey, string>>> = {
  // Was misleadingly called "sidebarInbox"; it never was an inbox.
  allMachinesSidebar: "sidebarInbox",
};

/**
 * Resolve a flag against the sparse stored overrides. Falls back to a legacy
 * key (see LEGACY_FEATURE_FLAG_KEYS), then to the registry default when the
 * user has made no explicit choice.
 */
export function resolveFeatureFlag(
  stored: Readonly<Record<string, boolean>> | undefined,
  key: FeatureFlagKey,
): boolean {
  const legacyKey = LEGACY_FEATURE_FLAG_KEYS[key];
  return (
    stored?.[key] ??
    (legacyKey !== undefined ? stored?.[legacyKey] : undefined) ??
    FLAG_DEFAULTS[key]
  );
}

/** Stored overrides with legacy keys moved to their current names. Current
    keys win over legacy ones; the legacy entry is dropped either way. */
export function migrateFeatureFlagOverrides(
  stored: Readonly<Record<string, boolean>> | undefined,
): Record<string, boolean> {
  const next: Record<string, boolean> = { ...stored };
  for (const [key, legacyKey] of Object.entries(LEGACY_FEATURE_FLAG_KEYS)) {
    if (legacyKey === undefined || !(legacyKey in next)) continue;
    if (next[key] === undefined) next[key] = next[legacyKey]!;
    delete next[legacyKey];
  }
  return next;
}

/** The stored override for a flag, looking through legacy keys. */
export function readStoredFeatureFlag(
  stored: Readonly<Record<string, boolean>> | undefined,
  key: FeatureFlagKey,
): boolean | undefined {
  return migrateFeatureFlagOverrides(stored)[key];
}
