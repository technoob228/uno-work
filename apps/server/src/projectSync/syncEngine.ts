/**
 * The sync engine the daemon wrote to `~/.uno/sdk/js/` (it runs next to the
 * git helper it starts): one place loads it, for the sync and for the check
 * before a project is published.
 *
 * @module projectSync/syncEngine
 */
import path from "node:path";
import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { installSdkFiles } from "../appSdk/sdkFiles.ts";
import type { SyncEngine } from "./projectSyncCore.ts";

export async function loadEngine(home: string): Promise<SyncEngine> {
  const file = path.join(home, ".uno", "sdk", "js", "uno-sync.mjs");
  if (!(await stat(file).catch(() => null))) await installSdkFiles(home);
  return (await import(pathToFileURL(file).href)) as SyncEngine;
}
