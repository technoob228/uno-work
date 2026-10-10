/**
 * Which owner HTTP routes a daemon serves ("one window": the interface can be
 * newer than the computer it talks to).
 *
 * A daemon lists its route families in `capabilities.httpFeatures`
 * (contracts HTTP_FEATURES). One that predates the list is judged by its
 * version against HTTP_FEATURE_SINCE. Callers hide the button and say
 * "Update this computer to …" when this says no; a 404 / index.html answer
 * from such a route is read the same way (environments/http/target.ts).
 */
import {
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  HTTP_FEATURE_ROUTES,
  HTTP_FEATURE_SINCE,
  type HttpFeature,
} from "@t3tools/contracts";

import { compareWorkVersions, normalizeWorkVersion } from "../workVersion";
import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentDescriptor } from "./primary";
import { useSavedEnvironmentRuntimeStore } from "./runtime";

type DescriptorLike = Pick<ExecutionEnvironmentDescriptor, "serverVersion" | "capabilities">;

/** Unknown descriptor (not connected yet) → false, like the other *Support checks. */
export function descriptorSupportsHttpFeature(
  descriptor: DescriptorLike | null | undefined,
  feature: HttpFeature,
): boolean {
  if (!descriptor) return false;
  const listed = descriptor.capabilities.httpFeatures;
  if (listed !== undefined) return listed.includes(feature);
  const since = HTTP_FEATURE_SINCE[feature];
  const version = normalizeWorkVersion(descriptor.serverVersion);
  if (!since || !version) return false;
  return compareWorkVersions(version, since) >= 0;
}

/** The feature a daemon route belongs to, or null for routes every daemon has. */
export function httpFeatureForPath(pathname: string): HttpFeature | null {
  for (const route of HTTP_FEATURE_ROUTES) {
    if (pathname === route.prefix || pathname.startsWith(route.prefix)) return route.feature;
  }
  return null;
}

export function readEnvironmentDescriptor(
  environmentId: EnvironmentId,
): ExecutionEnvironmentDescriptor | null {
  const primary = readPrimaryEnvironmentDescriptor();
  if (primary?.environmentId === environmentId) return primary;
  return useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.descriptor ?? null;
}

/** `supportsHttpFeature(env, name)`: one decision at call time (no subscription). */
export function supportsHttpFeature(environmentId: EnvironmentId, feature: HttpFeature): boolean {
  return descriptorSupportsHttpFeature(readEnvironmentDescriptor(environmentId), feature);
}

/**
 * True only when the daemon is known and known to lack the feature — the
 * request is not worth sending. Unknown (still connecting) lets it through.
 */
export function knownToLackHttpFeature(
  environmentId: EnvironmentId,
  feature: HttpFeature,
): boolean {
  const descriptor = readEnvironmentDescriptor(environmentId);
  return descriptor !== null && !descriptorSupportsHttpFeature(descriptor, feature);
}

export function useEnvironmentSupportsHttpFeature(
  environmentId: EnvironmentId | null | undefined,
  feature: HttpFeature,
): boolean {
  const primary = usePrimaryEnvironmentDescriptor();
  const saved = useSavedEnvironmentRuntimeStore((state) =>
    environmentId
      ? descriptorSupportsHttpFeature(state.byId[environmentId]?.descriptor, feature)
      : false,
  );
  if (!environmentId) return false;
  if (primary?.environmentId === environmentId) {
    return descriptorSupportsHttpFeature(primary, feature);
  }
  return saved;
}

/** The line shown instead of a feature the computer does not have yet. */
export function updateComputerToUseCopy(label: string | null, version: string | null): string {
  const who = label?.trim() ? label.trim() : "This computer";
  return version
    ? `${who} runs Uno Work ${version}. Update this computer to use this.`
    : `${who} runs an older Uno Work. Update this computer to use this.`;
}
