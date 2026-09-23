/**
 * How the person wants to use Uno, picked on the first onboarding screen.
 * Remembered in this browser (not on the machine) so later UI can lean on it —
 * e.g. put "Connect your agent" or the SSH address first. Nothing is locked by
 * it: every computer can be opened in Uno Work, over SSH or by an agent.
 */
export type OnboardingPath = "work" | "agent" | "ssh";

export const ONBOARDING_PATH_STORAGE_KEY = "uno_onboarding_path";

export function parseOnboardingPath(value: unknown): OnboardingPath | null {
  return value === "work" || value === "agent" || value === "ssh" ? value : null;
}

export function readOnboardingPath(): OnboardingPath | null {
  try {
    return parseOnboardingPath(globalThis.localStorage?.getItem(ONBOARDING_PATH_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeOnboardingPath(path: OnboardingPath): void {
  try {
    globalThis.localStorage?.setItem(ONBOARDING_PATH_STORAGE_KEY, path);
  } catch {
    // Private mode / storage disabled: the choice just isn't remembered.
  }
}

/** "this Mac" / "this PC" / "this computer" — how the desktop copy names the device. */
export function thisDeviceWords(
  platform: string = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  if (/mac|iphone|ipad|ipod/i.test(platform)) return "this Mac";
  if (/^win(dows)?/i.test(platform)) return "this PC";
  return "this computer";
}
