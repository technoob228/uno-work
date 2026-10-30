/** The daemon's one self-update controller (selfUpdate.ts), shared by the routes and the watcher. */
import packageJson from "../package.json" with { type: "json" };
import {
  makeSelfUpdateController,
  selfUpdatePathsFromEnv,
  type SelfUpdateController,
} from "./selfUpdate.ts";

let controller: SelfUpdateController | null = null;

export function selfUpdateController(): SelfUpdateController {
  controller ??= makeSelfUpdateController({
    paths: selfUpdatePathsFromEnv(),
    currentVersion: packageJson.version,
  });
  return controller;
}
