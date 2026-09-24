/**
 * `~/.uno/harnesses/<id>.json` — the file registry of custom (ACP) harnesses.
 *
 * A person or an agent on the machine writes one small JSON file and the
 * harness appears in the model picker as `harness-<id>` within a few
 * seconds (the folder is polled). Validation lives in
 * `@t3tools/shared/customHarness` (shared with the Settings dialog); this
 * module only reads the folder safely and turns each valid file into a
 * `ProviderInstanceConfig` envelope for the instance registry.
 *
 * Values of `secretEnv` names never come from the file: the person enters
 * them in Settings → Harnesses and they live in the daemon's secret store.
 *
 * @module provider/customHarness/harnessFiles
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CUSTOM_HARNESS_DRIVER_KIND,
  CUSTOM_HARNESS_FILE_INSTANCE_PREFIX,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  HARNESS_FILE_MAX_BYTES,
  HARNESS_FILE_MAX_COUNT,
  type ParsedHarnessFile,
  parseHarnessFile,
} from "@t3tools/shared/customHarness";

export const HARNESSES_DIR_ENV = "UNO_WORK_HARNESSES_DIR";

export function resolveHarnessesDir(home = os.homedir()): string {
  const override = process.env[HARNESSES_DIR_ENV]?.trim();
  return override && override.length > 0
    ? path.resolve(override)
    : path.join(home, ".uno", "harnesses");
}

/** `~/.uno/harnesses` for people; the absolute path when it is elsewhere. */
export function displayHarnessesDir(dir: string, home = os.homedir()): string {
  return dir.startsWith(`${home}/`) ? `~/${dir.slice(home.length + 1)}` : dir;
}

export function harnessFileInstanceId(fileId: string): ProviderInstanceId {
  return ProviderInstanceId.make(`${CUSTOM_HARNESS_FILE_INSTANCE_PREFIX}${fileId}`);
}

/** Secret-store key of a `secretEnv` value of a file harness. */
export function harnessFileSecretName(instanceId: string, name: string): string {
  return `custom-harness-env-${Buffer.from(instanceId, "utf8").toString("base64url")}-${Buffer.from(name, "utf8").toString("base64url")}`;
}

export interface LoadedHarnessFile extends ParsedHarnessFile {
  readonly instanceId: ProviderInstanceId;
  readonly filePath: string;
}

export interface HarnessFilesScan {
  readonly harnesses: ReadonlyArray<LoadedHarnessFile>;
  readonly invalid: ReadonlyArray<{ readonly file: string; readonly reason: string }>;
}

/** Read and validate every `*.json` in the folder. A missing folder is empty. */
export async function scanHarnessFiles(dir: string): Promise<HarnessFilesScan> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { harnesses: [], invalid: [] };
  }
  const harnesses: LoadedHarnessFile[] = [];
  const invalid: Array<{ file: string; reason: string }> = [];
  const jsonFiles = names.filter((name) => name.endsWith(".json")).toSorted();
  for (const name of jsonFiles.slice(0, HARNESS_FILE_MAX_COUNT)) {
    const filePath = path.join(dir, name);
    const fileId = name.slice(0, -".json".length);
    try {
      const stat = await lstat(filePath);
      if (!stat.isFile()) {
        invalid.push({ file: name, reason: "Not a regular file (symlinks are not followed)." });
        continue;
      }
      if (stat.size > HARNESS_FILE_MAX_BYTES) {
        invalid.push({ file: name, reason: "The file is larger than 32 KB." });
        continue;
      }
      const raw = await readFile(filePath, "utf8");
      const parsed = parseHarnessFile(fileId, raw);
      if (!parsed.ok) {
        invalid.push({ file: name, reason: parsed.reason });
        continue;
      }
      harnesses.push({ ...parsed.value, instanceId: harnessFileInstanceId(fileId), filePath });
    } catch (error) {
      invalid.push({
        file: name,
        reason: `Could not read: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  if (jsonFiles.length > HARNESS_FILE_MAX_COUNT) {
    invalid.push({
      file: `(${jsonFiles.length - HARNESS_FILE_MAX_COUNT} more)`,
      reason: `Only the first ${HARNESS_FILE_MAX_COUNT} harness files are read.`,
    });
  }
  return { harnesses, invalid };
}

/**
 * Registry envelope of a file harness. `secrets` holds the values from the
 * secret store (missing ones are passed as empty, and the Harnesses screen
 * shows "not set").
 */
export function harnessFileToInstanceConfig(
  harness: ParsedHarnessFile,
  secrets: ReadonlyMap<string, string>,
): ProviderInstanceConfig {
  return {
    driver: ProviderDriverKind.make(CUSTOM_HARNESS_DRIVER_KIND),
    displayName: harness.name,
    enabled: harness.config.enabled,
    environment: [
      ...harness.env.map((entry) => ({ name: entry.name, value: entry.value, sensitive: false })),
      ...harness.secretEnv.map((name) => ({
        name,
        value: secrets.get(name) ?? "",
        sensitive: true,
      })),
    ],
    config: harness.config,
  };
}
