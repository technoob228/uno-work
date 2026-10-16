/**
 * Which desktop app this is: the release "Uno Work" or "Uno Work Stage"
 * (16.10, Misha's stage: a second app on the same Mac, next to the release
 * one, that must never touch the release one's data).
 *
 * The flavor is baked into the packaged app's package.json
 * (`"unoWorkFlavor": "stage"`, written by `scripts/build-desktop-artifact.ts
 * --flavor stage`); `UNO_WORK_DESKTOP_FLAVOR=stage` sets it for a dev run.
 * Not the version: a real nightly must stay a release-flavored app, and the
 * stage keeps its plain `0.0.139` (the same as its daemon and web bundle).
 *
 * Everything that differs between the two is decided here, pure, so the
 * paths are unit-tested:
 *   - data home `~/.unowork-stage` (database, settings, sign-in, logs,
 *     opencode) instead of `~/.unowork`;
 *   - Chromium profile `<appData>/unowork-stage`, never the legacy
 *     `T3 Code (Alpha)` folder the release app may still adopt;
 *   - app ids / window class;
 *   - its own daemon reads its own apps folder and assistants folder, not
 *     the person's `~/.uno/apps` (a second supervisor would start their apps
 *     twice) and `~/UnoWork/Assistants`;
 *   - no auto-update (a stage build must never pull the release feed).
 *
 * @module desktopFlavor
 */
import * as Path from "node:path";

export type DesktopFlavor = "release" | "stage";

export const DESKTOP_FLAVOR_ENV = "UNO_WORK_DESKTOP_FLAVOR";
export const DESKTOP_FLAVOR_PACKAGE_FIELD = "unoWorkFlavor";

/** The daemon reads these (server: machineApps/manifestDir.ts, assistants/assistantsDir.ts, UnoDriver.ts). */
export const BACKEND_APPS_DIR_ENV = "UNO_WORK_APPS_DIR";
export const BACKEND_ASSISTANTS_DIR_ENV = "UNO_WORK_ASSISTANTS_DIR";
export const BACKEND_HARNESS_DIR_ENV = "UNO_WORK_HARNESS_DIR";
/** The daemon reports it as `environment.channel` (server: environment/updateChannel.ts). */
export const BACKEND_CHANNEL_ENV = "UNO_WORK_CHANNEL";
export const STAGE_CHANNEL = "stage";

export function parseDesktopFlavor(value: unknown): DesktopFlavor | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "stage") return "stage";
  if (normalized === "release" || normalized === "default") return "release";
  return null;
}

/** The flavor from the packaged app's package.json text; null when absent or unreadable. */
export function readDesktopFlavorFromPackageJson(
  raw: string | null | undefined,
): DesktopFlavor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    return parseDesktopFlavor(parsed?.[DESKTOP_FLAVOR_PACKAGE_FIELD]);
  } catch {
    return null;
  }
}

/**
 * A stage build is always the stage; `UNO_WORK_DESKTOP_FLAVOR=stage` makes any
 * run the stage (dev runs, tests). Nothing turns a stage build back into the
 * release one: that would open the release app's data.
 */
export function resolveDesktopFlavor(input: {
  readonly envValue: string | undefined;
  readonly packageJsonRaw: string | null | undefined;
}): DesktopFlavor {
  if (readDesktopFlavorFromPackageJson(input.packageJsonRaw) === "stage") return "stage";
  return parseDesktopFlavor(input.envValue) === "stage" ? "stage" : "release";
}

export interface DesktopIdentity {
  /** Data home: `userdata/` (database, settings, sign-in, logs), opencode. */
  readonly baseDir: string;
  /** Chromium profile folder name under the OS app-data folder. */
  readonly userDataDirName: string;
  /** A legacy profile the app keeps using when it exists; never for the stage. */
  readonly legacyUserDataDirName: string | null;
  readonly appUserModelId: string;
  readonly linuxDesktopEntryName: string;
  readonly linuxWmClass: string;
}

export function resolveDesktopIdentity(input: {
  readonly flavor: DesktopFlavor;
  readonly isDevelopment: boolean;
  readonly homeDir: string;
  /** `T3CODE_HOME`: an explicit data home always wins (dev runner, tests). */
  readonly t3codeHome: string | undefined;
}): DesktopIdentity {
  const stage = input.flavor === "stage";
  const dev = input.isDevelopment;
  const name = `unowork${stage ? "-stage" : ""}${dev ? "-dev" : ""}`;
  const explicitHome = input.t3codeHome?.trim();
  return {
    baseDir: explicitHome || Path.join(input.homeDir, stage ? ".unowork-stage" : ".unowork"),
    userDataDirName: name,
    legacyUserDataDirName: stage ? null : dev ? "T3 Code (Dev)" : "T3 Code (Alpha)",
    appUserModelId: `xyz.getuno.work${stage ? ".stage" : ""}${dev ? ".dev" : ""}`,
    linuxDesktopEntryName: `${name}.desktop`,
    linuxWmClass: name,
  };
}

/**
 * The Chromium profile path. Electron's default comes from `productName`
 * (spaces, parentheses), so it is set explicitly; the release app keeps a
 * legacy profile when one exists (people's sessions), the stage never does.
 */
export function resolveUserDataPath(input: {
  readonly appDataBase: string;
  readonly identity: DesktopIdentity;
  readonly exists: (path: string) => boolean;
}): string {
  const legacy = input.identity.legacyUserDataDirName;
  if (legacy) {
    const legacyPath = Path.join(input.appDataBase, legacy);
    if (input.exists(legacyPath)) return legacyPath;
  }
  return Path.join(input.appDataBase, input.identity.userDataDirName);
}

/**
 * What the local daemon gets on top of the app's own environment. The
 * release app: nothing (behaviour unchanged). The stage: its own apps,
 * assistants and harness folders under its data home, and the channel name —
 * each only when not set already (a person or a test may point them
 * elsewhere on purpose).
 */
export function resolveFlavorBackendEnv(input: {
  readonly flavor: DesktopFlavor;
  readonly baseDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Record<string, string> {
  if (input.flavor !== "stage") return {};
  const wanted: Record<string, string> = {
    [BACKEND_APPS_DIR_ENV]: Path.join(input.baseDir, "uno-apps"),
    [BACKEND_ASSISTANTS_DIR_ENV]: Path.join(input.baseDir, "Assistants"),
    [BACKEND_HARNESS_DIR_ENV]: input.baseDir,
    [BACKEND_CHANNEL_ENV]: STAGE_CHANNEL,
  };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(wanted)) {
    if (!input.env[key]?.trim()) out[key] = value;
  }
  return out;
}

/** The stage never updates itself: a new stage build is installed by hand. */
export function isAutoUpdateAllowedForFlavor(flavor: DesktopFlavor): boolean {
  return flavor !== "stage";
}
