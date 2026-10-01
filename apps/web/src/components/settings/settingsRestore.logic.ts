/**
 * "Restore defaults" on Settings → General resets this device's own
 * preferences — and nothing on any computer.
 *
 * Until 01.10 it sent the whole DEFAULT_UNIFIED_SETTINGS through
 * `updateSettings`, whose server half went to the daemon: `uno.apiKey: ""`,
 * `pins: []`, `setup: {}`, `providerInstances: {}`, `mcpServers: []`,
 * `machineOnboarded: false`… — one click wiped the computer's Uno key, the
 * sidebar pins and the setup progress. Now the patch is only the
 * device-level keys the page shows (plus the theme, kept by the caller).
 */
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";

export const DEVICE_RESTORE_SETTINGS = [
  { key: "timestampFormat", label: "Time format" },
  { key: "diffWordWrap", label: "Diff line wrapping" },
  { key: "diffIgnoreWhitespace", label: "Diff whitespace changes" },
  { key: "autoOpenPlanSidebar", label: "Auto-open task panel" },
  { key: "confirmThreadArchive", label: "Archive confirmation" },
  { key: "confirmThreadDelete", label: "Delete confirmation" },
] as const satisfies ReadonlyArray<{ key: keyof ClientSettings; label: string }>;

type DeviceRestoreKey = (typeof DEVICE_RESTORE_SETTINGS)[number]["key"];

/** The patch "Restore defaults" applies: device keys only, never a daemon's. */
export function deviceRestorePatch(): Pick<ClientSettings, DeviceRestoreKey> {
  const patch = {} as Record<DeviceRestoreKey, unknown>;
  for (const { key } of DEVICE_RESTORE_SETTINGS) patch[key] = DEFAULT_CLIENT_SETTINGS[key];
  return patch as Pick<ClientSettings, DeviceRestoreKey>;
}

/** What would change, in the words the page uses. */
export function changedDeviceSettingLabels(
  settings: Pick<ClientSettings, DeviceRestoreKey>,
  theme: string,
): string[] {
  return [
    ...(theme !== "system" ? ["Theme"] : []),
    ...DEVICE_RESTORE_SETTINGS.filter(
      ({ key }) => settings[key] !== DEFAULT_CLIENT_SETTINGS[key],
    ).map(({ label }) => label),
  ];
}
