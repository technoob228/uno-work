/**
 * The daemon's http address for an environment — what an app's `proxyPath`
 * (Uno Work serving the computer's apps itself, `/_apps/<id>/<token>/`) is
 * resolved against. Null when the environment's address isn't known.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { getEnvironmentHttpBaseUrl } from "../../environments/runtime";

export function workBaseUrlFor(environmentId: EnvironmentId | null | undefined): string | null {
  return environmentId ? getEnvironmentHttpBaseUrl(environmentId) : null;
}
