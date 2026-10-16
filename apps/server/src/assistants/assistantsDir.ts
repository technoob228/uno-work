/**
 * Where assistant folders live: `~/UnoWork/Assistants` — a place the person
 * can see and open — or `UNO_WORK_ASSISTANTS_DIR` when the daemon is told
 * otherwise: the "Uno Work Stage" desktop app (16.10) points its own daemon
 * at `~/.unowork-stage/Assistants`, so its Uno never lands in (or adopts) the
 * release app's assistants on the same Mac. Tests and stands use it too.
 *
 * @module assistants/assistantsDir
 */
import os from "node:os";
import path from "node:path";

export const ASSISTANTS_DIR_ENV = "UNO_WORK_ASSISTANTS_DIR";

/** `~/UnoWork/Assistants` under a home folder. */
export function defaultAssistantsDir(home: string): string {
  return path.join(home, "UnoWork", "Assistants");
}

/** The override when set (absolute), else null. */
export function assistantsDirOverride(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const override = env[ASSISTANTS_DIR_ENV]?.trim();
  return override ? path.resolve(override) : null;
}

export function resolveAssistantsDir(
  home: string = os.homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return assistantsDirOverride(env) ?? defaultAssistantsDir(home);
}
