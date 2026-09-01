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
] as const satisfies readonly FeatureFlagDefinition[];

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[number]["key"];

const FLAG_DEFAULTS: Readonly<Record<FeatureFlagKey, boolean>> = Object.fromEntries(
  FEATURE_FLAGS.map((flag) => [flag.key, flag.default]),
) as Record<FeatureFlagKey, boolean>;

/**
 * Resolve a flag against the sparse stored overrides. Falls back to the
 * registry default when the user has made no explicit choice.
 */
export function resolveFeatureFlag(
  stored: Readonly<Record<string, boolean>> | undefined,
  key: FeatureFlagKey,
): boolean {
  return stored?.[key] ?? FLAG_DEFAULTS[key];
}
