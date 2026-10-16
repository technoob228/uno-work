/**
 * Where the Uno harness (opencode) lives: `~/.unowork` — the desktop app
 * installs it into `<data home>/opencode` (apps/desktop unoCodeInstaller.ts)
 * — or `UNO_WORK_HARNESS_DIR`: "Uno Work Stage" (16.10) points its own daemon
 * at `~/.unowork-stage`, so the stage uses the binary it installed itself and
 * its own `opencode-home` (config, auth, sessions DB), never the release
 * app's on the same Mac.
 *
 * @module provider/unoHarnessDir
 */
import { homedir } from "node:os";
import * as nodePath from "node:path";

export const UNO_HARNESS_DIR_ENV = "UNO_WORK_HARNESS_DIR";

export interface UnoHarnessPaths {
  /** Legacy fork (technoob228/uno-code), installed by the desktop shell. */
  readonly forkPath: string;
  /** Stock opencode (npm `opencode-ai`), preferred when installed. */
  readonly upstreamPath: string;
  /** Its isolated home (`unoHarnessIsolation.ts`). */
  readonly upstreamHome: string;
}

export function resolveUnoHarnessRoot(
  home: string = homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env[UNO_HARNESS_DIR_ENV]?.trim();
  return override ? nodePath.resolve(override) : nodePath.join(home, ".unowork");
}

export function unoHarnessPaths(
  root: string,
  platform: NodeJS.Platform = process.platform,
): UnoHarnessPaths {
  const executable = (name: string) => (platform === "win32" ? `${name}.exe` : name);
  return {
    forkPath: nodePath.join(root, "uno-code", "bin", executable("uno-code")),
    upstreamPath: nodePath.join(root, "opencode", "bin", executable("opencode")),
    upstreamHome: nodePath.join(root, "opencode-home"),
  };
}
