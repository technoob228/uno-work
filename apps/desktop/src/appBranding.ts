import type { DesktopAppBranding, DesktopAppStageLabel } from "@t3tools/contracts";

import type { DesktopFlavor } from "./desktopFlavor.ts";
import { isNightlyDesktopVersion } from "./updateChannels.ts";

const APP_BASE_NAME = "Uno Work";

export function resolveDesktopAppStageLabel(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
  /** "stage" → "Stage" even in dev: the web reads it as the stage channel (unoChannel.ts). */
  readonly flavor?: DesktopFlavor;
}): DesktopAppStageLabel {
  if (input.flavor === "stage") {
    return "Stage";
  }
  if (input.isDevelopment) {
    return "Dev";
  }

  return isNightlyDesktopVersion(input.appVersion) ? "Nightly" : "Alpha";
}

export function resolveDesktopAppBranding(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
  readonly flavor?: DesktopFlavor;
}): DesktopAppBranding {
  const stageLabel = resolveDesktopAppStageLabel(input);
  return {
    baseName: APP_BASE_NAME,
    stageLabel,
    displayName: `${APP_BASE_NAME} (${stageLabel})`,
  };
}
