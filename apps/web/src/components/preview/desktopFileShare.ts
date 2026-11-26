/**
 * "Share with a link…" for a file on this Mac, desktop app (w0139): the
 * desktop app uploads the copy itself (`desktopBridge.unoDrive`, its own Uno
 * sign-in — apps/desktop driveShareFile.ts), so it works without an account
 * key in the local daemon's settings. Elsewhere (a cloud computer, the web,
 * a desktop app before 0.0.139) the daemon makes the copy as before
 * (`files.cloudCopyToCloud`).
 */
import type { DesktopBridge, EnvironmentId } from "@t3tools/contracts";

import { isElectron } from "../../env";
import { isPrimaryEnvironmentId } from "../../environments/http/target";

export type CloudCopyMaker = "desktop" | "daemon";

/** Who uploads the copy of a file: pure, for tests. */
export function cloudCopyMaker(input: {
  readonly isElectron: boolean;
  /** The file is on the computer this app runs on (the desktop's own daemon). */
  readonly onThisComputer: boolean;
  readonly bridgeHasDrive: boolean;
}): CloudCopyMaker {
  return input.isElectron && input.onThisComputer && input.bridgeHasDrive ? "desktop" : "daemon";
}

type ShareLocalFile = NonNullable<DesktopBridge["unoDrive"]>["shareLocalFile"];

/** A password link, but the desktop app is too old to pass the password on (pure, for tests). */
export function desktopWouldDropPassword(
  password: string | undefined,
  bridge: { readonly sharePassword?: boolean },
): boolean {
  return Boolean(password) && bridge.sharePassword !== true;
}

/** The desktop app's uploader for a file on this computer, or null (the daemon does it). */
export function desktopShareLocalFile(environmentId: EnvironmentId | null): ShareLocalFile | null {
  const drive = typeof window === "undefined" ? undefined : window.desktopBridge?.unoDrive;
  const maker = cloudCopyMaker({
    isElectron,
    onThisComputer: environmentId !== null && isPrimaryEnvironmentId(environmentId),
    bridgeHasDrive: typeof drive?.shareLocalFile === "function",
  });
  if (maker !== "desktop" || !drive) return null;
  return async (input) =>
    // An app before 0.0.195 would drop the password and make an open link.
    desktopWouldDropPassword(input.password, drive)
      ? { ok: false, error: "Update Uno Work to share Cloud storage links with a password." }
      : drive.shareLocalFile(input);
}
